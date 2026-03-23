/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ServerManager — 管理远程 ChipOS Server 的生命周期。
 *
 * 职责：
 * 1. 检查远程是否已安装 ChipOS Server
 * 2. 如果没有，自动安装（下载/解压）
 * 3. 启动 Server 进程
 * 4. 监听 stdout 等待 "listening on port XXXX" 输出
 * 5. 返回端口号和 connectionToken
 * 6. 停止 Server
 */

import * as crypto from 'crypto';
import { SshConnection } from './sshConnection';
import { getProductInfo, detectRemotePlatform, downloadAndInstallServer, isDevMode } from './download';

export interface ServerInfo {
	port: number;
	connectionToken: string;
}

export class ServerManager {

	private _serverRunning = false;

	constructor(
		private readonly _ssh: SshConnection,
		private readonly _installPath: string,
		private readonly _log: (msg: string) => void,
	) { }

	/**
	 * Ensure ChipOS Server is running on the remote machine.
	 * If not installed, install it first. If not running, start it.
	 *
	 * Returns the port and connection token.
	 */
	async ensureServerRunning(): Promise<ServerInfo> {
		// 1. Check if server is already installed
		const installed = await this._isServerInstalled();
		if (!installed) {
			this._log('[ServerManager] ChipOS Server not found on remote, installing...');
			await this._installServer();
		}

		// 2. Check if server is already running
		const existingInfo = await this._checkExistingServer();
		if (existingInfo) {
			this._log(`[ServerManager] Server already running on port ${existingInfo.port}`);
			this._serverRunning = true;
			return existingInfo;
		}

		// 3. Start server
		this._log('[ServerManager] Starting ChipOS Server on remote...');
		const info = await this._startServer();
		this._serverRunning = true;
		return info;
	}

	/**
	 * Stop the remote server.
	 */
	async stopServer(): Promise<void> {
		if (!this._serverRunning) {
			return;
		}

		try {
			await this._ssh.exec(`pkill -f "chipos-server" || true`);
			this._serverRunning = false;
			this._log('[ServerManager] Server stopped');
		} catch (err) {
			this._log(`[ServerManager] Error stopping server: ${err}`);
		}
	}

	// ── Private ─────────────────────────────────────────────────────────

	private async _isServerInstalled(): Promise<boolean> {
		try {
			const result = await this._ssh.exec(`test -f ${this._installPath}/bin/chipos-server && echo "yes" || echo "no"`);
			return result.trim() === 'yes';
		} catch {
			return false;
		}
	}

	private async _checkExistingServer(): Promise<ServerInfo | undefined> {
		try {
			// Check if there's a PID file with server info
			const result = await this._ssh.exec(`cat ${this._installPath}/.server-info 2>/dev/null || echo ""`);
			if (!result.trim()) {
				return undefined;
			}

			// Parse server info: "port:token"
			const [portStr, token] = result.trim().split(':');
			const port = parseInt(portStr, 10);
			if (isNaN(port) || !token) {
				return undefined;
			}

			// Verify server is actually responding
			const alive = await this._ssh.exec(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/version 2>/dev/null || echo "000"`);
			if (alive.trim() !== '200') {
				return undefined;
			}

			return { port, connectionToken: token };
		} catch {
			return undefined;
		}
	}

	private async _installServer(): Promise<void> {
		await downloadAndInstallServer(this._ssh, this._installPath, this._log);
		this._log('[ServerManager] Server installation complete');
	}

	private async _startServer(): Promise<ServerInfo> {
		const connectionToken = crypto.randomBytes(16).toString('hex');
		const product = getProductInfo();

		let startCmd: string;

		if (!product.commit) {
			// Dev 模式：使用 code-server.sh（类似 vscode-test-resolver 的做法）
			// 在 dev 模式下，server 代码在源码树中，不需要下载
			this._log('[ServerManager] Dev mode: using local server script');
			startCmd = [
				`cd ${this._installPath}`,
				`nohup bash -c "`,
				`  export VSCODE_AGENT_FOLDER=${this._installPath}`,
				`  node server.js`,
				`  --connection-token ${connectionToken}`,
				`  --host 127.0.0.1`,
				`  --port 0`,
				`  --without-browser-env-var`,
				`" > ${this._installPath}/.server.log 2>&1 &`,
			].join(' ');
		} else {
			// Production 模式：使用下载的 server binary
			const serverBin = `${this._installPath}/bin/${product.serverApplicationName || 'chipos-server'}`;
			startCmd = [
				`cd ${this._installPath}`,
				`nohup ${serverBin}`,
				`--connection-token ${connectionToken}`,
				`--host 127.0.0.1`,
				`--port 0`,
				`--without-browser-env-var`,
				`--accept-server-license-terms`,
				`> ${this._installPath}/.server.log 2>&1 &`,
			].join(' ');
		}

		await this._ssh.exec(startCmd);

		// Wait for server to start and report its port
		const port = await this._waitForServerPort(connectionToken);

		// Save server info for reconnection
		await this._ssh.exec(`echo "${port}:${connectionToken}" > ${this._installPath}/.server-info`);

		return { port, connectionToken };
	}

	private async _waitForServerPort(token: string): Promise<number> {
		const maxAttempts = 30;  // 30 seconds timeout
		const intervalMs = 1000;

		for (let i = 0; i < maxAttempts; i++) {
			await new Promise(resolve => setTimeout(resolve, intervalMs));

			try {
				const logContent = await this._ssh.exec(`tail -20 ${this._installPath}/.server.log 2>/dev/null || echo ""`);

				// Look for the port announcement in the log
				// VS Code Server outputs: "Extension host agent listening on <port>"
				const portMatch = logContent.match(/Extension host agent listening on (\d+)/);
				if (portMatch) {
					return parseInt(portMatch[1], 10);
				}

				// Also check for error
				if (logContent.includes('EADDRINUSE') || logContent.includes('Error:')) {
					throw new Error(`Server failed to start: ${logContent.substring(0, 200)}`);
				}
			} catch (err) {
				if (i === maxAttempts - 1) {
					throw err;
				}
			}
		}

		throw new Error(`Server did not start within ${maxAttempts} seconds`);
	}
}
