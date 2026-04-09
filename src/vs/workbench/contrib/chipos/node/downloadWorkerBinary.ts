/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * R45: Worker 二进制下载器（IDE Node.js 侧）
 *
 * 职责：
 *   1. 检测本地是否已缓存目标版本的 Worker 二进制
 *   2. 从 GitHub Releases 下载对应平台的二进制
 *   3. 解压到 ~/.chipos/workers/{version}/
 *   4. 查询 GitHub API 获取最新版本
 *
 * 使用方：sidecarManager.ts / workerManager.ts
 */

import { join } from 'path';
import { existsSync, mkdirSync, chmodSync, statSync, unlinkSync, readdirSync } from 'fs';
import { homedir, platform, arch } from 'os';
import { execSync, execFileSync } from 'child_process';
import { CHIPOS_RELEASE_BASE_URL, CHIPOS_RELEASE_API_URL } from '../common/releaseConfig.js';

export interface WorkerBinaryInfo {
	/** Full path to the executable binary */
	binaryPath: string;
	/** Resolved version string (e.g. "0.1.0") */
	version: string;
	/** Platform tag (e.g. "linux-x64") */
	platformTag: string;
}

/**
 * Detect the platform tag for the current environment.
 */
export function detectPlatformTag(): string {
	const os = platform();
	const cpu = arch();

	if (os === 'linux' && cpu === 'x64') { return 'linux-x64'; }
	if (os === 'linux' && cpu === 'arm64') { return 'linux-arm64'; }
	if (os === 'darwin' && cpu === 'x64') { return 'darwin-x64'; }
	if (os === 'darwin' && cpu === 'arm64') { return 'darwin-arm64'; }
	if (os === 'win32' && cpu === 'x64') { return 'win32-x64'; }

	throw new Error(`Unsupported platform: ${os}-${cpu}`);
}

/**
 * Return the binary filename for the given platform.
 */
export function binaryName(platformTag?: string): string {
	const tag = platformTag ?? detectPlatformTag();
	return `chipos-worker-${tag}`;
}

/**
 * Return the chipos home directory (default: ~/.chipos/).
 */
export function chiposHome(): string {
	return process.env['CHIPOS_HOME'] ?? join(homedir(), '.chipos');
}

/**
 * Return the path where a specific version's binary should be cached.
 */
export function workerBinaryDir(version: string): string {
	return join(chiposHome(), 'workers', version);
}

/**
 * Check if the Worker binary for a given version is already cached locally.
 */
export function isWorkerBinaryCached(version: string, platformTag?: string): WorkerBinaryInfo | undefined {
	const tag = platformTag ?? detectPlatformTag();
	const dir = workerBinaryDir(version);
	const name = binaryName(tag);
	const binaryPath = join(dir, name);

	if (existsSync(binaryPath)) {
		return { binaryPath, version, platformTag: tag };
	}
	return undefined;
}

/**
 * Find the newest cached Worker binary (any version).
 */
export function findCachedWorkerBinary(platformTag?: string): WorkerBinaryInfo | undefined {
	const tag = platformTag ?? detectPlatformTag();
	const name = binaryName(tag);
	const workersDir = join(chiposHome(), 'workers');

	if (!existsSync(workersDir)) {
		return undefined;
	}

	const versions = readdirSync(workersDir)
		.filter(d => {
			const p = join(workersDir, d, name);
			return existsSync(p);
		})
		.sort()
		.reverse();

	if (versions.length === 0) {
		return undefined;
	}

	const latest = versions[0];
	return {
		binaryPath: join(workersDir, latest, name),
		version: latest,
		platformTag: tag,
	};
}

/**
 * Build the download URL for a Worker binary.
 *
 * Priority: configUrl (IDE setting) > env CHIPOS_WORKER_DOWNLOAD_URL > GitHub Releases default.
 */
export function downloadUrl(version: string, platformTag?: string, configUrl?: string): string {
	const override = configUrl || process.env['CHIPOS_WORKER_DOWNLOAD_URL'];
	if (override) {
		return override;
	}

	const tag = platformTag ?? detectPlatformTag();
	const name = binaryName(tag);
	return `${CHIPOS_RELEASE_BASE_URL}/v${version}/${name}.tar.gz`;
}

/**
 * Download and extract the Worker binary for a given version.
 *
 * @param version    - Semver version string (e.g. "0.3.0")
 * @param platformTag - Override platform tag
 * @param onProgress  - Progress callback
 * @param configUrl   - IDE setting `chipos.worker.downloadUrl`, takes priority over env
 * @returns Path to the extracted binary
 * @throws if download or extraction fails
 */
export async function downloadWorkerBinary(
	version: string,
	platformTag?: string,
	onProgress?: (message: string) => void,
	configUrl?: string,
): Promise<WorkerBinaryInfo> {
	const tag = platformTag ?? detectPlatformTag();

	const cached = isWorkerBinaryCached(version, tag);
	if (cached) {
		onProgress?.(`Worker v${version} already cached`);
		return cached;
	}

	const dir = workerBinaryDir(version);
	const cacheDir = join(chiposHome(), 'cache');
	const name = binaryName(tag);
	const url = downloadUrl(version, tag, configUrl);
	const archivePath = join(cacheDir, `${name}-v${version}.tar.gz`);

	mkdirSync(dir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	onProgress?.(`Downloading Worker v${version} for ${tag}...`);

	if (url.startsWith('file://')) {
		const src = url.replace('file://', '');
		execSync(`cp "${src}" "${archivePath}"`);
	} else {
		_downloadFile(url, archivePath);
	}

	onProgress?.(`Extracting...`);
	execSync(`tar xzf "${archivePath}" -C "${dir}"`);

	const binaryPath = join(dir, name);

	if (existsSync(binaryPath)) {
		chmodSync(binaryPath, 0o755);
	} else {
		const files = readdirSync(dir);
		const found = files.find(f => f.includes('chipos-worker'));
		if (found) {
			chmodSync(join(dir, found), 0o755);
		}
	}

	try { unlinkSync(archivePath); } catch { /* ignore */ }

	onProgress?.(`Worker v${version} ready: ${binaryPath}`);

	return { binaryPath, version, platformTag: tag };
}

/**
 * Query GitHub API for the latest release version.
 */
export async function checkLatestVersion(): Promise<string | undefined> {
	try {
		const url = CHIPOS_RELEASE_API_URL;
		const result = execFileSync('curl', ['-fsSL', '-H', 'Accept: application/vnd.github.v3+json', url], {
			timeout: 10000,
			encoding: 'utf-8',
		});
		const data = JSON.parse(result);
		const tag = data.tag_name as string | undefined;
		return tag?.replace(/^v/, '') ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * R52: Upgrade Worker binary — download new version, stop old, start new.
 *
 * @returns the new WorkerBinaryInfo, or undefined if no upgrade needed/available
 */
export async function upgradeWorkerBinary(
	currentVersion: string | undefined,
	onProgress?: (message: string) => void,
	configUrl?: string,
): Promise<WorkerBinaryInfo | undefined> {
	const latestVersion = await checkLatestVersion();
	if (!latestVersion) {
		onProgress?.('Cannot determine latest version');
		return undefined;
	}

	if (currentVersion === latestVersion) {
		onProgress?.(`Already at latest version v${latestVersion}`);
		return undefined;
	}

	onProgress?.(`Upgrading from v${currentVersion ?? 'unknown'} to v${latestVersion}`);

	const info = await downloadWorkerBinary(latestVersion, undefined, onProgress, configUrl);

	cleanupOldVersions(latestVersion, 2);

	return info;
}

/**
 * R52: Remove old Worker binary versions, keeping the N most recent.
 */
export function cleanupOldVersions(currentVersion: string, keepCount: number = 2): void {
	const workersDir = join(chiposHome(), 'workers');
	if (!existsSync(workersDir)) { return; }

	const versions = readdirSync(workersDir)
		.filter(d => {
			try {
				return statSync(join(workersDir, d)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort()
		.reverse();

	const toKeep = new Set<string>([currentVersion]);
	let kept = 0;
	for (const v of versions) {
		if (toKeep.has(v) || kept < keepCount) {
			toKeep.add(v);
			kept++;
		}
	}

	for (const v of versions) {
		if (!toKeep.has(v)) {
			try {
				const dir = join(workersDir, v);
				const files = readdirSync(dir);
				for (const f of files) { unlinkSync(join(dir, f)); }
				require('fs').rmdirSync(dir);
			} catch { /* best effort cleanup */ }
		}
	}
}

function _downloadFile(url: string, dest: string): void {
	try {
		execSync(`curl -fSL --retry 3 -o "${dest}" "${url}"`, { timeout: 300000 });
	} catch {
		try {
			execSync(`wget -q -O "${dest}" "${url}"`, { timeout: 300000 });
		} catch {
			throw new Error(`Failed to download ${url}. Ensure curl or wget is available.`);
		}
	}
}
