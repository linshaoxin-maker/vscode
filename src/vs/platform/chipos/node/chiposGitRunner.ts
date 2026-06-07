/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { IChiposGitExecArgs, IChiposGitExecResult } from '../common/chiposGit.js';

/**
 * ChipOS git runner — MAIN PROCESS side.
 *
 * Runs the `git` binary via `execFile` (no shell, so a hostile URL/path in the
 * argv cannot inject a command) and normalizes the outcome into an
 * {@link IChiposGitExecResult}. This MUST run where Node `child_process` is
 * available — i.e. electron-main — because the packaged app's renderer is
 * sandboxed (no global `require`), which is exactly why the original renderer-side
 * `require('child_process')` git calls silently no-op'd. The renderer reaches this
 * over IPC (see chiposGitMain.ts).
 *
 * The runner never throws: every failure path (missing git, timeout, non-zero
 * exit, oversized output) resolves to a result with `ok: false`, so the renderer
 * callers can classify the error and degrade gracefully.
 */

// 64 MiB: well above `git log`/`git diff --numstat` output for large repos, so we
// don't truncate-and-error the way the default 1 MiB exec buffer would.
const MAX_BUFFER = 64 * 1024 * 1024;

/** A child_process error as execFile actually surfaces it: `code` may be a string like 'ENOENT'. */
type ExecFileError = Error & { code?: string | number | null; killed?: boolean };

/** The slice of `child_process.execFile` we depend on (injectable so it can be faked in tests). */
export type ExecFileFn = (
	file: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly timeout?: number; readonly windowsHide?: boolean; readonly maxBuffer?: number },
	callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => void;

function defaultExecFile(
	file: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly timeout?: number; readonly windowsHide?: boolean; readonly maxBuffer?: number },
	callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
): void {
	// execFile defaults to utf8 encoding (no `encoding` option here), so stdout/stderr
	// arrive as strings; we only bridge the slightly looser ExecFileException typing
	// (`code` can be null) onto our ExecFileError.
	cp.execFile(file, args.slice(), options, (error, stdout, stderr) => {
		callback(error as ExecFileError | null, stdout, stderr);
	});
}

export class ChiposGitRunner {

	constructor(private readonly _execFileImpl: ExecFileFn = defaultExecFile) { }

	/** Run one git invocation. Resolves (never rejects) with a normalized result. */
	exec(args: IChiposGitExecArgs): Promise<IChiposGitExecResult> {
		const list = Array.isArray(args?.args) ? args.args.map(String) : [];
		return new Promise<IChiposGitExecResult>(resolve => {
			try {
				this._execFileImpl(
					'git',
					list,
					{ cwd: args?.cwd, timeout: args?.timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER },
					(error, stdout, stderr) => {
						resolve({
							ok: !error,
							stdout: stdout ?? '',
							stderr: stderr ?? '',
							code: error ? (error.code ?? null) : 0,
							killed: !!(error && error.killed),
						});
					},
				);
			} catch (e) {
				// Synchronous throw from execFile (e.g. bad options) — fail closed.
				resolve({ ok: false, stdout: '', stderr: String((e as Error)?.message ?? e), code: null, killed: false });
			}
		});
	}
}
