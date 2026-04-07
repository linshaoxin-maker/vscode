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
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';

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
		// Prefer runtime product metadata from the running client.
		// This avoids packaging a stale product.json and prevents client/server version drift.
		const env = vscode.env as unknown as {
			appRoot?: string;
			appHost?: string;
		};
		const appRoot = env.appRoot;
		const productPath = appRoot ? path.join(appRoot, 'product.json') : undefined;
		const product = (productPath && fs.existsSync(productPath))
			? JSON.parse(fs.readFileSync(productPath, 'utf-8'))
			: require('../../../../product.json');
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
	const vscodeConfig = _tryGetConfig('chipos.remote.ssh', 'workerInstallPath');
	return vscodeConfig || '~/.chipos-worker';
}

function _tryGetConfig(section: string, key: string): string | undefined {
	try {
		// 在扩展上下文中可以访问 vscode API
		const vscode = require('vscode') as { workspace?: { getConfiguration?: (s: string) => { get?: (k: string) => unknown } } };
		const value = vscode.workspace?.getConfiguration?.(section)?.get?.(key);
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 检查远端是否已安装 Worker（检查 venv + execution 模块）。
 */
export async function isWorkerInstalled(ssh: SshConnection, installPath?: string): Promise<boolean> {
	const effectivePath = installPath || getWorkerInstallPath();
	try {
		// 支持两种布局：
		// rsync 布局: installPath/packages/execution/.venv/bin/python
		// 独立安装:   installPath/.venv/bin/python
		await ssh.exec(
			`test -f ${effectivePath}/packages/execution/.venv/bin/python || test -f ${effectivePath}/.venv/bin/python`
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * 在远端安装 Worker 包。
 *
 * Production 模式：从 updateUrl 下载 tarball 安装。
 * Dev 模式（pip_wheel 策略）：
 *   1. 本地 poetry build -f wheel（shared + execution）
 *   2. SSH stdin 管道上传 .whl 到远端
 *   3. 远端 pip install .whl（阿里云镜像加速依赖下载）
 */
export async function downloadAndInstallWorker(
	ssh: SshConnection,
	installPath: string,
	log: (msg: string) => void = () => { },
): Promise<string> {
	const product = getProductInfo();

	log('[Worker Deploy] Checking existing installation...');

	if (await isWorkerInstalled(ssh, installPath)) {
		log('[Worker Deploy] Worker already installed, skipping');
		return installPath;
	}

	log('[Worker Deploy] Installing worker on remote...');

	// 创建安装目录
	await ssh.exec(`mkdir -p ${installPath}`);

	if (product.commit && product.updateUrl) {
		// Production 模式：从 IDE 内嵌的 resources/chipos-worker/ 读取预构建 wheel
		log('[Worker Deploy] Production mode: using embedded wheels');
		await _prodInstallWorkerFromResources(ssh, installPath, log);
	} else {
		// Dev 模式：本地 poetry build → 上传 → 安装
		log('[Worker Deploy] Dev mode: using pip_wheel strategy');
		await _devInstallWorkerViaWheel(ssh, installPath, log);
	}

	// 验证安装
	const installed = await isWorkerInstalled(ssh, installPath);
	if (!installed) {
		throw new Error('Worker installation verification failed');
	}

	log('[Worker Deploy] Worker installed successfully');

	return installPath;
}

// ─── Production 模式：内嵌 wheel 安装 ────────────────────────────────────────

/**
 * Production 模式安装 Worker：
 * 从 IDE 安装包的 resources/chipos-worker/ 读取预构建 wheel，
 * 上传到远端并安装。无需源码和 poetry。
 */
async function _prodInstallWorkerFromResources(
	ssh: SshConnection,
	installPath: string,
	log: (msg: string) => void,
): Promise<void> {
	// 1. 定位 resources/chipos-worker/ 目录
	const resourceDir = path.join(__dirname, '..', 'resources', 'chipos-worker');
	if (!fs.existsSync(resourceDir)) {
		throw new Error(
			`Worker resources not found at ${resourceDir}. Run 'bash vscode/scripts/build-worker-wheels.sh' first.`
		);
	}

	const whlFiles = fs.readdirSync(resourceDir).filter(f => f.endsWith('.whl'));
	if (whlFiles.length === 0) {
		throw new Error(`No .whl files found in ${resourceDir}. Run build-worker-wheels.sh first.`);
	}
	log(`[Worker Deploy] Found ${whlFiles.length} wheel(s) in resources`);

	// 2. 创建远端 venv
	log('[Worker Deploy] Creating remote venv...');
	await ssh.exec(`mkdir -p ${installPath}`);
	try {
		await ssh.exec(`cd ${installPath} && python3.11 -m venv .venv`);
		log('[Worker Deploy] venv created with python3.11');
	} catch {
		// fallback to python3
		await ssh.exec(`cd ${installPath} && python3 -m venv .venv`);
		log('[Worker Deploy] venv created with python3 (fallback)');
	}

	try {
		await ssh.exec(`cd ${installPath} && .venv/bin/pip install --upgrade pip -i ${ALIYUN_MIRROR}`);
	} catch {
		log('[Worker Deploy][WARN] pip upgrade failed (non-fatal)');
	}

	// 3. 上传 wheel 文件
	for (const whl of whlFiles) {
		await _uploadFile(ssh, path.join(resourceDir, whl), `${installPath}/${whl}`, log);
	}

	// 4. 安装 shared wheel（正常安装，依赖都是第三方包）
	const sharedWhl = whlFiles.find(f => f.includes('shared'));
	if (sharedWhl) {
		log('[Worker Deploy] Installing shared wheel...');
		try {
			await ssh.exec(`cd ${installPath} && .venv/bin/pip install ${sharedWhl} -i ${ALIYUN_MIRROR}`);
			log('[Worker Deploy] shared installed');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to install shared wheel: ${msg}`);
		}
	}

	// 5. 安装 execution wheel（--no-deps，避免本地路径依赖问题）
	const executionWhl = whlFiles.find(f => f.includes('execution'));
	if (executionWhl) {
		log('[Worker Deploy] Installing execution wheel (--no-deps)...');
		try {
			await ssh.exec(`cd ${installPath} && .venv/bin/pip install --no-deps ${executionWhl}`);
			log('[Worker Deploy] execution installed (no-deps)');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to install execution wheel: ${msg}`);
		}
	}

	// 6. 从 deps.txt 读取第三方依赖并安装
	const depsFile = path.join(resourceDir, 'deps.txt');
	if (fs.existsSync(depsFile)) {
		const deps = fs.readFileSync(depsFile, 'utf-8')
			.split('\n')
			.map(l => l.trim())
			.filter(l => l && !l.startsWith('#'));

		if (deps.length > 0) {
			log(`[Worker Deploy] Installing ${deps.length} third-party deps from deps.txt`);
			try {
				await ssh.exec([
					`cd ${installPath}`,
					`.venv/bin/pip install -i ${ALIYUN_MIRROR} ${deps.map(d => `"${d}"`).join(' ')}`,
				].join(' && '));
				log('[Worker Deploy] deps installed');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to install dependencies: ${msg}`);
			}
		}
	} else {
		log('[Worker Deploy][WARN] deps.txt not found, skipping third-party deps');
	}

	// 7. 清理远端 .whl 文件
	await ssh.exec(`rm -f ${installPath}/*.whl`);

	// 8. 验证
	log('[Worker Deploy] Verifying installation...');
	try {
		await ssh.exec(
			`cd ${installPath} && .venv/bin/python -c "import execution; import shared; print('ok')"`
		);
		log('[Worker Deploy] Verification passed');
	} catch (verifyErr) {
		const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
		throw new Error(`Installation verification failed: ${msg}`);
	}
}

// ─── Dev 模式：pip_wheel 安装 ───────────────────────────────────────────────

const ALIYUN_MIRROR = 'https://mirrors.aliyun.com/pypi/simple/';

/**
 * Dev 模式安装 Worker：
 * 1. 本地 poetry build -f wheel（shared → execution）
 * 2. 上传 .whl 到远端
 * 3. 远端 pip install .whl
 */
async function _devInstallWorkerViaWheel(
	ssh: SshConnection,
	installPath: string,
	log: (msg: string) => void,
): Promise<void> {
	// 定位本地 backend_v2 目录
	const backendRoot = _findBackendRoot();
	if (!backendRoot) {
		throw new Error(
			'Cannot find backend_v2 directory. Make sure the workspace contains backend_v2/packages/shared and backend_v2/packages/execution.'
		);
	}
	log(`[Worker Deploy] Local backend root: ${backendRoot}`);

	// Step 1: 本地构建 wheel
	const sharedPkgDir = path.join(backendRoot, 'packages', 'shared');
	const executionPkgDir = path.join(backendRoot, 'packages', 'execution');

	log('[Worker Deploy] Building shared wheel...');
	const sharedWhl = _buildWheel(sharedPkgDir, log);

	log('[Worker Deploy] Building execution wheel...');
	const executionWhl = _buildWheel(executionPkgDir, log);

	// Step 2: 远端创建 venv（分步执行，便于定位失败点）
	log('[Worker Deploy] Creating remote venv...');
	await ssh.exec(`mkdir -p ${installPath}`);

	try {
		await ssh.exec(`cd ${installPath} && python3.11 -m venv .venv`);
		log('[Worker Deploy] venv created with python3.11');
	} catch (venvErr) {
		// fallback to python3
		try {
			await ssh.exec(`cd ${installPath} && python3 -m venv .venv`);
			log('[Worker Deploy] venv created with python3 (fallback)');
		} catch (fallbackErr) {
			const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
			throw new Error(`Failed to create venv on remote (tried python3.11 and python3): ${msg}`);
		}
	}

	try {
		await ssh.exec(`cd ${installPath} && .venv/bin/pip install --upgrade pip -i ${ALIYUN_MIRROR}`);
		log('[Worker Deploy] pip upgraded');
	} catch (pipErr) {
		const msg = pipErr instanceof Error ? pipErr.message : String(pipErr);
		log(`[Worker Deploy][WARN] pip upgrade failed (non-fatal): ${msg}`);
	}

	// Step 3: 上传 .whl 文件
	await _uploadFile(ssh, sharedWhl, `${installPath}/${path.basename(sharedWhl)}`, log);
	await _uploadFile(ssh, executionWhl, `${installPath}/${path.basename(executionWhl)}`, log);

	// Step 4: 远端 pip install
	// shared wheel 正常安装（它没有本地路径依赖问题）
	log('[Worker Deploy] Installing shared wheel on remote...');
	try {
		const sharedResult = await ssh.exec(
			`cd ${installPath} && .venv/bin/pip install ${path.basename(sharedWhl)} -i ${ALIYUN_MIRROR}`
		);
		log(`[Worker Deploy] shared installed: ${sharedResult.trim().split('\n').pop()}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install shared wheel: ${msg}`);
	}

	// execution wheel 必须用 --no-deps 安装：
	// poetry build 会把 chipos-shared = {path = "../shared"} 写进 wheel metadata，
	// 远端 pip 会尝试访问本地 Mac 路径 /Users/.../backend_v2/packages/shared 导致失败。
	// 策略：--no-deps 装 execution 代码，再从 pyproject.toml 提取第三方依赖单独装。
	log('[Worker Deploy] Installing execution wheel on remote (--no-deps)...');
	try {
		await ssh.exec(
			`cd ${installPath} && .venv/bin/pip install --no-deps ${path.basename(executionWhl)}`
		);
		log('[Worker Deploy] execution package installed (no-deps)');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install execution wheel: ${msg}`);
	}

	// 从本地 pyproject.toml 提取 execution 的第三方依赖，排除 chipos-shared
	const thirdPartyDeps = _extractThirdPartyDeps(
		path.join(backendRoot, 'packages', 'execution', 'pyproject.toml')
	);
	if (thirdPartyDeps.length > 0) {
		log(`[Worker Deploy] Installing ${thirdPartyDeps.length} third-party deps: ${thirdPartyDeps.join(', ')}`);
		try {
			const depsResult = await ssh.exec([
				`cd ${installPath}`,
				`.venv/bin/pip install -i ${ALIYUN_MIRROR} ${thirdPartyDeps.map(d => `"${d}"`).join(' ')}`,
			].join(' && '));
			log(`[Worker Deploy] deps installed: ${depsResult.trim().split('\n').pop()}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to install execution dependencies: ${msg}`);
		}
	}

	// 清理远端 .whl 文件
	await ssh.exec(`rm -f ${installPath}/*.whl`);

	// Step 5: 验证安装——确认 execution 模块可以 import
	log('[Worker Deploy] Verifying installation...');
	try {
		await ssh.exec(
			`cd ${installPath} && .venv/bin/python -c "import execution; import shared; print('ok')"`
		);
		log('[Worker Deploy] Verification passed: execution + shared importable');
	} catch (verifyErr) {
		const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
		throw new Error(`Installation verification failed — modules not importable: ${msg}`);
	}

	log('[Worker Deploy] pip_wheel install complete');
}

/**
 * 在指定包目录下执行 poetry build -f wheel，返回生成的 .whl 文件路径。
 */
function _buildWheel(pkgDir: string, log: (msg: string) => void): string {
	const distDir = path.join(pkgDir, 'dist');

	// 清理旧的 dist
	if (fs.existsSync(distDir)) {
		for (const f of fs.readdirSync(distDir)) {
			fs.unlinkSync(path.join(distDir, f));
		}
	}

	// 执行 poetry build
	try {
		childProcess.execSync('poetry build -f wheel', {
			cwd: pkgDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 120_000,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`poetry build failed in ${pkgDir}: ${message}`);
	}

	// 找到生成的 .whl 文件
	if (!fs.existsSync(distDir)) {
		throw new Error(`dist directory not found after build: ${distDir}`);
	}
	const whlFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.whl'));
	if (whlFiles.length === 0) {
		throw new Error(`No .whl file found in ${distDir}`);
	}

	const whlPath = path.join(distDir, whlFiles[0]);
	log(`[Worker Deploy] Built: ${whlPath} (${(fs.statSync(whlPath).size / 1024).toFixed(1)} KB)`);
	return whlPath;
}

/**
 * 通过 SSH stdin 管道上传本地文件到远端，并验证大小一致。
 */
async function _uploadFile(ssh: SshConnection, localPath: string, remotePath: string, log: (msg: string) => void): Promise<void> {
	const data = fs.readFileSync(localPath);
	const localSize = data.length;
	log(`[Worker Deploy] Uploading ${path.basename(localPath)} (${(localSize / 1024 / 1024).toFixed(1)} MB)...`);

	await ssh.execWithStdin(`cat > ${remotePath}`, data);

	// 验证远端文件大小
	try {
		const result = await ssh.exec(`stat -c%s ${remotePath} 2>/dev/null || stat -f%z ${remotePath}`);
		const remoteSize = parseInt(result.trim(), 10);
		if (Math.abs(remoteSize - localSize) > 0) {
			throw new Error(`Size mismatch: local=${localSize}, remote=${remoteSize}`);
		}
		log(`[Worker Deploy] Upload verified: ${remoteSize} bytes`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Upload verification failed for ${path.basename(localPath)}: ${msg}`);
	}
}

/**
 * 定位本地 backend_v2 目录。
 * 从扩展所在目录向上查找，或从 workspace 根目录查找。
 */
/**
 * 从 pyproject.toml 提取第三方依赖（排除本地路径依赖如 chipos-shared）。
 * 返回 pip install 可用的依赖字符串列表，如 ["grpcio>=1.60.0", "aiohttp>=3.13.3"]。
 */
function _extractThirdPartyDeps(pyprojectPath: string): string[] {
	if (!fs.existsSync(pyprojectPath)) {
		return [];
	}

	const content = fs.readFileSync(pyprojectPath, 'utf-8');
	const deps: string[] = [];

	// 匹配 [tool.poetry.dependencies] 段落
	const depsMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
	if (!depsMatch) {
		return [];
	}

	const depsSection = depsMatch[1];
	for (const line of depsSection.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) { continue; }

		// 跳过 python 版本约束
		if (trimmed.startsWith('python')) { continue; }

		// 跳过本地路径依赖（如 chipos-shared = {path = "../shared", ...}）
		if (trimmed.includes('path =') || trimmed.includes('path=')) { continue; }

		// 解析简单依赖：name = "^1.26.0" 或 name = ">=1.60.0"
		const simpleMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
		if (simpleMatch) {
			const [, name, version] = simpleMatch;
			// 转换 poetry 版本语法到 pip 语法
			const pipVersion = version.startsWith('^')
				? `>=${version.slice(1)}`
				: version;
			deps.push(`${name}${pipVersion}`);
			continue;
		}

		// 解析 inline table：name = {version = ">=1.60.0", ...}（非 path 依赖）
		const tableMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/);
		if (tableMatch) {
			const [, name, version] = tableMatch;
			const pipVersion = version.startsWith('^')
				? `>=${version.slice(1)}`
				: version;
			deps.push(`${name}${pipVersion}`);
		}
	}

	return deps;
}

function _findBackendRoot(): string | undefined {
	// 尝试从 __dirname 向上查找
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, 'backend_v2');
		if (fs.existsSync(path.join(candidate, 'packages', 'shared')) &&
			fs.existsSync(path.join(candidate, 'packages', 'execution'))) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}

	// 尝试 workspace folders
	try {
		const vscode = require('vscode');
		const folders = vscode.workspace.workspaceFolders;
		if (folders) {
			for (const folder of folders) {
				const candidate = path.join(folder.uri.fsPath, 'backend_v2');
				if (fs.existsSync(path.join(candidate, 'packages', 'shared')) &&
					fs.existsSync(path.join(candidate, 'packages', 'execution'))) {
					return candidate;
				}
			}
		}
	} catch {
		// vscode module not available (e.g. in tests)
	}

	return undefined;
}
