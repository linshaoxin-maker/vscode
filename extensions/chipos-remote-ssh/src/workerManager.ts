/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R21 + R48 + R51: WorkerManager — 远端 Worker 生命周期管理。
 *
 * 职责：
 * 1. 优先使用二进制 Worker（~/.chipos/workers/{version}/）
 * 2. 支持远端双模式部署：curl 直下 / IDE SCP 中转 (R51)
 * 3. 多窗口隔离：instance.json + ref_count + 文件锁 (R48)
 * 4. Fallback 到 Python Worker（.venv 或 pip install）
 * 5. 健康检查（HTTP /health）
 */

import { SshConnection } from './sshConnection';
import { downloadAndInstallWorker } from './download';
import { createHash } from 'crypto';

interface InstanceMeta {
	pid: number;
	workspace: string;
	http_port: number;
	ref_count: number;
	refs: string[];
	started_at: string;
	version: string;
}

export class WorkerManager {

	private readonly _ssh: SshConnection;
	private readonly _installPath: string;
	private readonly _log: (msg: string) => void;
	private _pythonCmd: string = 'python3.11';
	private _workerPid: number | null = null;
	private _instanceDir: string | null = null;
	private _callerId: string;
	private _isSharedInstance = false;
	private _workerHttpPort = 8081;

	constructor(ssh: SshConnection, installPath: string, log: (msg: string) => void) {
		this._ssh = ssh;
		this._installPath = installPath;
		this._log = log;
		this._callerId = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	get workerPid(): number | null {
		return this._workerPid;
	}

	/**
	 * 启动策略（优先级从高到低）：
	 *   1. 已有 Worker 实例在跑（instance.json + PID alive）→ acquire ref_count
	 *   2. 远端有二进制缓存 → spawn 二进制
	 *   3. 远端无二进制 → 尝试下载二进制（curl 直下 / IDE 无此能力则跳过）
	 *   4. Fallback: Python .venv 启动
	 */
	async ensureWorkerRunning(reasonerGrpcTarget: string, workspacePath?: string): Promise<void> {
		const ws = workspacePath || '/root/workspace';
		const wsHash = createHash('sha256').update(ws).digest('hex').substring(0, 12);
		this._instanceDir = `$HOME/.chipos/instances/${wsHash}`;

		this._log(`[WorkerManager] ensureWorkerRunning workspace=${ws} hash=${wsHash}`);

		// --- Step 1: Atomic check + acquire (flock protected) ---
		const acquireResult = await this._tryAcquireExisting();
		if (acquireResult) {
			this._log(`[WorkerManager] Existing Worker found (pid=${acquireResult.pid}), ref acquired`);
			this._workerPid = acquireResult.pid;
			this._workerHttpPort = acquireResult.http_port || 8081;
			this._isSharedInstance = true;
			await this._waitForHealthy();
			return;
		}

		// --- Step 2: Try binary Worker ---
		const binaryPath = await this._findRemoteBinary();
		if (binaryPath) {
			this._log(`[WorkerManager] Using binary: ${binaryPath}`);
			await this._startBinaryWorker(binaryPath, reasonerGrpcTarget, ws);
				await this._waitForHealthy();
			this._log('[WorkerManager] Binary Worker is healthy');
				return;
			}

		// --- Step 3: Try downloading binary (curl on remote) ---
		const downloaded = await this._tryDownloadBinary();
		if (downloaded) {
			this._log(`[WorkerManager] Downloaded binary: ${downloaded}`);
			await this._startBinaryWorker(downloaded, reasonerGrpcTarget, ws);
			await this._waitForHealthy();
			this._log('[WorkerManager] Downloaded binary Worker is healthy');
			return;
		}

		// --- Step 4: Fallback to Python ---
		this._log('[WorkerManager] No binary available, falling back to Python');
		await this._ensurePythonEnv();
		await this._startPythonWorker(reasonerGrpcTarget, ws);
		await this._waitForHealthy();
		this._log('[WorkerManager] Python Worker is healthy');
	}

	/**
	 * 停止远端 Worker（ref_count 感知）。
	 * ref_count > 0 → 不杀进程（其他窗口还在用）
	 * ref_count == 0 → SIGTERM → 等待 → SIGKILL → 清理
	 */
	async stopWorker(): Promise<void> {
		if (this._isSharedInstance && this._instanceDir) {
			const remaining = await this._releaseRef();
			this._log(`[WorkerManager] Released ref, remaining=${remaining}`);
			if (remaining > 0) {
				this._workerPid = null;
				this._log('[WorkerManager] Other windows still using this Worker, not killing');
				return;
			}
			if (remaining < 0) {
				// releaseRef failed (SSH error, no python3, etc.) — do NOT kill, safer to leave Worker alive
				this._log('[WorkerManager] releaseRef failed, not killing Worker to avoid data loss');
				this._workerPid = null;
				return;
			}
		}

		if (!this._workerPid) {
			this._log('[WorkerManager] No worker PID, nothing to stop');
			return;
		}

		this._log(`[WorkerManager] Stopping worker (PID=${this._workerPid})...`);
		try {
			await this._ssh.exec(`kill ${this._workerPid} 2>/dev/null || true`);
			for (let i = 0; i < 10; i++) {
				await delay(500);
				if (!await this._isProcessAlive(this._workerPid)) { break; }
				if (i === 9) {
					this._log('[WorkerManager] Worker did not exit, sending SIGKILL');
					await this._ssh.exec(`kill -9 ${this._workerPid} 2>/dev/null || true`);
				}
			}
		} catch { /* best effort */ }

		await this._cleanupInstance();
		this._workerPid = null;
		this._log('[WorkerManager] Worker stopped');
	}

	// ── Binary management ────────────────────────────────────────────────

	private async _findRemoteBinary(): Promise<string | null> {
		try {
			const result = await this._ssh.exec(
				'ls -d $HOME/.chipos/workers/*/chipos-worker-linux-x64 2>/dev/null | sort -V | tail -1'
			);
			const path = result.trim();
			if (path && !path.includes('No such file')) {
				const isExec = await this._ssh.exec(`test -x "${path}" && echo yes || echo no`);
				if (isExec.trim() === 'yes') { return path; }
			}
		} catch { /* no binary cached */ }
		return null;
	}

	/**
	 * R51: 尝试在远端直接 curl 下载二进制（Mode A: 远端直下）。
	 * 如果远端无外网访问，返回 null（由调用方 fallback 到 Python）。
	 */
	private async _tryDownloadBinary(): Promise<string | null> {
		try {
			const checkNet = await this._ssh.exec(
				'curl -sf --max-time 5 https://api.github.com/repos/chip-os/coderust/releases/latest 2>/dev/null | head -c 200'
			);
			if (!checkNet.includes('tag_name')) {
				this._log('[WorkerManager] Remote cannot reach GitHub, skipping binary download');
				return null;
			}

			const versionMatch = checkNet.match(/"tag_name"\s*:\s*"v?([^"]+)"/);
			if (!versionMatch) { return null; }
			const version = versionMatch[1];
			const binaryName = 'chipos-worker-linux-x64';
			const targetDir = `$HOME/.chipos/workers/${version}`;
			const targetPath = `${targetDir}/${binaryName}`;

			this._log(`[WorkerManager] Downloading Worker v${version} on remote...`);
			await this._ssh.exec(
				`mkdir -p ${targetDir} && ` +
				`curl -fSL --retry 2 --max-time 120 ` +
				`"https://github.com/chip-os/coderust/releases/download/v${version}/${binaryName}.tar.gz" ` +
				`| tar xz -C ${targetDir} && chmod +x ${targetPath}`
			);

			const verify = await this._ssh.exec(`test -x ${targetPath} && echo ok || echo fail`);
			if (verify.trim() === 'ok') { return targetPath; }
		} catch (err) {
			this._log(`[WorkerManager] Binary download failed: ${err}`);
		}
		return null;
	}

	private async _startBinaryWorker(binaryPath: string, grpcTarget: string, workspace: string): Promise<void> {
		const logFile = '$HOME/.chipos/logs/worker.log';
		await this._ssh.exec('mkdir -p $HOME/.chipos/logs');

		const startCmd = [
			`setsid ${binaryPath}`,
			`start --server "${grpcTarget}"`,
			`--workspace "${workspace}"`,
			`--http-port ${this._workerHttpPort}`,
			`--instance-dir ${this._instanceDir}`,
			`> ${logFile} 2>&1 < /dev/null &`,
		].join(' ');

		const fullCmd = `bash -c 'nohup ${startCmd} sleep 0.5; exit 0'`;
		this._log(`[WorkerManager] _startBinaryWorker: ${fullCmd}`);
		await this._ssh.exec(fullCmd);

		await delay(1500);

		const meta = await this._readInstanceJson();
		if (meta) {
			this._workerPid = meta.pid;
			this._isSharedInstance = true;
			this._log(`[WorkerManager] Binary Worker started (PID=${meta.pid})`);
		} else {
			const pid = await this._findWorkerPid(binaryPath);
			this._workerPid = pid;
			this._log(`[WorkerManager] Binary Worker started (PID=${pid}, no instance.json yet)`);
		}
	}

	// ── Python fallback ──────────────────────────────────────────────────

	private async _ensurePythonEnv(): Promise<void> {
		await this._checkPythonEnv();
		const installed = await this._isWorkerInstalled();
		if (!installed) {
			this._log('[WorkerManager] Python Worker not installed, installing...');
			await downloadAndInstallWorker(this._ssh, this._installPath, this._log);
		}
	}

	private async _startPythonWorker(grpcTarget: string, workspace: string): Promise<void> {
		const logFile = `${this._installPath}/worker.log`;

		let workerDir = this._installPath;
		let venvPython = `${this._installPath}/.venv/bin/python`;
		let needPythonPath = false;
		try {
			await this._ssh.exec(`test -f ${this._installPath}/packages/execution/.venv/bin/python`);
			workerDir = `${this._installPath}/packages/execution`;
			venvPython = `${workerDir}/.venv/bin/python`;
			needPythonPath = true;
		} catch { /* standalone layout */ }

		const envVars = [`CHIPOS_REASONING_SERVER="${grpcTarget}"`];
		if (needPythonPath) {
			const pythonPath = [
				`${this._installPath}/packages/shared/src`,
				`${this._installPath}/packages/execution/src`,
			].join(':');
			envVars.push(`PYTHONPATH="${pythonPath}"`);
		}

		const exportLine = envVars.map(v => `export ${v}`).join('; ');
		const startCmd = [
			`bash -c '${exportLine}; cd ${workerDir};`,
			`setsid bash -c "exec ${venvPython} -m execution.server.cli start`,
			`--server \\"${grpcTarget}\\"`,
			`--workspace \\"${workspace}\\"`,
			`--http-port ${this._workerHttpPort}`,
			`--instance-dir ${this._instanceDir}`,
			`> ${logFile} 2>&1 < /dev/null" &`,
			`sleep 0.5; exit 0'`,
		].join(' ');

		await this._ssh.exec(startCmd);
		await delay(1500);

		const meta = await this._readInstanceJson();
		if (meta) {
			this._workerPid = meta.pid;
			this._isSharedInstance = true;
		} else {
			this._workerPid = await this._findWorkerPid('execution.server.cli');
		}
		this._log(`[WorkerManager] Python Worker started (PID=${this._workerPid})`);
	}

	// ── instance.json lifecycle (R48) ────────────────────────────────────

	private async _readInstanceJson(): Promise<InstanceMeta | null> {
		if (!this._instanceDir) { return null; }
		try {
			const raw = await this._ssh.exec(`cat ${this._instanceDir}/instance.json 2>/dev/null`);
			const trimmed = raw.trim();
			if (!trimmed || trimmed.startsWith('cat:')) { return null; }
			return JSON.parse(trimmed);
		} catch {
			return null;
		}
	}

	/**
	 * Atomic check + acquire: within flock, read instance.json, verify PID alive,
	 * and increment ref_count. Returns instance meta if successful, null otherwise.
	 * This eliminates the TOCTOU race between _readInstanceJson and _acquireRef.
	 */
	private async _tryAcquireExisting(): Promise<InstanceMeta | null> {
		if (!this._instanceDir) { return null; }
		const script = [
			`flock -w 10 ${this._instanceDir}/instance.lock bash -c '`,
			`META=$(cat ${this._instanceDir}/instance.json 2>/dev/null) || exit 1;`,
			`echo "$META" | python3 -c "`,
			`import sys,json,os;`,
			`m=json.load(sys.stdin);`,
			`pid=int(m.get(\\\"pid\\\",0) or 0);`,
			// Check if PID is alive (avoid inline try/except syntax issues)
			`alive = (pid > 0 and os.system(f\"kill -0 {pid} >/dev/null 2>&1\") == 0);`,
			`alive or sys.exit(1);`,
			// PID alive → acquire ref
			`m[\\\"ref_count\\\"]=m.get(\\\"ref_count\\\",1)+1;`,
			`refs=m.get(\\\"refs\\\",[]);`,
			`refs.append(\\\"${this._callerId}\\\");`,
			`m[\\\"refs\\\"]=refs;`,
			`json.dump(m,open(\\\"${this._instanceDir}/instance.json\\\",\\\"w\\\"),indent=2);`,
			`json.dump(m,sys.stdout)`,
			`"'`,
		].join('');
		try {
			const result = await this._ssh.exec(script);
			const trimmed = result.trim();
			if (!trimmed) { return null; }
			return JSON.parse(trimmed);
		} catch {
			// flock failed, instance.json missing, PID dead, or python3 unavailable.
			// Do NOT clean up unconditionally — if python3 is missing we can't tell
			// whether the Worker PID is alive; deleting instance.json would orphan a
			// running Worker and cause port conflicts on next start.
			return null;
		}
	}

	private async _releaseRef(): Promise<number> {
		if (!this._instanceDir) { return -1; }
		const script = [
			`flock -w 10 ${this._instanceDir}/instance.lock bash -c '`,
			`META=$(cat ${this._instanceDir}/instance.json 2>/dev/null) || { echo 0; exit 0; };`,
			`echo "$META" | python3 -c "`,
			`import sys,json; m=json.load(sys.stdin);`,
			`rc=max(0,m.get(\\\"ref_count\\\",1)-1);`,
			`m[\\\"ref_count\\\"]=rc;`,
			`refs=m.get(\\\"refs\\\",[]);`,
			`refs=[r for r in refs if r!=\\\"${this._callerId}\\\"];`,
			`m[\\\"refs\\\"]=refs;`,
			`json.dump(m,open(\\\"${this._instanceDir}/instance.json\\\",\\\"w\\\"),indent=2);`,
			`print(rc)`,
			`"'`,
		].join('');
		try {
			const result = await this._ssh.exec(script);
			const remaining = parseInt(result.trim(), 10);
			return isNaN(remaining) ? -1 : remaining;
		} catch (e) {
			this._log(`[WorkerManager] _releaseRef failed: ${e}`);
			return -1; // -1 = operation failed, caller must NOT kill Worker
		}
	}

	private async _cleanupInstance(): Promise<void> {
		if (!this._instanceDir) { return; }
		try {
			await this._ssh.exec(`rm -f ${this._instanceDir}/instance.json ${this._instanceDir}/instance.lock 2>/dev/null`);
		} catch { /* ignore */ }
	}

	// ── Health check ─────────────────────────────────────────────────────

	private async _waitForHealthy(timeoutMs: number = 30000): Promise<void> {
		const start = Date.now();
		let attempt = 0;
		while (Date.now() - start < timeoutMs) {
			attempt++;
			try {
				const result = await this._ssh.exec(
					`curl -sf http://localhost:${this._workerHttpPort}/health`
				);
				if (result.includes('"status"')) {
					this._log(`[WorkerManager] Health check passed (attempt ${attempt})`);
					return;
				}
			} catch { /* retry */ }
			await delay(1000);
		}
		throw new Error(`Worker health check timed out after ${timeoutMs}ms (${attempt} attempts)`);
	}

	// ── Python env ───────────────────────────────────────────────────────

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
						this._log(`[WorkerManager] Found ${cmd} → Python ${major}.${minor}`);
						return;
					}
				}
			} catch { /* try next */ }
		}

		this._log('[WorkerManager] Python >= 3.10 not found, attempting auto-install...');
			await this._autoInstallPython();
	}

	private async _autoInstallPython(): Promise<void> {
		let pkgManager: 'apt' | 'yum' | 'dnf' | null = null;
		for (const pm of ['apt', 'dnf', 'yum'] as const) {
			try {
				await this._ssh.exec(`which ${pm}`);
				pkgManager = pm;
				break;
			} catch { /* not found */ }
		}

		if (!pkgManager) {
			throw new Error('No supported package manager found (apt/dnf/yum). Please install Python 3.10+ manually.');
		}

		if (pkgManager === 'apt') {
			try {
				await this._ssh.exec('apt-get update -qq && apt-get install -y -qq python3.11 python3.11-venv 2>&1');
			} catch {
				await this._ssh.exec(
					'apt-get install -y -qq software-properties-common && ' +
					'add-apt-repository -y ppa:deadsnakes/ppa && ' +
					'apt-get update -qq && ' +
					'apt-get install -y -qq python3.11 python3.11-venv 2>&1'
				);
			}
		} else {
			await this._ssh.exec(`${pkgManager} install -y python3.11 2>&1`);
		}

			this._pythonCmd = 'python3.11';
		this._log('[WorkerManager] Auto-installed python3.11');
	}

	private async _isWorkerInstalled(): Promise<boolean> {
		try {
			const cmd = [
				`(cd ${this._installPath}/packages/execution 2>/dev/null && .venv/bin/python -c "import execution; print('ok')" 2>/dev/null)`,
				`|| (cd ${this._installPath} 2>/dev/null && .venv/bin/python -c "import execution; print('ok')" 2>/dev/null)`,
			].join(' ');
			const result = await this._ssh.exec(cmd);
			return result.trim() === 'ok';
		} catch {
			return false;
		}
	}

	// ── Utilities ────────────────────────────────────────────────────────

	private async _isProcessAlive(pid: number): Promise<boolean> {
		try {
			const result = await this._ssh.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`);
			return result.trim() === 'alive';
		} catch {
			return false;
		}
	}

	private async _findWorkerPid(pattern: string): Promise<number | null> {
		try {
			const result = await this._ssh.exec(`pgrep -f "${pattern}" | head -1`);
			const pid = parseInt(result.trim(), 10);
			return isNaN(pid) ? null : pid;
		} catch {
			return null;
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
