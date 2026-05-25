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
import { downloadAndInstallWorker, getProductInfo } from './download';
import { createHash } from 'crypto';
import { CHIPOS_RELEASE_REPO, CHIPOS_RELEASE_BASE_URL, CHIPOS_RELEASE_API_URL } from './releaseConfig';

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
	/**
	 * Phase 1.5 Worker JWT (preferred). IDE-minted via OAuth, signed by website,
	 * Reasoner verifies signature + extracts user_id. When set, the spawned
	 * Worker process gets `CHIPOS_WORKER_TOKEN` env.
	 *
	 * Mutable: P3-D auto-refresh swaps this in via `refreshWorkerToken()`
	 * shortly before expiry. The next worker spawn (or respawn) reads this
	 * current value via `_buildSpawnEnvExports`.
	 */
	private _workerToken: string;
	/**
	 * Worker → Reasoner gRPC API key (legacy / fallback when user not logged in).
	 * Spawn env: `CHIPOS_WORKER_OUTBOUND_KEY` (preferred) + `CHIPOS_API_KEY` (alias).
	 *
	 * Without either workerToken OR apiKey, Worker fails Reasoner auth with
	 * WORKER_AUTH_FAILED when the Reasoner has authentication enabled.
	 */
	private readonly _workerApiKey: string;
	private readonly _tlsEnabled: boolean;
	/**
	 * Worker-side MCP servers JSON config path (NEW-1). Passed verbatim to
	 * the worker via `--mcp-config`; remote bash (and the worker's own
	 * Path(...).expanduser()) handle `~` expansion. Empty = use built-in
	 * default `~/.chipos/mcp_servers.json`.
	 */
	private readonly _mcpConfigPath: string;

	constructor(
		ssh: SshConnection,
		installPath: string,
		log: (msg: string) => void,
		workerApiKey?: string,
		tlsEnabled?: boolean,
		workerToken?: string,
		mcpConfigPath?: string,
	) {
		this._ssh = ssh;
		this._installPath = installPath;
		this._log = log;
		this._callerId = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this._workerApiKey = workerApiKey ?? '';
		this._tlsEnabled = tlsEnabled ?? false;
		this._workerToken = workerToken ?? '';
		this._mcpConfigPath = mcpConfigPath || '~/.chipos/mcp_servers.json';
	}

	/**
	 * Build the env-var prefix string used when starting the Worker via
	 * `bash -c 'export ...; ...'`. Centralized here so both binary and
	 * python spawn paths stay in sync.
	 *
	 * Auth precedence: workerToken > workerApiKey. Both can be set
	 * (Reasoner side prefers token; apiKey is harmless if unused).
	 */
	private _buildSpawnEnvExports(grpcTarget: string): string[] {
		const exports = [`export CHIPOS_REASONING_SERVER="${grpcTarget}"`];
		if (this._workerToken) {
			const escaped = this._workerToken.replace(/(["\\$`])/g, '\\$1');
			exports.push(`export CHIPOS_WORKER_TOKEN="${escaped}"`);
		}
		if (this._workerApiKey) {
			// Shell-escape the key — base64 keys contain `=`, `+`, `/` which are
			// safe inside double quotes but bracket them anyway for paranoia.
			const escaped = this._workerApiKey.replace(/(["\\$`])/g, '\\$1');
			exports.push(`export CHIPOS_WORKER_OUTBOUND_KEY="${escaped}"`);
			exports.push(`export CHIPOS_API_KEY="${escaped}"`);
		}
		if (this._tlsEnabled) {
			exports.push(`export CHIPOS_TLS_ENABLED=true`);
		}
		return exports;
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

		// NEW-13: make sure the MCP config file exists on the remote before
		// any spawn path. Without this, a fresh remote box gets a worker
		// spawned with --mcp-config pointing at a non-existent file, MCP
		// loader silently does nothing, and the user sees tools_count=18
		// (no EDA tools). User reported "为什么 worker 只能 ls 不能跑 yosys"
		// 2026-04-28; root cause was missing /root/.chipos/mcp_servers.json.
		// Fixing in the resolver path so it self-heals for every new user.
		await this._ensureMcpConfigFile();

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

	/**
	 * P3-D: hot-swap the worker token and respawn so the new credential
	 * takes effect.
	 *
	 * Worker JWTs are short-lived (typically 24h). Without this, after
	 * the first day the worker presents an expired token and Reasoner
	 * UNAUTHENTICATEDs every reconnect — the user has to manually
	 * restart the IDE. The token-refresh timer in extension.ts schedules
	 * a call here ~30 min before expiry.
	 *
	 * Why respawn instead of in-place hot-swap: the worker reads
	 * `CHIPOS_WORKER_TOKEN` from env at startup and there's no IPC
	 * endpoint to mutate it. Respawn is also a natural fit for shared
	 * instances — all consumers see the new token because they share
	 * the same worker process.
	 *
	 * Caller MUST pass the workspace path; we don't cache it here
	 * because `ensureWorkerRunning` accepts it as an argument and
	 * we want to stay symmetric.
	 */
	async refreshWorkerToken(newToken: string, reasonerGrpcTarget: string, workspace: string): Promise<void> {
		if (!newToken) {
			this._log('[WorkerManager] refreshWorkerToken called with empty token — skipping');
			return;
		}
		if (newToken === this._workerToken) {
			this._log('[WorkerManager] refreshWorkerToken: token unchanged, skipping respawn');
			return;
		}
		this._log('[WorkerManager] refreshWorkerToken: stopping current worker for token swap');
		try {
			await this.stopWorker();
		} catch (err) {
			// Best-effort: even if stop fails (worker dead, SSH glitch), proceed with
			// swap + ensure. The new spawn will create a fresh instance.json.
			this._log(`[WorkerManager] stopWorker during refresh threw (continuing): ${err}`);
		}
		this._workerToken = newToken;
		this._log('[WorkerManager] refreshWorkerToken: starting worker with new token');
		await this.ensureWorkerRunning(reasonerGrpcTarget, workspace);
	}

	// ── MCP config bootstrap (NEW-13) ────────────────────────────────────

	/**
	 * Ensure the MCP config file exists on the remote box. Idempotent —
	 * existing user-customized files are left untouched.
	 *
	 * Background: a fresh remote box doesn't have `~/.chipos/mcp_servers.json`.
	 * The worker is spawned with `--mcp-config <that-path>`. Worker's
	 * mcp_loader hits "config file does not exist", returns 0 MCP tools
	 * silently, only the 18 base tools register. User sees a worker that
	 * can run `ls` / `git` but can't run `yosys_synthesis` / `verilog_simulate`
	 * etc and has no idea why.
	 *
	 * Default config points at the worker's bundled
	 * `execution.mcp_server.server` module. The worker's
	 * `_resolve_mcp_subprocess_command` rewrites `python -m execution.mcp_server.server`
	 * to `chipos-worker mcp-server` when running as a frozen Nuitka binary,
	 * so this single config works for both binary-mode and dev-mode workers.
	 */
	private async _ensureMcpConfigFile(): Promise<void> {
		// Expand `~` to `$HOME` for shell — bash variable expansion doesn't
		// expand tilde inside quoted/parameter contexts the same way.
		const remotePath = this._mcpConfigPath.startsWith('~/')
			? `$HOME/${this._mcpConfigPath.slice(2)}`
			: this._mcpConfigPath;

		try {
			const checkResult = await this._ssh.exec(
				`if [ -f "${remotePath}" ]; then echo EXISTS; else echo MISSING; fi`
			);
			if (checkResult.trim() === 'EXISTS') {
				this._log(`[WorkerManager] MCP config exists at ${remotePath}`);
				return;
			}

			this._log(`[WorkerManager] MCP config missing at ${remotePath}, writing default`);

			// Single-quoted heredoc marker (`'__CHIPOS_MCP_EOF__'`) prevents
			// shell variable expansion in the JSON body — keeps `$HOME` etc
			// literal inside the file.
			const defaultConfig = `{
  "mcpServers": {
    "coderust-eda-tools": {
      "command": "python",
      "args": ["-m", "execution.mcp_server.server"],
      "cwd": ".",
      "env": {}
    }
  }
}`;

			await this._ssh.exec(
				`mkdir -p "$(dirname "${remotePath}")" && cat > "${remotePath}" <<'__CHIPOS_MCP_EOF__'\n${defaultConfig}\n__CHIPOS_MCP_EOF__`
			);
			this._log('[WorkerManager] Default MCP config written');
		} catch (err) {
			// Non-fatal: worker spawn will continue. If the file genuinely
			// can't be written (permissions, disk full), the worker will
			// register with 18 tools and the user gets a degraded but
			// functional chat. Better than refusing to spawn.
			this._log(`[WorkerManager] _ensureMcpConfigFile failed (non-fatal): ${err}`);
		}
	}

	// ── Binary management ────────────────────────────────────────────────

	private async _findRemoteBinary(): Promise<string | null> {
		try {
			// IDE-pinned worker version from product.json (set at IDE build time).
			// When set, ALWAYS look for this exact version — never the highest
			// cached. This anchors the IDE to a specific Worker release so
			// IDE↔Worker protocol drift is impossible.
			const pinned = getProductInfo().chiposReleases?.workerVersion;
			if (pinned) {
				const explicit = `$HOME/.chipos/workers/${pinned}/chipos-worker-linux-x64`;
				const isExec = await this._ssh.exec(`test -x "${explicit}" && echo yes || echo no`);
				if (isExec.trim() === 'yes') {
					this._log(`[WorkerManager] Using pinned ${pinned} cached binary`);
					return explicit;
				}
				// Pinned but not cached — return null so _tryDownloadBinary
				// fetches THIS exact version (also pinned in download URL).
				this._log(`[WorkerManager] Pinned ${pinned} not cached yet, will download`);
				return null;
			}

			// Legacy fallback (source-tree dev builds with empty workerVersion):
			// pick the highest cached version. Kept for dev convenience —
			// production IDEs always have workerVersion pinned.
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
	 *
	 * Pinned mode: when product.json `chiposReleases.workerVersion` is set,
	 * download exactly that version — skip GitHub `latest` lookup. This
	 * pairs with `_findRemoteBinary` so IDE↔Worker version is locked at
	 * IDE build time.
	 */
	private async _tryDownloadBinary(): Promise<string | null> {
		try {
			// IDE-pinned worker version path: download an exact tag.
			const pinned = getProductInfo().chiposReleases?.workerVersion;
			if (pinned) {
				const binaryName = 'chipos-worker-linux-x64';
				const targetDir = `$HOME/.chipos/workers/${pinned}`;
				const targetPath = `${targetDir}/${binaryName}`;
				this._log(`[WorkerManager] Downloading pinned worker ${pinned} on remote...`);
				await this._ssh.exec(
					`mkdir -p ${targetDir} && ` +
					`curl -fSL --retry 2 --max-time 120 ` +
					`"${CHIPOS_RELEASE_BASE_URL}/${pinned}/${binaryName}.tar.gz" ` +
					`| tar xz -C ${targetDir} && chmod +x ${targetPath}`
				);
				const verify = await this._ssh.exec(`test -x ${targetPath} && echo ok || echo fail`);
				if (verify.trim() === 'ok') { return targetPath; }
				return null;
			}

			// Legacy "use latest" path (source-tree dev builds only).
			const checkNet = await this._ssh.exec(
				`curl -sf --max-time 5 ${CHIPOS_RELEASE_API_URL} 2>/dev/null | head -c 200`
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
				`"${CHIPOS_RELEASE_BASE_URL}/v${version}/${binaryName}.tar.gz" ` +
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

		const exportLine = this._buildSpawnEnvExports(grpcTarget).join('; ');

		const startCmd = [
			`setsid ${binaryPath}`,
			`start --server "${grpcTarget}"`,
			`--workspace "${workspace}"`,
			// 2026-05-25: dropped --http-port. Worker now uses kernel-assigned
			// port (no two workers can race for the same port) and writes the
			// actually-bound port into instance.json. We read it back below
			// via _waitForWorkerInstanceJson and use it for the SSH tunnel.
			// Back-compat: older workers that still default to 8081 will
			// just bind 8081 and write http_port=8081 to instance.json, which
			// the polling logic accepts identically.
			`--instance-dir ${this._instanceDir}`,
			// NEW-1: pin --mcp-config so the worker doesn't fall through to
			// `cwd/mcp_servers.json` (cwd here is wherever ssh.exec landed —
			// usually $HOME). Remote bash expands `~` via shell expansion;
			// worker also runs Path(...).expanduser() defensively.
			`--mcp-config "${this._mcpConfigPath}"`,
			`> ${logFile} 2>&1 < /dev/null &`,
		].join(' ');

		// Env exports must run inside the same bash -c so they're inherited by
		// the spawned binary (the `setsid` child).
		const fullCmd = `bash -c '${exportLine}; nohup ${startCmd} sleep 0.5; exit 0'`;
		this._log(`[WorkerManager] _startBinaryWorker (workerToken=${this._workerToken ? 'set' : 'unset'}, apiKey=${this._workerApiKey ? 'set' : 'unset'}, tls=${this._tlsEnabled})`);
		await this._ssh.exec(fullCmd);

		// 2026-05-25: was `delay(1500); _readInstanceJson()` — 1.5s is too
		// short when EDA self-check or MCP load takes longer, and we only
		// extracted pid (not http_port) so the SSH tunnel later went to the
		// stale `_workerHttpPort = 8081` default. Now polls up to 15s for a
		// valid http_port, then refreshes _workerHttpPort so forwardPort
		// tunnels to the right place. See _waitForWorkerInstanceJson docs.
		const meta = await this._waitForWorkerInstanceJson(15000);
		if (meta) {
			this._workerPid = meta.pid;
			if (meta.http_port && meta.http_port > 0) {
				this._workerHttpPort = meta.http_port;
			}
			this._isSharedInstance = true;
			this._log(`[WorkerManager] Binary Worker started (PID=${meta.pid}, http_port=${this._workerHttpPort})`);
		} else {
			const pid = await this._findWorkerPid(binaryPath);
			this._workerPid = pid;
			this._log(`[WorkerManager] Binary Worker started (PID=${pid}, no instance.json after 15s — tunnel will use default ${this._workerHttpPort})`);
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

		const exports = this._buildSpawnEnvExports(grpcTarget);
		if (needPythonPath) {
			const pythonPath = [
				`${this._installPath}/packages/shared/src`,
				`${this._installPath}/packages/execution/src`,
			].join(':');
			exports.push(`export PYTHONPATH="${pythonPath}"`);
		}

		const exportLine = exports.join('; ');
		const startCmd = [
			`bash -c '${exportLine}; cd ${workerDir};`,
			`setsid bash -c "exec ${venvPython} -m execution.server.cli start`,
			`--server \\"${grpcTarget}\\"`,
			`--workspace \\"${workspace}\\"`,
			// 2026-05-25: dropped --http-port (kernel-assigned, see binary path comment).
			`--instance-dir ${this._instanceDir}`,
			// NEW-1: same default-pin as the binary path. Note the escaped
			// double quotes — we're already two `bash -c` levels deep.
			`--mcp-config \\"${this._mcpConfigPath}\\"`,
			`> ${logFile} 2>&1 < /dev/null" &`,
			`sleep 0.5; exit 0'`,
		].join(' ');

		await this._ssh.exec(startCmd);

		// 2026-05-25: poll for valid http_port (was delay(1500) + pid-only read).
		const meta = await this._waitForWorkerInstanceJson(15000);
		if (meta) {
			this._workerPid = meta.pid;
			if (meta.http_port && meta.http_port > 0) {
				this._workerHttpPort = meta.http_port;
			}
			this._isSharedInstance = true;
		} else {
			this._workerPid = await this._findWorkerPid('execution.server.cli');
		}
		this._log(`[WorkerManager] Python Worker started (PID=${this._workerPid}, http_port=${this._workerHttpPort})`);
	}

	// ── instance.json lifecycle (R48) ────────────────────────────────────

	/**
	 * Poll the remote instance.json until it has a usable http_port.
	 *
	 * 2026-05-25: the worker writes instance.json in two phases:
	 *   Phase 1 (cli.py:_write_pid_file, ~1-2s after spawn) creates the file
	 *     with pid + http_port set to whatever was requested (default 0 in
	 *     the new always-kernel-assigned world, or 8081 in legacy workers).
	 *   Phase 2 (execution_server.py, after aiohttp.TCPSite.start(), ~3-10s
	 *     after spawn — slower when EDA self-check or MCP load runs first)
	 *     overwrites http_port with the actually-bound kernel-assigned port.
	 *
	 * The previous code did `await delay(1500); _readInstanceJson()`, which
	 * sometimes caught Phase 1 (stale port=0 or 8081) and missed Phase 2.
	 * Then forwardPort tunneled to the wrong remote port and IDE saw
	 * "Worker: Reconnect" forever even though the worker was healthy.
	 *
	 * Strategy: poll every 200ms, accept only when pid > 0 AND http_port > 0
	 * (Phase 2 has landed). 15s default budget covers cold-start with EDA
	 * pack download. Caller falls back to `_findWorkerPid` if timeout fires
	 * (rare; usually means the worker crashed early).
	 */
	private async _waitForWorkerInstanceJson(timeoutMs: number): Promise<InstanceMeta | null> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await delay(200);
			const meta = await this._readInstanceJson();
			if (meta
				&& typeof meta.pid === 'number' && meta.pid > 0
				&& typeof meta.http_port === 'number' && meta.http_port > 0) {
				return meta;
			}
		}
		return null;
	}

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
	 *
	 * The python script is base64-encoded so no shell character (`>`, `"`, `$`, ...)
	 * gets reinterpreted by bash on its way through `ssh.exec → bash -c`. Both the
	 * instance directory path and the caller id are passed as argv to avoid any
	 * string interpolation inside the python source.
	 */
	private async _tryAcquireExisting(): Promise<InstanceMeta | null> {
		if (!this._instanceDir) { return null; }
		const py = `
import json, os, sys
instance_dir = os.path.expandvars(sys.argv[1])
caller = sys.argv[2]
json_path = os.path.join(instance_dir, "instance.json")
try:
    with open(json_path) as f:
        m = json.load(f)
except Exception:
    sys.exit(1)
pid = int(m.get("pid", 0) or 0)
if pid <= 0 or os.system(f"kill -0 {pid} 2>/dev/null") != 0:
    sys.exit(1)
m["ref_count"] = m.get("ref_count", 1) + 1
refs = m.get("refs", [])
refs.append(caller)
m["refs"] = refs
with open(json_path, "w") as f:
    json.dump(m, f, indent=2)
print(json.dumps(m))
`.trim();
		const b64 = Buffer.from(py, 'utf-8').toString('base64');
		const cmd = `mkdir -p "${this._instanceDir}" && `
			+ `flock -w 10 "${this._instanceDir}/instance.lock" `
			+ `python3 -c "$(echo '${b64}' | base64 -d)" `
			+ `"${this._instanceDir}" "${this._callerId}"`;
		try {
			const result = await this._ssh.exec(cmd);
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

	/**
	 * Release ref count atomically. Same base64-encoded python pattern as
	 * `_tryAcquireExisting` to dodge shell quoting hazards.
	 */
	private async _releaseRef(): Promise<number> {
		if (!this._instanceDir) { return -1; }
		const py = `
import json, os, sys
instance_dir = os.path.expandvars(sys.argv[1])
caller = sys.argv[2]
json_path = os.path.join(instance_dir, "instance.json")
try:
    with open(json_path) as f:
        m = json.load(f)
except Exception:
    print(0)
    sys.exit(0)
rc = max(0, m.get("ref_count", 1) - 1)
m["ref_count"] = rc
refs = [r for r in m.get("refs", []) if r != caller]
m["refs"] = refs
with open(json_path, "w") as f:
    json.dump(m, f, indent=2)
print(rc)
`.trim();
		const b64 = Buffer.from(py, 'utf-8').toString('base64');
		const cmd = `flock -w 10 "${this._instanceDir}/instance.lock" `
			+ `python3 -c "$(echo '${b64}' | base64 -d)" `
			+ `"${this._instanceDir}" "${this._callerId}"`;
		try {
			const result = await this._ssh.exec(cmd);
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
