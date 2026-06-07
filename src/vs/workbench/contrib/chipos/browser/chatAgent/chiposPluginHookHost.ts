/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tier-2 executable-hook subprocess host (FEAT, H-3).
 *
 * Runs a consented plugin's hook export in an isolated node child so untrusted
 * plugin code never executes on the IDE renderer thread. The child is plain
 * CommonJS (embedded below as {@link CHILD_SOURCE}, written to a temp file at
 * runtime), forked in node mode via
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

// The tier-2 hook child is a standalone CommonJS script run via fork() in node
// mode. It is EMBEDDED here as a source string (NOT a separate .js file) so it
// ships in EVERY build — the production bundler does not copy loose .js, which
// would otherwise leave executable hooks broken in a packaged app. At runtime we
// write it to a temp file and fork that. Single source of truth: keep this in
// sync with the IPC protocol in evaluate() / _onMessage(). It MUST NOT import any
// VS Code module — it is the untrusted sandbox in which a consented plugin's hook
// runs, process-isolated from the renderer. Every failure path replies "deny"
// (fail-closed).
const CHILD_SOURCE = `'use strict';
const _cache = new Map();
function normalize(d) {
	const raw = d && d.decision;
	const decision = (raw === 'deny' || raw === 'ask' || raw === 'amend') ? raw : 'proceed';
	const result = { decision: decision };
	if (d && typeof d.amendedArgs === 'object' && d.amendedArgs !== null) { result.amended_args = d.amendedArgs; }
	if (d && typeof d.agentMessage === 'string') { result.agent_message = d.agentMessage; }
	if (d && typeof d.userMessage === 'string') { result.user_message = d.userMessage; }
	return result;
}
process.on('message', async (msg) => {
	const { evalId, modulePath, exportName, ctx } = msg;
	try {
		let mod = _cache.get(modulePath);
		if (!mod) { mod = require(modulePath); _cache.set(modulePath, mod); }
		const fn = mod && (mod[exportName] || (mod.default && mod.default[exportName]));
		if (typeof fn !== 'function') { process.send({ evalId: evalId, decision: 'deny', error: 'export ' + exportName + ' is not a function' }); return; }
		const out = await fn(Object.freeze(ctx));
		process.send(Object.assign({ evalId: evalId }, normalize(out)));
	} catch (e) { process.send({ evalId: evalId, decision: 'deny', error: String((e && e.message) || e) }); }
});
`;

/** Minimal Node module slices we use via the bare-require idiom (browser tsconfig has no @types/node). */
interface INodeFs { writeFileSync(path: string, data: string): void; }
interface INodeOs { tmpdir(): string; }
interface INodePath { join(...parts: string[]): string; }
function nodeMod<T>(name: string): T | undefined {
	try {
		return typeof require === 'function' ? (require(name) as T) : undefined;
	} catch {
		return undefined;
	}
}

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
	private readonly _childPath: string | undefined;
	private _childScriptPath: string | undefined;
	private readonly _consented = new Set<string>();
	private readonly _pending = new Map<string, IPendingEval>();
	private _child: IChildProcess | undefined;

	constructor(forkImpl?: ForkFn, childPath?: string) {
		this._forkImpl = forkImpl ?? defaultFork();
		// Injected childPath (tests) wins; otherwise the embedded CHILD_SOURCE is
		// written to a temp file lazily in _ensureChild, so it ships in every build.
		this._childPath = childPath;
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

	/** Write the embedded child script to a temp file once and return its path (or
	 * the injected override). Returns undefined when Node fs/os/path are missing. */
	private _resolveChildScript(): string | undefined {
		if (this._childPath) {
			return this._childPath;
		}
		if (this._childScriptPath) {
			return this._childScriptPath;
		}
		const fs = nodeMod<INodeFs>('fs');
		const os = nodeMod<INodeOs>('os');
		const path = nodeMod<INodePath>('path');
		if (!fs || !os || !path) {
			return undefined;
		}
		try {
			const file = path.join(os.tmpdir(), 'chipos-plugin-hook-child.js');
			fs.writeFileSync(file, CHILD_SOURCE);
			this._childScriptPath = file;
			return file;
		} catch {
			return undefined;
		}
	}

	/** Lazily spawn the child and wire its IPC + lifecycle handlers. */
	private _ensureChild(): IChildProcess | undefined {
		if (this._child) {
			return this._child;
		}
		if (!this._forkImpl) {
			return undefined;
		}
		const childPath = this._resolveChildScript();
		if (!childPath) {
			return undefined;
		}

		const child = this._forkImpl(childPath, [], {
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
