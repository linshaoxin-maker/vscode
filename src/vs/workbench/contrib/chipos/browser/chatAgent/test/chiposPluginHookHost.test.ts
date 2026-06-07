/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChiposPluginHookHost, HookDecision, HookEvalRequest } from '../chiposPluginHookHost.js';

/**
 * Unit tests for {@link ChiposPluginHookHost} using an INJECTED fake `fork` — no
 * real node child is ever spawned. The fake child records what the host sends /
 * kills and can auto-reply over its `message` event, so we can drive every
 * fail-closed and decision-mapping path deterministically.
 */
suite('ChiposPluginHookHost', () => {

	/** A reply the fake child will post back, or undefined to stay silent (drives timeout/exit paths). */
	type ReplyHandler = (msg: ISentMessage) => Record<string, unknown> | undefined;

	/** The shape the host sends over IPC (cf. chiposPluginHookHost.ts evaluate()). */
	interface ISentMessage {
		readonly evalId: string;
		readonly modulePath: string;
		readonly exportName: string;
		readonly ctx: { [key: string]: unknown };
	}

	/** Minimal EventEmitter-ish stand-in for a forked node child. */
	class FakeChild {
		readonly sent: ISentMessage[] = [];
		killCount = 0;
		private readonly _listeners = new Map<string, Array<(arg: unknown) => void>>();

		constructor(private readonly _reply: ReplyHandler) { }

		send(msg: unknown): void {
			// Snapshot what crossed the boundary so a later mutation of any live ref
			// cannot retroactively change what we assert was sent.
			const snapshot = structuredClone(msg) as ISentMessage;
			this.sent.push(snapshot);
			const reply = this._reply(snapshot);
			if (reply !== undefined) {
				// Model async IPC: deliver on a microtask, after evaluate() has
				// registered the pending eval.
				queueMicrotask(() => this.emit('message', reply));
			}
		}

		kill(): void {
			this.killCount++;
		}

		on(event: string, listener: (arg: unknown) => void): void {
			const list = this._listeners.get(event) ?? [];
			list.push(listener);
			this._listeners.set(event, list);
		}

		once(event: string, listener: (arg: unknown) => void): void {
			const wrapper = (arg: unknown): void => {
				this.off(event, wrapper);
				listener(arg);
			};
			this.on(event, wrapper);
		}

		emit(event: string, arg: unknown): void {
			for (const listener of [...(this._listeners.get(event) ?? [])]) {
				listener(arg);
			}
		}

		private off(event: string, listener: (arg: unknown) => void): void {
			const list = this._listeners.get(event);
			if (list) {
				this._listeners.set(event, list.filter(l => l !== listener));
			}
		}
	}

	/**
	 * Build a host with an injected fake fork. Returns the host plus accessors for
	 * the number of forks and the most-recently-forked child. `childPath` is a
	 * dummy string so the constructor never touches FileAccess.
	 */
	function makeHost(reply: ReplyHandler): { host: ChiposPluginHookHost; forkCount: () => number; lastChild: () => FakeChild | undefined } {
		const children: FakeChild[] = [];
		const fork = (_modulePath: string, _args: readonly string[], _opts: unknown): FakeChild => {
			const child = new FakeChild(reply);
			children.push(child);
			return child;
		};
		// The injected ForkFn slice is structurally compatible; cast through unknown
		// to satisfy the constructor's ForkFn parameter without importing node types.
		const host = new ChiposPluginHookHost(fork as unknown as ConstructorParameters<typeof ChiposPluginHookHost>[0], 'dummy/child/path');
		return { host, forkCount: () => children.length, lastChild: () => children[children.length - 1] };
	}

	const NEVER_REPLY: ReplyHandler = () => undefined;

	function makeReq(overrides?: Partial<HookEvalRequest>): HookEvalRequest {
		return {
			evalId: 'e1',
			pluginId: 'plugin-a',
			modulePath: '/plugins/plugin-a/hook.js',
			exportName: 'beforeTool',
			ctx: { tool: 'edit_file', args: { path: 'a.ts' } },
			timeoutMs: 1000,
			failClosed: true,
			...overrides,
		};
	}

	test('no consent → deny (failClosed) without forking a child', async () => {
		const { host, forkCount } = makeHost(NEVER_REPLY);

		const decision = await host.evaluate(makeReq());

		assert.deepStrictEqual(
			{ decision: decision.decision, forks: forkCount() },
			{ decision: 'deny', forks: 0 },
		);
	});

	test('consented + child replies deny → resolves deny, and the SENT ctx is a clone of the request ctx', async () => {
		const { host, lastChild } = makeHost(msg => ({ evalId: msg.evalId, decision: 'deny', agent_message: 'no' }));
		host.grantConsent('plugin-a');
		const req = makeReq();

		const decision = await host.evaluate(req);

		// Mutating the original ctx AFTER send must not change what was recorded as sent.
		(req.ctx as { args: { path: string } }).args.path = 'MUTATED-AFTER-SEND.ts';

		assert.deepStrictEqual(
			{
				decision,
				sentCtx: lastChild()!.sent[0].ctx,
				killCount: lastChild()!.killCount,
			},
			{
				decision: { decision: 'deny', amendedArgs: undefined, agentMessage: 'no', userMessage: undefined, reason: undefined } satisfies HookDecision,
				sentCtx: { tool: 'edit_file', args: { path: 'a.ts' } },
				killCount: 0,
			},
		);
	});

	test('child replies amend with amended_args → resolves amend with amendedArgs mapped through', async () => {
		const { host } = makeHost(msg => ({ evalId: msg.evalId, decision: 'amend', amended_args: { x: 1 } }));
		host.grantConsent('plugin-a');

		const decision = await host.evaluate(makeReq());

		assert.deepStrictEqual(
			decision,
			{ decision: 'amend', amendedArgs: { x: 1 }, agentMessage: undefined, userMessage: undefined, reason: undefined } satisfies HookDecision,
		);
	});

	test('timeout (child never replies) → deny (failClosed) and the child is killed', async () => {
		const { host, lastChild } = makeHost(NEVER_REPLY);
		host.grantConsent('plugin-a');

		const decision = await host.evaluate(makeReq({ timeoutMs: 10 }));

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason, killCount: lastChild()!.killCount },
			{ decision: 'deny', reason: 'timeout', killCount: 1 },
		);
	});

	test('child "exit" with a pending eval → that eval resolves deny (failClosed)', async () => {
		const { host, lastChild } = makeHost(NEVER_REPLY);
		host.grantConsent('plugin-a');

		// Kick off an eval that will never get a reply, then fire the child's exit
		// event so _onChildGone settles the in-flight pending fail-closed.
		const pending = host.evaluate(makeReq({ timeoutMs: 60000 }));
		lastChild()!.emit('exit', 0);

		const decision = await pending;

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason },
			{ decision: 'deny', reason: 'child exited' },
		);
	});
});
