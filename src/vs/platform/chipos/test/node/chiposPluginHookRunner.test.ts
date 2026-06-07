/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as cp from 'child_process';
import { ChiposPluginHookRunner, ForkFn } from '../../node/chiposPluginHookRunner.js';
import { IPluginHookDecision, IPluginHookEvalArgs } from '../../common/chiposPluginHook.js';

/**
 * Unit tests for {@link ChiposPluginHookRunner} using an INJECTED fake `fork` — no
 * real node child is ever spawned. The fake child records what the runner sends /
 * kills and can auto-reply over its `message` event, so every fail-closed and
 * decision-mapping path is driven deterministically.
 */
suite('ChiposPluginHookRunner', () => {

	/** A reply the fake child will post back, or undefined to stay silent (drives timeout/exit paths). */
	type ReplyHandler = (msg: ISentMessage) => Record<string, unknown> | undefined;

	/** The shape the runner sends over IPC (cf. chiposPluginHookRunner.ts evaluate()). */
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
			// Snapshot what crossed the boundary so a later mutation cannot retroactively
			// change what we assert was sent.
			const snapshot = structuredClone(msg) as ISentMessage;
			this.sent.push(snapshot);
			const reply = this._reply(snapshot);
			if (reply !== undefined) {
				// Model async IPC: deliver on a microtask, after evaluate() registered the pending eval.
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

		emit(event: string, arg: unknown): void {
			for (const listener of [...(this._listeners.get(event) ?? [])]) {
				listener(arg);
			}
		}
	}

	function makeRunner(reply: ReplyHandler): { runner: ChiposPluginHookRunner; forkCount: () => number; lastChild: () => FakeChild | undefined } {
		const children: FakeChild[] = [];
		const fork: ForkFn = (_modulePath, _args, _opts) => {
			const child = new FakeChild(reply);
			children.push(child);
			return child as unknown as cp.ChildProcess;
		};
		const runner = new ChiposPluginHookRunner(fork);
		return { runner, forkCount: () => children.length, lastChild: () => children[children.length - 1] };
	}

	const NEVER_REPLY: ReplyHandler = () => undefined;

	function makeArgs(overrides?: Partial<IPluginHookEvalArgs>): IPluginHookEvalArgs {
		return {
			modulePath: '/plugins/plugin-a/hook.js',
			exportName: 'beforeTool',
			ctx: { tool: 'edit_file', args: { path: 'a.ts' } },
			timeoutMs: 1000,
			failClosed: true,
			...overrides,
		};
	}

	test('child replies deny → resolves deny with the message mapped through; ctx forwarded verbatim', async () => {
		const { runner, lastChild } = makeRunner(msg => ({ evalId: msg.evalId, decision: 'deny', agent_message: 'no' }));

		const decision = await runner.evaluate(makeArgs());

		assert.deepStrictEqual(
			{ decision, sentCtx: lastChild()!.sent[0].ctx, killCount: lastChild()!.killCount },
			{
				decision: { decision: 'deny', amendedArgs: undefined, agentMessage: 'no', userMessage: undefined, reason: undefined } satisfies IPluginHookDecision,
				sentCtx: { tool: 'edit_file', args: { path: 'a.ts' } },
				killCount: 0,
			},
		);
	});

	test('child replies amend with amended_args → resolves amend with amendedArgs mapped through', async () => {
		const { runner } = makeRunner(msg => ({ evalId: msg.evalId, decision: 'amend', amended_args: { x: 1 } }));

		const decision = await runner.evaluate(makeArgs());

		assert.deepStrictEqual(
			decision,
			{ decision: 'amend', amendedArgs: { x: 1 }, agentMessage: undefined, userMessage: undefined, reason: undefined } satisfies IPluginHookDecision,
		);
	});

	test('timeout (child never replies) → deny (failClosed) and the child is killed', async () => {
		const { runner, lastChild } = makeRunner(NEVER_REPLY);

		const decision = await runner.evaluate(makeArgs({ timeoutMs: 10 }));

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason, killCount: lastChild()!.killCount },
			{ decision: 'deny', reason: 'timeout', killCount: 1 },
		);
	});

	test('child "exit" with a pending eval → that eval resolves deny (failClosed)', async () => {
		const { runner, lastChild } = makeRunner(NEVER_REPLY);

		// Kick off an eval that will never get a reply, then fire the child's exit event.
		const pending = runner.evaluate(makeArgs({ timeoutMs: 60000 }));
		lastChild()!.emit('exit', 0);

		const decision = await pending;

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason },
			{ decision: 'deny', reason: 'child exited' },
		);
	});

	test('fork throws → fail-closed deny without a usable child', async () => {
		const runner = new ChiposPluginHookRunner((() => { throw new Error('no fork'); }) as ForkFn);

		const decision = await runner.evaluate(makeArgs());

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason },
			{ decision: 'deny', reason: 'no-fork' },
		);
	});
});
