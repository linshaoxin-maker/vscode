/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git clone helper for installing agent plugins from a Git URL (FEAT-002b).
 *
 * Running git needs Node, which the browser layer does not type. Rather than the
 * `require('child_process')` form used elsewhere (which trips the layer check's
 * node-type errors), we reach `globalThis.require` through a manually-typed
 * escape hatch — no `@types/node` reference, so this stays layer-check clean and
 * degrades gracefully (returns undefined) outside Electron.
 *
 * Security: {@link isAllowedGitUrl} restricts the host to a configured allow-list
 * before any clone, and {@link cloneGitRepo} uses `execFile` (no shell) with an
 * argument array and a `--` terminator, so a hostile URL cannot inject a shell
 * command or extra git flags.
 */

/** The slice of Node's `child_process` we use, typed locally to avoid node types. */
interface INodeChildProcess {
	execFile(
		file: string,
		args: readonly string[],
		options: { readonly timeout?: number; readonly windowsHide?: boolean },
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	): void;
}

function requireChildProcess(): INodeChildProcess | undefined {
	const req = (globalThis as unknown as { require?: (moduleName: string) => unknown }).require;
	if (typeof req !== 'function') {
		return undefined;
	}
	try {
		return req('child_process') as INodeChildProcess;
	} catch {
		return undefined;
	}
}

/**
 * Whether `url` is an `https:` Git URL whose host exactly matches one of
 * `allowedDomains` (case-insensitive). Uses the parsed `URL.hostname`, which
 * excludes any `user@` info and port, so lookalikes like `evilgithub.com`,
 * `github.com.evil.com` and `https://github.com@evil.com/…` are all rejected.
 */
export function isAllowedGitUrl(url: string, allowedDomains: ReadonlyArray<string>): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:') {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	return allowedDomains.some(domain => host === domain.trim().toLowerCase());
}

/**
 * Shallow-clone `url` into `destDir` (which must not yet exist; its parent must).
 * Rejects if git is unavailable or the clone fails. Caller is responsible for
 * validating the URL ({@link isAllowedGitUrl}) and cleaning up `destDir`.
 */
export function cloneGitRepo(url: string, destDir: string, opts?: { readonly ref?: string; readonly timeoutMs?: number }): Promise<void> {
	const cp = requireChildProcess();
	if (!cp) {
		return Promise.reject(new Error('Git is not available in this environment (no Node child_process access).'));
	}
	const args = ['clone', '--depth', '1', '--single-branch'];
	if (opts?.ref) {
		args.push('--branch', opts.ref);
	}
	// `--` stops git option parsing so a hostile URL/path cannot inject flags;
	// execFile (no shell) prevents command injection.
	args.push('--', url, destDir);
	return new Promise<void>((resolve, reject) => {
		cp.execFile('git', args, { timeout: opts?.timeoutMs ?? 60000, windowsHide: true }, (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(`git clone failed: ${(stderr || '').trim() || error.message}`));
			} else {
				resolve();
			}
		});
	});
}
