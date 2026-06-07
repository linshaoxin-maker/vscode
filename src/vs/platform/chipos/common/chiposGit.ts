/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared wire contract for the ChipOS git runner.
 *
 * Running `git` needs Node `child_process`, which the sandboxed renderer of a
 * PACKAGED app does not have (no global `require` — verified via CDP). Renderer
 * code that shelled out to git through a bare `require('child_process')` therefore
 * silently no-op'd in the packaged build (it only worked in the dev build, whose
 * renderer has nodeIntegration). These types describe the renderer → main IPC used
 * to run git IN THE MAIN PROCESS instead, mirroring chiposPluginHook. Kept in
 * `platform/chipos/common` so the node runner, the electron-main registration, and
 * the workbench service interface all share one definition.
 */

/** IPC channel: renderer → main, run a `git` subcommand and return its result. */
export const CHIPOS_GIT_EXEC_CHANNEL = 'vscode:chipos:git:exec';

/** Arguments for one git invocation, sent renderer → main. Must be structuredClone-able. */
export interface IChiposGitExecArgs {
	/** Arguments passed to `git` as an argv array (no shell — so no injection). */
	readonly args: readonly string[];
	/** Working directory to run git in (defaults to the main process cwd if omitted). */
	readonly cwd?: string;
	/** Hard deadline in ms; on expiry the process is killed and `killed` is set. */
	readonly timeoutMs?: number;
}

/** The normalized result of one git invocation, returned main → renderer. */
export interface IChiposGitExecResult {
	/** True when git exited 0. */
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
	/**
	 * `error.code` from child_process: a string like `'ENOENT'` (git not on PATH)
	 * or `'ETIMEDOUT'`, the numeric exit code on a non-zero git exit, or `0`/`null`.
	 */
	readonly code: string | number | null;
	/** True when the process was killed (e.g. it timed out). */
	readonly killed: boolean;
}
