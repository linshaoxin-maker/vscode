/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPluginHookEvalArgs, IPluginHookDecision } from '../common/chiposPluginHook.js';

/**
 * Tier-2 executable-hook subprocess runner (FEAT, H-3) — MAIN PROCESS side.
 *
 * Runs a consented plugin's hook export in an isolated node child so untrusted
 * plugin code never executes in a privileged process. This MUST run where Node
 * `child_process` is available — i.e. the electron-main process — because the
 * packaged app's renderer is sandboxed (no global `require`), which is exactly
 * why the original renderer-side fork silently fail-closed. The renderer reaches
 * this over IPC (see chiposPluginHookMain.ts).
 *
 * Security model — FAIL-CLOSED:
 *   - per-plugin consent + the `chipos.hooks.executablePlugins` flag + the
 *     workspace-trust gate are enforced by the renderer caller (the host), NOT here.
 *   - the ctx is cloned across IPC and frozen in the child, so plugin code cannot
 *     mutate live IDE state.
 *   - on timeout, child crash/exit, or fork failure, an unfulfilled eval resolves
 *     to `deny` when {@link IPluginHookEvalArgs.failClosed} is set.
 *
 * The child is plain CommonJS (embedded below as {@link CHILD_SOURCE}, written to
 * a temp file at runtime) so it ships in EVERY build — the production bundler does
 * not copy loose .js. It is forked in node mode via `ELECTRON_RUN_AS_NODE=1` over
 * the Electron binary (the fork-as-node precedent from
 * customEndpointTelemetryService.ts), with an automatic IPC channel.
 */

// The tier-2 hook child. EMBEDDED as a source string (NOT a separate .js file) so
// it ships in every build. At runtime we write it to a temp file and fork that.
// Single source of truth: keep in sync with the IPC protocol in evaluate() /
// _onMessage(). It MUST NOT import any VS Code module — it is the untrusted
// sandbox in which a consented plugin's hook runs, process-isolated from the host.
// Every failure path replies "deny" (fail-closed).
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

/** The wire message the child sends back over IPC. */
interface IChildReply {
	readonly evalId?: string;
	readonly decision?: string;
	readonly amended_args?: Record<string, unknown>;
	readonly agent_message?: string;
	readonly user_message?: string;
	readonly error?: string;
}

interface IPendingEval {
	readonly resolve: (decision: IPluginHookDecision) => void;
	readonly failClosed: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** The slice of `child_process.fork` we depend on (injectable so it can be faked in tests). */
export type ForkFn = (
	modulePath: string,
	args: readonly string[],
	opts: cp.ForkOptions,
) => cp.ChildProcess;

/**
 * Manages ONE long-lived, lazily-forked hook child. A single runner serves every
 * window — the child is stateless per eval (it requires the module + calls the
 * export), and module caching is keyed by absolute path.
 */
export class ChiposPluginHookRunner {

	private _child: cp.ChildProcess | undefined;
	private _childScriptPath: string | undefined;
	private _seq = 0;
	private readonly _pending = new Map<string, IPendingEval>();

	constructor(private readonly _forkImpl: ForkFn = cp.fork) { }

	/**
	 * Evaluate one hook in the child. Returns the plugin's decision, or the
	 * fail-closed default on fork failure / timeout / child crash.
	 */
	async evaluate(args: IPluginHookEvalArgs): Promise<IPluginHookDecision> {
		const child = this._ensureChild();
		if (!child) {
			return { decision: args.failClosed ? 'deny' : 'proceed', reason: 'no-fork' };
		}
		const evalId = `h${++this._seq}`;
		return new Promise<IPluginHookDecision>(resolve => {
			const timer = setTimeout(() => {
				// Timed out: kill the child so a hung plugin cannot wedge later evals,
				// resolve fail-closed, drop this pending entry. Next evaluate respawns.
				this._kill();
				this._pending.delete(evalId);
				resolve({ decision: args.failClosed ? 'deny' : 'proceed', reason: 'timeout' });
			}, args.timeoutMs);

			this._pending.set(evalId, { resolve, failClosed: args.failClosed, timer });
			child.send({ evalId, modulePath: args.modulePath, exportName: args.exportName, ctx: args.ctx });
		});
	}

	/** Kill the child (if any). Pending evals are settled by the exit handler. */
	dispose(): void {
		this._kill();
	}

	/** Write the embedded child script to a temp file once and return its path, or undefined on failure. */
	private _resolveChildScript(): string | undefined {
		if (this._childScriptPath) {
			return this._childScriptPath;
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

	/** Lazily fork the child and wire its IPC + lifecycle handlers. */
	private _ensureChild(): cp.ChildProcess | undefined {
		if (this._child) {
			return this._child;
		}
		const childPath = this._resolveChildScript();
		if (!childPath) {
			return undefined;
		}
		let child: cp.ChildProcess;
		try {
			child = this._forkImpl(childPath, [], {
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				execPath: process.execPath,
				stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
			});
		} catch {
			return undefined;
		}
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

	/** The child exited or errored: fail every in-flight eval CLOSED, drop the child so the next evaluate respawns. */
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
				// best-effort
			}
		}
	}

	private _toDecision(reply: IChildReply): IPluginHookDecision {
		const raw = reply.decision;
		const decision: IPluginHookDecision['decision'] =
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
