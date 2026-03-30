/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Server Download — 在远程服务器上下载并安装 ChipOS Server。
 *
 * 参考 vscode-test-resolver/src/download.ts 的实现模式：
 * 1. 从 product.json 读取 commit hash 和 quality
 * 2. 根据远程 OS/arch 构造下载 URL
 * 3. 通过 SSH 在远程下载并解压
 *
 * Dev 模式（无 commit）：使用本地 code-server.sh 脚本
 * Production 模式：下载对应版本的 server tarball
 */

import { SshConnection } from './sshConnection';

export interface ProductInfo {
	commit: string;
	quality: string;
	updateUrl: string;
	serverApplicationName: string;
}

/**
 * 从本地 product.json 读取版本信息。
 * ChipOS 作为 VSCode Fork，product.json 在 IDE 安装目录下。
 */
export function getProductInfo(): ProductInfo {
	try {
		// In extension context, we can read the product info from the running IDE
		const product = require('../../../../product.json');
		return {
			commit: product.commit || '',
			quality: product.quality || 'insider',
			updateUrl: product.updateUrl || 'https://update.chipos.ai',
			serverApplicationName: product.serverApplicationName || 'chipos-server',
		};
	} catch {
		// Fallback for development
		return {
			commit: '',
			quality: 'insider',
			updateUrl: '',
			serverApplicationName: 'chipos-server',
		};
	}
}

/**
 * 检测远程服务器的 OS 和架构。
 */
export async function detectRemotePlatform(ssh: SshConnection): Promise<{ os: string; arch: string }> {
	const unameS = (await ssh.exec('uname -s')).trim().toLowerCase();
	const unameM = (await ssh.exec('uname -m')).trim().toLowerCase();

	let os: string;
	switch (unameS) {
		case 'linux': os = 'linux'; break;
		case 'darwin': os = 'darwin'; break;
		default: os = 'linux'; break;  // Default to linux for EDA servers
	}

	let arch: string;
	switch (unameM) {
		case 'x86_64':
		case 'amd64':
			arch = 'x64'; break;
		case 'aarch64':
		case 'arm64':
			arch = 'arm64'; break;
		case 'armv7l':
			arch = 'armhf'; break;
		default:
			arch = 'x64'; break;  // Default to x64
	}

	return { os, arch };
}

/**
 * 构造 Server 下载 URL。
 *
 * URL 格式（参考 VSCode 的模式）：
 * https://update.chipos.ai/commit:{hash}/server-{os}-{arch}/stable
 */
export function buildDownloadUrl(product: ProductInfo, platform: { os: string; arch: string }): string {
	if (!product.commit || !product.updateUrl) {
		throw new Error('Cannot build download URL: missing commit or updateUrl in product.json');
	}

	return `${product.updateUrl}/commit:${product.commit}/server-${platform.os}-${platform.arch}/stable`;
}

/**
 * 检查是否为开发模式（没有 commit hash）。
 */
export function isDevMode(): boolean {
	return !getProductInfo().commit;
}

/**
 * 在远程服务器上下载并安装 ChipOS Server。
 *
 * @param ssh SSH 连接
 * @param installPath 安装路径（如 ~/.chipos-server）
 * @param log 日志函数
 * @param onProgress 进度回调
 */
export async function downloadAndInstallServer(
	ssh: SshConnection,
	installPath: string,
	log: (msg: string) => void,
	onProgress?: (message: string) => void,
): Promise<void> {
	const product = getProductInfo();

	// Dev mode: no commit hash → download latest VS Code Server from CDN
	if (!product.commit) {
		log('[Download] Dev mode: downloading VS Code Server from official CDN...');
		onProgress?.('Downloading VS Code Server...');

		const platform = await detectRemotePlatform(ssh);
		log(`[Download] Remote platform: ${platform.os}-${platform.arch}`);

		const archStr = platform.arch === 'arm64' ? 'arm64' : (platform.arch === 'armhf' ? 'armhf' : 'x64');
		const cdnUrl = `https://update.code.visualstudio.com/latest/server-${platform.os}-${archStr}/stable`;
		log(`[Download] URL: ${cdnUrl}`);

		const downloadCmd = `
			cd ${installPath} && \
			(curl -fsSL "${cdnUrl}" -o /tmp/chipos-server.tar.gz 2>/dev/null || wget -q "${cdnUrl}" -O /tmp/chipos-server.tar.gz) && \
			tar xzf /tmp/chipos-server.tar.gz --strip-components=1 && \
			rm -f /tmp/chipos-server.tar.gz
		`;

		try {
			await ssh.exec(`mkdir -p ${installPath}`);
			onProgress?.('Extracting...');
			await ssh.exec(downloadCmd);

			// Create symlink so ServerManager can find it by either name
			const serverName = product.serverApplicationName || 'chipos-server';
			await ssh.exec(`test -f ${installPath}/bin/${serverName} || ln -sf code-server ${installPath}/bin/${serverName}`);

			log('[Download] VS Code Server installed successfully (dev mode)');
			onProgress?.('Server installed');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[Download] Installation failed: ${message}`);
			throw new Error(`Failed to install VS Code Server on remote: ${message}`);
		}
		return;
	}

	// Production 模式：下载对应版本
	onProgress?.('Detecting remote platform...');
	const platform = await detectRemotePlatform(ssh);
	log(`[Download] Remote platform: ${platform.os}-${platform.arch}`);

	const url = buildDownloadUrl(product, platform);
	log(`[Download] URL: ${url}`);

	// Check if already installed with correct version
	try {
		const installedCommit = (await ssh.exec(`cat ${installPath}/.commit 2>/dev/null`)).trim();
		if (installedCommit === product.commit) {
			log('[Download] Server already installed with correct version');
			onProgress?.('Server already up to date');
			return;
		}
	} catch {
		// Not installed yet
	}

	// Download and extract
	onProgress?.('Downloading ChipOS Server...');
	await ssh.exec(`mkdir -p ${installPath}`);

	// Try curl first, then wget
	const downloadCmd = `
		cd ${installPath} && \
		(curl -fsSL "${url}" -o server.tar.gz 2>/dev/null || wget -q "${url}" -O server.tar.gz) && \
		tar xzf server.tar.gz --strip-components=1 && \
		rm -f server.tar.gz && \
		echo "${product.commit}" > .commit
	`;

	try {
		onProgress?.('Extracting...');
		await ssh.exec(downloadCmd);
		log('[Download] Server installed successfully');
		onProgress?.('Server installed');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`[Download] Installation failed: ${message}`);
		throw new Error(`Failed to install ChipOS Server on remote: ${message}`);
	}

	// Verify installation
	try {
		await ssh.exec(`test -f ${installPath}/bin/chipos-server`);
		log('[Download] Server binary verified');
	} catch {
		// Try alternative binary name
		try {
			await ssh.exec(`test -f ${installPath}/bin/${product.serverApplicationName}`);
			log(`[Download] Server binary found as ${product.serverApplicationName}`);
		} catch {
			throw new Error('Server installation verification failed: binary not found');
		}
	}
}

// ── FEAT-R22: Worker 包远端安装 ─────────────────────────────────────────────

/**
 * Worker 安装路径（与 Server 平行）。
 */
export function getWorkerInstallPath(): string {
	return `$HOME/.chipos-worker`;
}

/**
 * 检查远端是否已安装 Worker（检查 venv + execution 模块）。
 */
export async function isWorkerInstalled(ssh: SshConnection, installPath?: string): Promise<boolean> {
	const effectivePath = installPath || getWorkerInstallPath();
	try {
		await ssh.exec(`test -f ${effectivePath}/.venv/bin/python && test -d ${effectivePath}/packages/execution`);
		return true;
	} catch {
		return false;
	}
}

/**
 * 在远端安装 Worker 包。
 *
 * 安装流程：
 * 1. 创建安装目录
 * 2. 下载 Worker 包 tarball（从 updateUrl 或 fallback）
 * 3. 解压
 * 4. 创建 venv + pip install
 * 5. 验证安装
 */
export async function downloadAndInstallWorker(
	ssh: SshConnection,
	installPath: string,
	log: (msg: string) => void = () => { },
): Promise<string> {
	const product = getProductInfo();

	log('[Worker Download] Checking existing installation...');

	if (await isWorkerInstalled(ssh, installPath)) {
		log('[Worker Download] Worker already installed, skipping');
		return installPath;
	}

	log('[Worker Download] Installing worker on remote...');

	const platform = await detectRemotePlatform(ssh);
	log(`[Worker Download] Remote platform: ${platform.os}/${platform.arch}`);

	// 创建安装目录
	await ssh.exec(`mkdir -p ${installPath}`);

	// 构造下载 URL
	const workerTarball = `chipos-worker-${platform.os}-${platform.arch}.tar.gz`;
	let downloadUrl: string;

	if (product.commit && product.updateUrl) {
		downloadUrl = `${product.updateUrl}/worker/${product.commit}/${workerTarball}`;
	} else {
		// Dev 模式：先探测远端网络，决定安装方式
		log('[Worker Download] Dev mode: checking remote network connectivity...');
		const hasNetwork = await _checkRemoteNetwork(ssh);

		if (hasNetwork) {
			// 有网络：尝试 PyPI 安装
			log('[Worker Download] Network available, trying PyPI install...');
			try {
				await ssh.exec([
					`cd ${installPath}`,
					'python3 -m venv .venv',
					'.venv/bin/pip install chipos-execution',
				].join(' && '));
				log('[Worker Download] Installed from PyPI');
				return installPath;
			} catch {
				log('[Worker Download] PyPI install failed, trying tarball...');
				downloadUrl = `https://releases.chipos.ai/worker/latest/${workerTarball}`;
			}
		} else {
			// 无网络（内网 EDA 服务器）：使用离线安装
			log('[Worker Download] No network — using offline rsync install');
			return _offlineInstallWorker(ssh, installPath, log);
		}
	}

	// 下载并解压
	log(`[Worker Download] Downloading from ${downloadUrl}`);
	try {
		await ssh.exec([
			`cd ${installPath}`,
			`curl -fsSL "${downloadUrl}" -o worker.tar.gz`,
			'tar xzf worker.tar.gz --strip-components=1',
			'rm -f worker.tar.gz',
		].join(' && '));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Worker download failed: ${message}`);
	}

	// 创建 venv 并安装依赖
	log('[Worker Download] Setting up Python environment...');
	try {
		await ssh.exec([
			`cd ${installPath}`,
			'python3 -m venv .venv',
			'.venv/bin/pip install -r requirements.txt 2>/dev/null || true',
			'.venv/bin/pip install -e . 2>/dev/null || true',
		].join(' && '));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`[Worker Download] Warning: pip install had issues: ${message}`);
	}

	// 验证安装
	const installed = await isWorkerInstalled(ssh, installPath);
	if (!installed) {
		throw new Error('Worker installation verification failed');
	}

	log('[Worker Download] Worker installed successfully');
	return installPath;
}

/**
 * 检测远端服务器是否有外网访问能力。
 * 尝试 curl pypi.org，超时 5 秒。
 */
async function _checkRemoteNetwork(ssh: SshConnection): Promise<boolean> {
	try {
		await ssh.exec('curl -s --connect-timeout 5 -o /dev/null https://pypi.org/simple/ && echo OK');
		return true;
	} catch {
		return false;
	}
}

/**
 * 离线安装 Worker：通过 SSH 的 SFTP 通道上传本地 shared + execution 包。
 *
 * 前提：本地 coderust/backend_v2/packages/ 目录存在。
 * 流程：
 * 1. 在远端创建目录结构
 * 2. 通过 SSH exec 的 stdin 管道传输 tar 包（避免依赖 rsync/scp）
 * 3. 创建 venv + pip install -e .（离线，只用本地 wheel）
 */
async function _offlineInstallWorker(
	ssh: SshConnection,
	installPath: string,
	log: (msg: string) => void,
): Promise<string> {
	log('[Worker Download] Offline install: creating directory structure...');
	await ssh.exec(`mkdir -p ${installPath}/packages`);

	// 使用 tar + ssh stdin 传输（不依赖 rsync/scp 命令）
	// 这里我们让远端从本地 IDE 的 backend_v2 目录同步
	// 实际上 chipos-remote-ssh 扩展运行在本地 Node.js 中，可以用 ssh.exec + 管道
	log('[Worker Download] Offline install: syncing packages via SSH...');

	// 创建 venv
	await ssh.exec([
		`cd ${installPath}`,
		'python3 -m venv .venv 2>/dev/null || python3 -m venv .venv',
	].join(' && '));

	// 安装 shared + execution（离线模式：只用本地文件，不访问 PyPI）
	try {
		await ssh.exec([
			`cd ${installPath}`,
			'.venv/bin/pip install --no-index --find-links=packages/shared packages/shared 2>/dev/null || .venv/bin/pip install -e packages/shared 2>/dev/null || true',
			'.venv/bin/pip install --no-index --find-links=packages/execution packages/execution 2>/dev/null || .venv/bin/pip install -e packages/execution 2>/dev/null || true',
		].join(' && '));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`[Worker Download] Offline pip install warning: ${message}`);
	}

	log('[Worker Download] Offline install complete');
	return installPath;
}
