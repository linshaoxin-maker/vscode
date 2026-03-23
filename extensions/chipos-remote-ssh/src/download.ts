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

	// Dev 模式：没有 commit hash，不下载，使用本地开发 server
	if (!product.commit) {
		log('[Download] Dev mode detected (no commit hash). Skipping download.');
		log('[Download] Please manually install ChipOS Server on the remote machine.');
		onProgress?.('Dev mode: manual server installation required');

		// Create a placeholder script that tells the user what to do
		await ssh.exec(`mkdir -p ${installPath}/bin`);
		await ssh.exec(`cat > ${installPath}/bin/chipos-server << 'EOF'
#!/bin/bash
echo "ChipOS Server (dev mode)"
echo "Please install the server manually or build from source."
echo "See: https://github.com/chipos/coderust/blob/main/docs/plan/reasoning-execution-split/developer-journey-packages.md"
exit 1
EOF`);
		await ssh.exec(`chmod +x ${installPath}/bin/chipos-server`);
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
