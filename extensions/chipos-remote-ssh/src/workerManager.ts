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
	/** 远端实际可用的 Python 命令（由 _checkPythonEnv 探测） */
	private _pythonCmd: string = 'python3.11';
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
	async ensureWorkerRunning(reasonerGrpcTarget: string, workspacePath?: string): Promise<void> {
		this._log('[WorkerManager] Ensuring worker is running...');
		this._log(`[WorkerManager] installPath=${this._installPath}, grpcTarget=${reasonerGrpcTarget}`);

		// 1. 检查 Python 环境
		this._log('[WorkerManager] Step 1/5: Checking Python environment...');
		await this._checkPythonEnv();

		// 2. 检查 Worker 包是否已安装
		this._log('[WorkerManager] Step 2/5: Checking if Worker is installed...');
		const installed = await this._isWorkerInstalled();
		this._log(`[WorkerManager] Worker installed: ${installed}`);
		if (!installed) {
			this._log('[WorkerManager] Worker not installed, installing...');
			await downloadAndInstallWorker(this._ssh, this._installPath, this._log);
		}

		// 3. 检查已有进程
		this._log('[WorkerManager] Step 3/5: Checking existing PID...');
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
		this._log('[WorkerManager] Step 4/5: Starting Worker...');
		await this._startWorker(reasonerGrpcTarget, workspacePath);

		// 5. 等待健康检查通过
		this._log('[WorkerManager] Step 5/5: Waiting for health check...');
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
	 * 按优先级探测: python3.11 → python3.12 → python3.10 → python3
	 * 找到的命令存入 this._pythonCmd，后续 venv/启动都用它。
	 * 如果全部探测失败，尝试自动安装 python3.11。
	 */
	private async _checkPythonEnv(): Promise<void> {
		const candidates = ['python3.11', 'python3.12', 'python3.10', 'python3'];
		for (const cmd of candidates) {
			try {
				const result = await this._ssh.exec(`${cmd} --version`);
				const match = result.match(/Python (\d+)\.(\d+)/);
				if (match) {
					const major = parseInt(match[1], 10);
					const minor = parseInt(match[2], 10);
					if (major >= 3 && minor >= 10) {
						this._pythonCmd = cmd;
						this._log(`[WorkerManager] Found ${cmd} → Python ${major}.${minor} ✓`);
						return;
					}
					this._log(`[WorkerManager] ${cmd} → Python ${major}.${minor} (too old, need >=3.10)`);
				}
			} catch {
				// cmd not found, try next
			}
		}

		// 没有找到合适的 Python，尝试自动安装
		this._log('[WorkerManager] Python >= 3.10 not found, attempting auto-install...');
		try {
			await this._autoInstallPython();
			return;
		} catch (installErr) {
			const msg = installErr instanceof Error ? installErr.message : String(installErr);
			throw new Error(
				'Python >= 3.10 not found on remote. Tried: ' + candidates.join(', ') +
				'. Auto-install also failed: ' + msg +
				'. Please install Python 3.10+ manually on the remote server.'
			);
		}
	}

	/**
	 * 尝试在远端自动安装 Python 3.11。
	 * 支持 apt (Debian/Ubuntu) 和 yum/dnf (CentOS/RHEL)。
	 */
	private async _autoInstallPython(): Promise<void> {
		// 检测包管理器
		let pkgManager: 'apt' | 'yum' | 'dnf' | null = null;
		for (const pm of ['apt', 'dnf', 'yum'] as const) {
			try {
				await this._ssh.exec(`which ${pm}`);
				pkgManager = pm;
				break;
			} catch {
				// not found
			}
		}

		if (!pkgManager) {
			throw new Error('No supported package manager found (apt/dnf/yum)');
		}

		this._log(`[WorkerManager] Detected package manager: ${pkgManager}`);

		if (pkgManager === 'apt') {
			// Debian/Ubuntu: 先尝试直接安装，失败则添加 deadsnakes PPA
			try {
				await this._ssh.exec('apt-get update -qq && apt-get install -y -qq python3.11 python3.11-venv 2>&1');
				this._log('[WorkerManager] python3.11 installed via apt');
			} catch {
				this._log('[WorkerManager] Direct apt install failed, trying deadsnakes PPA...');
				await this._ssh.exec(
					'apt-get install -y -qq software-properties-common && ' +
					'add-apt-repository -y ppa:deadsnakes/ppa && ' +
					'apt-get update -qq && ' +
					'apt-get install -y -qq python3.11 python3.11-venv 2>&1'
				);
				this._log('[WorkerManager] python3.11 installed via deadsnakes PPA');
			}
		} else {
			// CentOS/RHEL
			await this._ssh.exec(`${pkgManager} install -y python3.11 2>&1`);
			this._log(`[WorkerManager] python3.11 installed via ${pkgManager}`);
		}

		// 验证安装
		const result = await this._ssh.exec('python3.11 --version');
		const match = result.match(/Python (\d+)\.(\d+)/);
		if (match && parseInt(match[1], 10) >= 3 && parseInt(match[2], 10) >= 10) {
			this._pythonCmd = 'python3.11';
			this._log(`[WorkerManager] Auto-installed Python ${match[1]}.${match[2]} ✓`);
		} else {
			throw new Error(`python3.11 installed but version check failed: ${result}`);
		}
	}

	/**
	 * 检查 Worker 包是否已安装。
	 * 优先检查 .venv（R22 安装目标），fallback 检查系统 python3。
	 */
	private async _isWorkerInstalled(): Promise<boolean> {
		try {
			// 检查两种布局：
			// 1. rsync 部署: installPath/packages/execution/.venv/bin/python
			// 2. 独立安装: installPath/.venv/bin/python
			const cmd = [
				`(cd ${this._installPath}/packages/execution 2>/dev/null && .venv/bin/python -c "import execution; print('ok')" 2>/dev/null)`,
				`|| (cd ${this._installPath} 2>/dev/null && .venv/bin/python -c "import execution; print('ok')" 2>/dev/null)`,
			].join(' ');
			this._log(`[WorkerManager] _isWorkerInstalled cmd: ${cmd}`);
			const result = await this._ssh.exec(cmd);
			this._log(`[WorkerManager] _isWorkerInstalled result: "${result.trim()}"`);
			return result.trim() === 'ok';
		} catch (err) {
			this._log(`[WorkerManager] _isWorkerInstalled error: ${err}`);
			return false;
		}
	}

	/**
	 * 启动 Worker 进程（nohup，SSH 断开后存活）。
	 */
	private async _startWorker(grpcTarget: string, workspacePath?: string): Promise<void> {
		const pidFile = `${this._installPath}/worker.pid`;
		const logFile = `${this._installPath}/worker.log`;

		// 探测 venv 位置：rsync 布局 vs pip_wheel 布局
		let workerDir = this._installPath;
		let venvPython = `${this._installPath}/.venv/bin/python`;
		let needPythonPath = false;
		try {
			await this._ssh.exec(`test -f ${this._installPath}/packages/execution/.venv/bin/python`);
			// rsync 布局：需要 PYTHONPATH
			workerDir = `${this._installPath}/packages/execution`;
			venvPython = `${workerDir}/.venv/bin/python`;
			needPythonPath = true;
			this._log(`[WorkerManager] Detected rsync layout, workerDir=${workerDir}`);
		} catch {
			this._log(`[WorkerManager] Using standalone/pip_wheel layout, workerDir=${workerDir}`);
		}

		const envVars = [`CHIPOS_REASONING_SERVER="${grpcTarget}"`];
		if (needPythonPath) {
			// rsync 布局需要 PYTHONPATH 指向 src/ 目录
			const pythonPath = [
				`${this._installPath}/packages/shared/src`,
				`${this._installPath}/packages/execution/src`,
			].join(':');
			envVars.push(`PYTHONPATH="${pythonPath}"`);
		}

		// 启动 Worker 后台进程：
		// 1. 用 bash -c + setsid 彻底脱离 SSH session
		// 2. 不依赖 $! 获取 PID（在 setsid 下不可靠），
		//    而是让启动命令自己用 bash 的 exec 写 PID
		const exportLine = envVars.map(v => `export ${v}`).join('; ');
		const wsArg = workspacePath ? ` --workspace \\"${workspacePath}\\"` : '';
		const mcpConfigArg = ` --mcp-config \\"$HOME/.chipos-worker/mcp_servers.json\\"`;
		const startCmd = [
			`bash -c '${exportLine}; cd ${workerDir};`,
			`setsid bash -c "echo \\$\\$ > ${pidFile};`,
			`exec ${venvPython} -m execution.server.cli start --server \\"${grpcTarget}\\"${wsArg}${mcpConfigArg}`,
			`> ${logFile} 2>&1 < /dev/null" &`,
			`sleep 0.3; exit 0'`,
		].join(' ');

		this._log(`[WorkerManager] _startWorker cmd: ${startCmd}`);
		try {
			await this._ssh.exec(startCmd);
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
		this._log(`[WorkerManager] _waitForHealthy: timeout=${timeoutMs}ms`);
		const start = Date.now();
		let attempt = 0;
		while (Date.now() - start < timeoutMs) {
			attempt++;
			try {
				const result = await this._ssh.exec(
					'curl -sf http://localhost:8081/health'
				);
				this._log(`[WorkerManager] Health check attempt ${attempt}: ${result.trim()}`);
				if (result.includes('"status"')) {
					return;
				}
			} catch (err) {
				this._log(`[WorkerManager] Health check attempt ${attempt} failed: ${err}`);
			}
			await delay(1000);
		}
		this._log(`[WorkerManager] Health check timed out after ${timeoutMs}ms (${attempt} attempts)`);
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
