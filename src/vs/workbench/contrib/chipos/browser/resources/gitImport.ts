/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IChiposGitService } from '../../common/chiposGitService.js';

/**
 * Git clone helper for installing agent plugins from a Git URL (FEAT-002b).
 *
 * Running git needs Node `child_process`, which the sandboxed renderer of a
 * PACKAGED app does not have (no global `require`). The original bare-`require`
 * form therefore silently no-op'd in the packaged build. {@link cloneGitRepo}
 * now runs git in the MAIN process via the injected {@link IChiposGitService}
 * (an undefined service — e.g. on web — degrades to "git is not available").
 *
 * Security: {@link isAllowedGitUrl} restricts the host to a configured allow-list
 * before any clone, and the clone runs as an `execFile` argv (no shell) with a
 * `--` terminator, so a hostile URL cannot inject a shell command or extra git
 * flags.
 */

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
 * Shallow-clone `url` into `destDir` (which must not yet exist; its parent must),
 * running git in the main process via `gitService`. Rejects if git is unavailable
 * (no service / not on PATH) or the clone fails. Caller is responsible for
 * validating the URL ({@link isAllowedGitUrl}) and cleaning up `destDir`.
 */
export async function cloneGitRepo(url: string, destDir: string, opts?: { readonly ref?: string; readonly timeoutMs?: number }, gitService?: IChiposGitService): Promise<void> {
	if (!gitService) {
		throw new Error('Git is not available in this environment (no Node git access).');
	}
	const args = ['clone', '--depth', '1', '--single-branch'];
	if (opts?.ref) {
		args.push('--branch', opts.ref);
	}
	// `--` stops git option parsing so a hostile URL/path cannot inject flags;
	// the runner uses execFile (no shell), which prevents command injection.
	args.push('--', url, destDir);
	const res = await gitService.exec({ args, timeoutMs: opts?.timeoutMs ?? 60000 });
	if (res.ok) {
		return;
	}
	if (res.code === 'ENOENT') {
		throw new Error('Git is not installed or not on PATH. Install Git to import plugins from a Git URL.');
	}
	if (res.killed || res.code === 'ETIMEDOUT') {
		throw new Error('git clone timed out — check the URL and your network connection.');
	}
	throw new Error(`git clone failed: ${(res.stderr || '').trim() || `git exited with code ${res.code}`}`);
}
