/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared resolution of the launchable chipos-worker executable inside a cached
 * version directory (`~/.chipos/workers/<version>/`).
 *
 * The worker is built with Nuitka `--standalone` (build_worker.sh): the release
 * asset is `chipos-worker-<tag>.tar.gz` whose single top-level entry is a folder
 * `chipos-worker-<tag>/` holding the executable plus ~2400 bundled libs/data.
 * Unlike the old `--onefile` build (one self-extracting file that unpacked
 * ~399 MB to a temp dir on EVERY launch and intermittently wedged for hours in
 * macOS's Gatekeeper/Spotlight scan), the standalone folder runs directly with
 * no per-launch unpack.
 *
 * Both the local Electron spawn path (`sidecarManagerMain`) and the REH spawn
 * path (`chiposRemoteWorkerService`) share this resolver so the on-disk layout
 * is interpreted identically everywhere.
 *
 * Layouts handled (checked in order):
 *   1. standalone folder : <versionDir>/<name>/<name>[.exe]
 *   2. legacy single file : <versionDir>/<name>[.exe]
 *
 * Keeping (2) means caches left by pre-standalone (onefile) builds — and any
 * release still published in the old single-file format during the transition —
 * keep working without a forced re-download.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Append `.exe` on Windows; the build keeps the platform tag in the name. */
function exeName(name: string): string {
	return process.platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Resolve the launchable worker executable inside `versionDir` for binary base
 * `name` (e.g. `chipos-worker-darwin-arm64`). Returns the absolute path to the
 * executable, or `null` if neither the standalone-folder nor the legacy single-
 * file layout is present.
 */
export function resolveWorkerBinary(versionDir: string, name: string): string | null {
	const exe = exeName(name);

	// (1) standalone folder layout — current release format.
	const inFolder = path.join(versionDir, name, exe);
	if (isFile(inFolder)) { return inFolder; }

	// (2) legacy single-file layout — onefile builds / dev caches.
	const single = path.join(versionDir, exe);
	if (isFile(single)) { return single; }
	// Some legacy caches stored the file without the `.exe` suffix on Windows.
	if (exe !== name) {
		const singleNoExt = path.join(versionDir, name);
		if (isFile(singleNoExt)) { return singleNoExt; }
	}

	return null;
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}
