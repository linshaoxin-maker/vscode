/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R21: WorkerManager — 远端 Worker 生命周期管理。
 *
 * 与 ServerManager 平行，管理远端 Execution Worker 的安装/启动/停止/健康检查。
 *
 * 职责：
 * 1. 检查远端 Python 环境（>= 3.10）
 * 2. 检查 Worker 包是否已安装，未安装则调用 downloadAndInstallWorker()
 * 3. 启动 Worker 进程（nohup，SSH 断开后存活）
 * 4. 等待 Worker 健康检查通过（HTTP /health）
 * 5. 停止 Worker 进程
 */

import { SshConnection } from './sshConnection';
import { downloadAndInstallWorker } from './download';

export class WorkerManager {

	private readonly _ssh: SshConnection;
	private readonly _installPath: string;
	private readonly _log: (msg: string) => void;
	private _workerPid: number | null = null;

	constructor(ssh: SshConnection, installPath: string, log: (msg: string) => void) {
		this._ssh = ssh;
		this._installPath = installPath;
		this._log = log;
	}

	get workerPid(): number | null {
		return this._workerPid;
	}

	/**
	 * 确保远端 Worker 正在运行。
	 *
	 * 流程：
	 * 1. 检查 Python 环境（python3 --version >= 3.10）
	 * 2. 检查 Worker 包是否已安装
	 * 3. 如未安装，调用 downloadAndInstallWorker()
	 * 4. 检查是否已有 Worker 进程在跑（PID 文件）
	 * 5. 启动 Worker（nohup）
	 * 6. 等待 Worker 健康检查通过
	 */
	async ensureWorkerRunning(reasonerGrpcTarget: string): Promise<void> {
		this._log('[WorkerManager] Ensuring worker is running...');

		// 1. 检查 Python 环境
		await this._checkPythonEnv();

		// 2. 检查 Worker 包是否已安装
		const installed = await this._isWorkerInstalled();
		if (!installed) {
			this._log('[WorkerManager] Worker not installed, installing...');
			await downloadAndInstallWorker(this._ssh, this._installPath, this._log);
		}

		// 3. 检查已有进程
		const existingPid = await this._readPidFile();
		if (existingPid) {
			const alive = await this._isProcessAlive(existingPid);
			if (alive) {
				this._log(`[WorkerManager] Worker already running (PID=${existingPid})`);
				this._workerPid = existingPid;
				await this._waitForHealthy();
				return;
			}
			this._log(`[WorkerManager] Stale PID file (PID=${existingPid}), cleaning up`);
			await this._removePidFile();
		}

		// 4. 启动 Worker
		await this._startWorker(reasonerGrpcTarget);

		// 5. 等待健康检查通过
		await this._waitForHealthy();
		this._log('[WorkerManager] Worker is healthy');
	}

	/**
	 * 停止远端 Worker 进程。
	 *
	 * 流程：
	 * 1. 发送 SIGTERM
	 * 2. 等待进程退出（最多 5 秒）
	 * 3. 如果还活着，发送 SIGKILL
	 * 4. 清理 PID 文件
	 */
	async stopWorker(): Promise<void> {
		if (!this._workerPid) {
			this._log('[WorkerManager] No worker PID, nothing to stop');
			return;
		}

		this._log(`[WorkerManager] Stopping worker (PID=${this._workerPid})...`);

		try {
			await this._ssh.exec(`kill ${this._workerPid} 2>/dev/null || true`);

			// 等待退出（最多 5 秒）
			for (let i = 0; i < 10; i++) {
				await delay(500);
				if (!await this._isProcessAlive(this._workerPid)) {
					break;
				}
				if (i === 9) {
					this._log('[WorkerManager] Worker did not exit, sending SIGKILL');
					await this._ssh.exec(`kill -9 ${this._workerPid} 2>/dev/null || true`);
				}
			}
		} catch {
			// Best effort
		}

		await this._removePidFile();
		this._workerPid = null;
		this._log('[WorkerManager] Worker stopped');
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * 检查远端 Python 版本 >= 3.10。
	 */
	private async _checkPythonEnv(): Promise<void> {
		try {
			const result = await this._ssh.exec('python3 --version');
			const match = result.match(/Python (\d+)\.(\d+)/);
			if (match) {
				const major = parseInt(match[1], 10);
				const minor = parseInt(match[2], 10);
				if (major < 3 || (major === 3 && minor < 10)) {
					throw new Error(`Python 3.10+ required, got Python ${major}.${minor}`);
				}
				this._log(`[WorkerManager] Python ${major}.${minor} OK`);
			} else {
				this._log('[WorkerManager] Could not parse Python version, proceeding');
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes('required')) {
				throw err;
			}
			throw new Error(`Python 3 not found on remote: ${err}`);
		}
	}

	/**
	 * 检查 Worker 包是否已安装。
	 * 优先检查 .venv（R22 安装目标），fallback 检查系统 python3。
	 */
	private async _isWorkerInstalled(): Promise<boolean> {
		try {
			// 优先检查 .venv/bin/python（R22 downloadAndInstallWorker 的安装目标）
			const result = await this._ssh.exec(
				`cd ${this._installPath} && .venv/bin/python -c "import execution; print('ok')" 2>/dev/null`
			);
			return result.trim() === 'ok';
		} catch {
			return false;
		}
	}

	/**
	 * 启动 Worker 进程（nohup，SSH 断开后存活）。
	 */
	private async _startWorker(grpcTarget: string): Promise<void> {
		const pidFile = `${this._installPath}/worker.pid`;
		const logFile = `${this._installPath}/worker.log`;

		// Fix2: 环境变量名必须是 CHIPOS_REASONING_SERVER（WorkerConfig.from_env 读这个）
		// Fix3: 用 export 确保子进程能继承；nohup 命令和重定向在同一行
		// Bug fix: 用 .venv/bin/python（R22 安装目标），不用系统 python3
		const venvPython = `${this._installPath}/.venv/bin/python`;
		const cmd = [
			`cd ${this._installPath}`,
			`export CHIPOS_REASONING_SERVER="${grpcTarget}"`,
			`nohup ${venvPython} -m execution.server.cli start --server "${grpcTarget}" > ${logFile} 2>&1 & echo $! > ${pidFile}`,
		].join(' && ');

		try {
			await this._ssh.exec(cmd);
		} catch (err) {
			throw new Error(`Failed to start worker: ${err}`);
		}

		this._workerPid = await this._readPidFile();
		if (!this._workerPid) {
			throw new Error('Worker started but PID file not found');
		}
		this._log(`[WorkerManager] Worker started (PID=${this._workerPid})`);
	}

	/**
	 * 等待 Worker 健康检查通过（HTTP /health）。
	 */
	private async _waitForHealthy(timeoutMs: number = 30000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const result = await this._ssh.exec(
					'curl -sf http://localhost:8081/health'
				);
				if (result.includes('"status"')) {
					return;
				}
			} catch {
				// Not ready yet
			}
			await delay(1000);
		}
		throw new Error('Worker health check timed out');
	}

	private async _readPidFile(): Promise<number | null> {
		const pidFile = `${this._installPath}/worker.pid`;
		try {
			const content = (await this._ssh.exec(`cat ${pidFile} 2>/dev/null`)).trim();
			const pid = parseInt(content, 10);
			return isNaN(pid) ? null : pid;
		} catch {
			return null;
		}
	}

	private async _removePidFile(): Promise<void> {
		try {
			await this._ssh.exec(`rm -f ${this._installPath}/worker.pid`);
		} catch {
			// ignore
		}
	}

	private async _isProcessAlive(pid: number): Promise<boolean> {
		try {
			const result = await this._ssh.exec(
				`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`
			);
			return result.trim() === 'alive';
		} catch {
			return false;
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
