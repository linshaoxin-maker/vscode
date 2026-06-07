/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tier-2 executable-hook subprocess host (FEAT, H-3).
 *
 * Runs a consented plugin's hook export in an isolated node child so untrusted
 * plugin code never executes on the IDE renderer thread. The child is plain
 * CommonJS ({@link pluginHookChild.js}), forked in node mode via
 * `ELECTRON_RUN_AS_NODE=1` over the Electron binary (the fork-as-node precedent
 * from customEndpointTelemetryService.ts), with an automatic IPC channel.
 *
 * Security model — this host is FAIL-CLOSED:
 *   - per-plugin consent is enforced here ({@link ChiposPluginHookHost.hasConsent});
 *     the `chipos.hooks.executablePlugins` flag and workspace-trust gate belong to
 *     the H-3 caller, not this class.
 *   - the ctx is `structuredClone`d before crossing the IPC boundary and frozen in
 *     the child, so plugin code cannot mutate live IDE state.
 *   - on timeout, child crash/exit, or no consent / no node, an unfulfilled eval
 *     resolves to `deny` when {@link HookEvalRequest.failClosed} is set.
 *
 * Node access uses the bare-`require` idiom from gitImport.ts so the browser
 * tsconfig (no `@types/node`) still type-checks; outside Electron `fork` is
 * undefined and every evaluate degrades to the fail-closed default.
 */

import { FileAccess } from '../../../../../base/common/network.js';

/** The slice of Node's `child_process.ChildProcess` we use, typed locally to avoid node types. */
interface IChildProcess {
	send(msg: unknown): void;
	kill(signal?: string): void;
	on(event: string, listener: (arg: unknown) => void): void;
	once(event: string, listener: (arg: unknown) => void): void;
	readonly connected?: boolean;
}

/** The slice of `child_process.fork` we use, typed locally to avoid node types. */
type ForkFn = (
	modulePath: string,
	args: readonly string[],
	opts: { env: Record<string, string | undefined>; execPath?: string; stdio?: unknown },
) => IChildProcess;

// Electron's renderer injects a global `require`; declare it locally (type-only,
// erased at runtime) so this file type-checks without @types/node.
declare const require: ((moduleName: string) => unknown) | undefined;

/** The slice of Node's `process` global we use, typed locally to avoid node types (cf. platform.ts INodeProcess). */
interface INodeProcessSlice {
	readonly env: Record<string, string | undefined>;
	readonly execPath: string;
}
declare const process: INodeProcessSlice;

/** Resolve `child_process.fork`, or undefined when not running under Electron. */
function defaultFork(): ForkFn | undefined {
	try {
		return typeof require === 'function' ? (require('child_process') as { fork: ForkFn }).fork : undefined;
	} catch {
		return undefined;
	}
}

/** A single hook evaluation request handed to {@link ChiposPluginHookHost.evaluate}. */
export interface HookEvalRequest {
	readonly evalId: string;
	readonly pluginId: string;
	readonly modulePath: string;
	readonly exportName: string;
	readonly ctx: object;
	readonly timeoutMs: number;
	readonly failClosed: boolean;
}

/** The decision returned from a hook evaluation. */
export interface HookDecision {
	readonly decision: 'proceed' | 'deny' | 'ask' | 'amend';
	readonly amendedArgs?: object;
	readonly agentMessage?: string;
	readonly userMessage?: string;
	readonly reason?: string;
}

/** The wire message the child sends back over IPC. */
interface IChildReply {
	readonly evalId?: string;
	readonly decision?: string;
	readonly amended_args?: object;
	readonly agent_message?: string;
	readonly user_message?: string;
	readonly error?: string;
}

interface IPendingEval {
	readonly resolve: (decision: HookDecision) => void;
	readonly failClosed: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Manages ONE long-lived, lazily-spawned hook child. The H-3 caller owns this
 * instance's lifecycle and must call {@link dispose} when done; nothing global is
 * registered here.
 */
export class ChiposPluginHookHost {

	private readonly _forkImpl: ForkFn | undefined;
	private readonly _childPath: string;
	private readonly _consented = new Set<string>();
	private readonly _pending = new Map<string, IPendingEval>();
	private _child: IChildProcess | undefined;

	constructor(forkImpl?: ForkFn, childPath?: string) {
		this._forkImpl = forkImpl ?? defaultFork();
		this._childPath = childPath ?? FileAccess.asFileUri('vs/workbench/contrib/chipos/browser/chatAgent/pluginHookChild.js').fsPath;
	}

	/** Record that the user has consented to running `pluginId`'s executable hooks. */
	grantConsent(pluginId: string): void {
		this._consented.add(pluginId);
	}

	/** Whether the user has consented to running `pluginId`'s executable hooks. */
	hasConsent(pluginId: string): boolean {
		return this._consented.has(pluginId);
	}

	/**
	 * Evaluate one hook in the child. Returns the plugin's decision, or the
	 * fail-closed default ({@link HookEvalRequest.failClosed} ? deny : proceed) on
	 * no-consent / no-node / timeout / child crash.
	 */
	async evaluate(req: HookEvalRequest): Promise<HookDecision> {
		if (!this.hasConsent(req.pluginId) || !this._forkImpl) {
			return { decision: req.failClosed ? 'deny' : 'proceed', reason: 'plugin not consented / no node' };
		}

		const child = this._ensureChild();
		if (!child) {
			return { decision: req.failClosed ? 'deny' : 'proceed', reason: 'plugin not consented / no node' };
		}

		return new Promise<HookDecision>(resolve => {
			const timer = setTimeout(() => {
				// Timed out: kill the child so a hung plugin cannot wedge later evals,
				// resolve fail-closed, and drop this pending entry. The next evaluate
				// respawns a fresh child.
				this._kill();
				this._pending.delete(req.evalId);
				resolve({ decision: req.failClosed ? 'deny' : 'proceed', reason: 'timeout' });
			}, req.timeoutMs);

			this._pending.set(req.evalId, { resolve, failClosed: req.failClosed, timer });

			// Clone + freeze the ctx so plugin code cannot mutate live IDE state.
			child.send({
				evalId: req.evalId,
				modulePath: req.modulePath,
				exportName: req.exportName,
				ctx: structuredClone(req.ctx),
			});
		});
	}

	/** Kill the child (if any). Pending evals are settled by the exit handler. */
	dispose(): void {
		this._kill();
	}

	/** Lazily spawn the child and wire its IPC + lifecycle handlers. */
	private _ensureChild(): IChildProcess | undefined {
		if (this._child) {
			return this._child;
		}
		if (!this._forkImpl) {
			return undefined;
		}

		const child = this._forkImpl(this._childPath, [], {
			env: {
				...(typeof process !== 'undefined' ? process.env : {}),
				ELECTRON_RUN_AS_NODE: '1',
			},
			execPath: typeof process !== 'undefined' ? process.execPath : undefined,
			stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
		});

		child.on('message', (m: unknown) => this._onMessage(m as IChildReply));
		child.on('exit', () => this._onChildGone());
		child.on('error', () => this._onChildGone());

		this._child = child;
		return child;
	}

	/** Resolve the pending eval named by the child's reply. */
	private _onMessage(reply: IChildReply): void {
		const evalId = reply.evalId;
		if (!evalId) {
			return;
		}
		const pending = this._pending.get(evalId);
		if (!pending) {
			return;
		}
		if (pending.timer !== undefined) {
			clearTimeout(pending.timer);
		}
		this._pending.delete(evalId);
		pending.resolve(this._toDecision(reply));
	}

	/**
	 * The child exited or errored: fail every in-flight eval CLOSED and drop the
	 * child so the next evaluate respawns.
	 */
	private _onChildGone(): void {
		this._child = undefined;
		for (const [, pending] of this._pending) {
			if (pending.timer !== undefined) {
				clearTimeout(pending.timer);
			}
			pending.resolve({ decision: pending.failClosed ? 'deny' : 'proceed', reason: 'child exited' });
		}
		this._pending.clear();
	}

	/** Kill the child process and null our reference; respawns on next evaluate. */
	private _kill(): void {
		const child = this._child;
		this._child = undefined;
		if (child) {
			try {
				child.kill();
			} catch {
				// best effort
			}
		}
	}

	/** Map a child wire reply to a {@link HookDecision}; unknown decision -> proceed. */
	private _toDecision(reply: IChildReply): HookDecision {
		const raw = reply.decision;
		const decision: HookDecision['decision'] =
			(raw === 'deny' || raw === 'ask' || raw === 'amend') ? raw : 'proceed';
		return {
			decision,
			amendedArgs: reply.amended_args,
			agentMessage: reply.agent_message,
			userMessage: reply.user_message,
			reason: reply.error,
		};
	}
}
