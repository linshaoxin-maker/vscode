/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn as cpSpawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState, BackendMode, WorkerState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const MAX_RESTART_COUNT = 3;
const RESTART_DELAY_MS = 1_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * SidecarManager — 管理 Python 后端进程的生命周期。
 *
 * 三种模式（chipos.backend.mode）：
 * - local:           spawn local_runner.py（推理+执行同进程）
 * - cloud-reasoning: spawn Worker（执行层），推理层在云端
 * - manual:          不 spawn，直接连接预部署的后端
 *
 * 通信协议：IDE ↔ 后端统一走 HTTP/SSE（SseEventStreamClient）。
 * SidecarManager 只负责进程生命周期，不参与数据通信。
 */
export class SidecarManager extends Disposable implements ISidecarManagerService {

	declare readonly _serviceBrand: undefined;

	// ── 推理层状态 ───────────────────────────────────────────────────────

	private readonly _onDidChangeState = this._register(new Emitter<SidecarState>());
	readonly onDidChangeState: Event<SidecarState> = this._onDidChangeState.event;

	private _state: SidecarState = SidecarState.NotStarted;
	private _process: ChildProcess | undefined;
	private _restartCount = 0;
	private _disposed = false;
	private _timer: ReturnType<typeof setTimeout> | undefined;

	get state(): SidecarState { return this._state; }

	// ── Worker 状态 ──────────────────────────────────────────────────────

	private readonly _onDidChangeWorkerState = this._register(new Emitter<WorkerState>());
	readonly onDidChangeWorkerState: Event<WorkerState> = this._onDidChangeWorkerState.event;

	private _workerState: WorkerState = WorkerState.NotStarted;
	private _workerProcess: ChildProcess | undefined;
	private _workerId: string | undefined;

	get workerState(): WorkerState { return this._workerState; }

	// ── 模式 & URL ──────────────────────────────────────────────────────

	private _mode: BackendMode = BackendMode.Local;

	get mode(): BackendMode { return this._mode; }

	/** 推理层 HTTP URL（SSE client 连接用） */
	get reasoningUrl(): string {
		const url = this._configurationService.getValue<string>('chipos.backend.reasoningUrl');
		if (url) {
			return url;
		}
		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		return `http://127.0.0.1:${httpPort}`;
	}

	/** SSE endpoint URL（chatAgent 用） */
	get sseUrl(): string {
		return `${this.reasoningUrl}/api/v1/task/stream`;
	}

	get workerHttpUrl(): string {
		const explicit = this._configurationService.getValue<string>('chipos.backend.workerHttpUrl');
		if (explicit) {
			return explicit.replace(/\/$/, '');
		}
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		if (this._mode === BackendMode.Local || this._mode === BackendMode.CloudReasoning) {
			return `http://127.0.0.1:${workerHttpPort}`;
		}
		try {
			const url = new URL(this.reasoningUrl);
			return `${url.protocol}//${url.hostname}:${workerHttpPort}`;
		} catch {
			return `http://127.0.0.1:${workerHttpPort}`;
		}
	}

	/** Worker gRPC target（host:port 格式，非 HTTP URL） */
	get grpcAddress(): string {
		const explicit = this._configurationService.getValue<string>('chipos.backend.grpcAddress');
		if (explicit) {
			return explicit;
		}
		const grpcPort = this._configurationService.getValue<number>('chipos.backend.grpcPort') ?? 50051;
		try {
			const url = new URL(this.reasoningUrl);
			if (url.port === '443' || url.protocol === 'https:') {
				return `${url.hostname}:443`;
			}
			return `${url.hostname}:${grpcPort}`;
		} catch {
			return `localhost:${grpcPort}`;
		}
	}

	// ── v1 兼容属性（connectionTab 等旧代码可能引用）──────────────────────

	get port(): number {
		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		return httpPort;
	}

	get wsUrl(): string {
		// v1 兼容：返回 SSE URL 而不是 WebSocket URL
		return this.sseUrl;
	}

	// ── Constructor ──────────────────────────────────────────────────────

	constructor(
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const modeStr = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
		this._mode = this._parseMode(modeStr);
	}

	// ── 公共 API ────────────────────────────────────────────────────────

	async startBackend(): Promise<void> {
		if (this._disposed) {
			return;
		}

		// 重新读取模式（用户可能在设置中改了）
		const modeStr = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
		this._mode = this._parseMode(modeStr);

		this._logService.info('[ChipOS] Starting backend, mode:', this._mode);

		switch (this._mode) {
			case BackendMode.Local:
				await this._startLocal();
				break;
			case BackendMode.CloudReasoning:
				await this._startCloudReasoning();
				break;
			case BackendMode.Manual:
				await this._startManual();
				break;
		}
	}

	async stopBackend(): Promise<void> {
		this._clearTimer();
		this._clearWorkerTimer();
		this._restartCount = 0;
		this._workerRestartCount = 0;

		await this._killProcess(this._workerProcess, 'Worker');
		this._workerProcess = undefined;
		this._setWorkerState(WorkerState.NotStarted);

		await this._killProcess(this._process, 'Backend');
		this._process = undefined;
		this._setState(SidecarState.NotStarted);
	}

	async restartWorker(): Promise<void> {
		this._logService.info('[ChipOS] Restarting worker...');
		await this._killProcess(this._workerProcess, 'Worker');
		this._workerProcess = undefined;

		if (this._mode === BackendMode.CloudReasoning) {
			await this._spawnWorker();
		}
	}

	// ── v1 兼容方法（chiposContribution 不再调用，但接口定义可能要求）────

	async spawn(): Promise<void> { return this.startBackend(); }
	async kill(): Promise<void> { return this.stopBackend(); }
	setManualUrl(_url: string | undefined): void { /* no-op, 用 chipos.backend.reasoningUrl 代替 */ }

	// ── 策略实现 ─────────────────────────────────────────────────────────

	/**
	 * 场景 A / B1: 本地全栈 — spawn local_runner.py（推理+执行同进程）
	 */
	private async _startLocal(): Promise<void> {
		const backendDir = this._resolveBackendDir();
		const pythonPath = this._resolvePython(backendDir);

		if (!existsSync(pythonPath)) {
			this._logService.error('[ChipOS] Python not found:', pythonPath);
			this._setState(SidecarState.Error);
			return;
		}

		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		const grpcPort = this._configurationService.getValue<number>('chipos.backend.grpcPort') ?? 50051;
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;

		this._setState(SidecarState.Spawning);
		this._logService.info('[ChipOS] Spawning local_runner.py, port:', httpPort, 'grpc:', grpcPort, 'workerHttp:', workerHttpPort);

		try {
			this._process = cpSpawn(
				pythonPath,
				['local_runner.py', '--http-port', String(httpPort), '--grpc-port', String(grpcPort), '--worker-http-port', String(workerHttpPort)],
				{
					cwd: backendDir,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: this._buildEnv(backendDir),
				}
			);

			this._attachHandlers(this._process, 'Backend');
			this._setState(SidecarState.HealthChecking);
			await this._healthCheckLoop(httpPort);
		} catch (err) {
			this._logService.error('[ChipOS] Failed to start local:', String(err));
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * 场景 B3 / E: 本地执行 + 云端推理
	 */
	private async _startCloudReasoning(): Promise<void> {
		this._logService.info('[ChipOS] Cloud reasoning at:', this.reasoningUrl);
		this._setState(SidecarState.HealthChecking);

		const ok = await this._httpHealthCheck(this.reasoningUrl);
		if (!ok) {
			this._logService.error('[ChipOS] Cloud reasoning not reachable:', this.reasoningUrl);
			this._setState(SidecarState.Error);
			return;
		}

		this._setState(SidecarState.Connected);
		await this._spawnWorker();
	}

	/**
	 * 场景 B2: 手动模式 — 不 spawn，远端 Reasoner + 远端 Worker
	 */
	private async _startManual(): Promise<void> {
		this._logService.info('[ChipOS] Manual mode, reasoning at:', this.reasoningUrl);
		this._setState(SidecarState.HealthChecking);

		const ok = await this._httpHealthCheck(this.reasoningUrl);
		if (ok) {
			this._setState(SidecarState.Connected);
			this._checkManualWorkers();
		} else {
			this._logService.error('[ChipOS] Manual reasoning not reachable:', this.reasoningUrl);
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * Manual 模式下通过 /health 检查是否有 Worker 已注册。
	 * /health 不需要认证，返回 workers_connected 计数。
	 */
	private async _checkManualWorkers(): Promise<void> {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
			clearTimeout(timer);
			if (resp.ok) {
				const body = await resp.json() as { workers_connected?: number };
				if (body.workers_connected && body.workers_connected > 0) {
					this._setWorkerState(WorkerState.Connected);
					this._logService.info('[ChipOS Manual] Workers connected:', body.workers_connected);
				} else {
					this._setWorkerState(WorkerState.Disconnected);
					this._logService.warn('[ChipOS Manual] No connected workers found');
				}
			}
		} catch {
			this._logService.warn('[ChipOS Manual] Failed to check workers');
		}
	}

	/**
	 * 启动 Worker 进程（execution 层）
	 */
	private async _spawnWorker(): Promise<void> {
		const backendDir = this._resolveBackendDir();
		const pythonPath = this._resolveWorkerPython(backendDir);

		if (!existsSync(pythonPath)) {
			this._logService.error('[ChipOS Worker] Python not found:', pythonPath);
			this._setWorkerState(WorkerState.Error);
			return;
		}

		this._workerId = `worker-${generateUuid().substring(0, 12)}`;
		this._setWorkerState(WorkerState.Starting);

		const grpcTarget = this.grpcAddress;
		const folders = this._workspaceContextService.getWorkspace().folders;
		const workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : backendDir;

		// Fix J: inject auth + TLS config into Worker process environment
		const token = this._configurationService.getValue<string>('chipos.backend.token') || '';
		const tlsEnabled = this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') || false;

		this._logService.info('[ChipOS Worker] Starting, id:', this._workerId, 'gRPC target:', grpcTarget);

		try {
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		this._workerProcess = cpSpawn(
			pythonPath,
			['-m', 'execution.server.cli', 'start', '--server', grpcTarget, '--workspace', workspaceRoot],
			{
				cwd: backendDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...this._buildEnv(backendDir),
					CHIPOS_REASONING_SERVER: grpcTarget,
					CHIPOS_REASONING_URL: this.reasoningUrl,
					CHIPOS_WORKER_ID: this._workerId,
					CHIPOS_WORKER_HTTP_PORT: String(workerHttpPort),
					...(token ? { CHIPOS_API_KEY: token } : {}),
					CHIPOS_TLS_ENABLED: String(tlsEnabled),
				},
			}
		);

			this._attachHandlers(this._workerProcess, 'Worker');

			const registered = await this._waitForWorkerRegistered(this._workerId!, 15000);
			if (registered) {
				this._setWorkerState(WorkerState.Connected);
				this._logService.info('[ChipOS Worker] Registered at Reasoner');
			} else if (this._workerProcess && !this._workerProcess.killed) {
				this._setWorkerState(WorkerState.Connected);
				this._logService.warn('[ChipOS Worker] Registration check unavailable, assuming connected');
			}
		} catch (err) {
			this._logService.error('[ChipOS Worker] Spawn failed:', String(err));
			this._setWorkerState(WorkerState.Error);
		}
	}

	// ── dispose ──────────────────────────────────────────────────────────

	override dispose(): void {
		this._disposed = true;
		this._clearTimer();
		this._clearWorkerTimer();
		const proc = this._process;
		const workerProc = this._workerProcess;
		this._process = undefined;
		this._workerProcess = undefined;
		if (proc && !proc.killed) {
			proc.kill('SIGTERM');
			setTimeout(() => { if (!proc.killed) { proc.kill('SIGKILL'); } }, KILL_TIMEOUT_MS);
		}
		if (workerProc && !workerProc.killed) {
			workerProc.kill('SIGTERM');
			setTimeout(() => { if (!workerProc.killed) { workerProc.kill('SIGKILL'); } }, KILL_TIMEOUT_MS);
		}
		super.dispose();
	}

	// ── Path resolution ─────────────────────────────────────────────────

	private _resolveBackendDir(): string {
		// 用户自定义路径（最高优先级）
		const customDir = this._configurationService.getValue<string>('chipos.backend.dir');
		if (customDir && existsSync(customDir)) {
			return customDir;
		}

		// 产品模式：resources/chipos-backend/
		const productDir = join(this._environmentService.appRoot, 'resources', 'chipos-backend');
		if (existsSync(productDir)) {
			return productDir;
		}

		// 开发模式：从 appRoot 往上找 backend_v2/
		// appRoot 通常是 vscode/ 目录
		const devDir = join(this._environmentService.appRoot, '..', 'backend_v2');
		if (existsSync(devDir)) {
			this._logService.info('[ChipOS] Dev mode: using', devDir);
			return devDir;
		}

		// 兜底：返回产品路径（会在后续 existsSync(pythonPath) 检查时报错）
		return productDir;
	}

	private _resolvePython(backendDir: string): string {
		return this._resolvePythonForPackage(backendDir, 'reasoning');
	}

	private _resolveWorkerPython(backendDir: string): string {
		return this._resolvePythonForPackage(backendDir, 'execution');
	}

	private _resolvePythonForPackage(backendDir: string, pkg: string): string {
		const venvPython = process.platform === 'win32'
			? join(backendDir, 'packages', pkg, '.venv', 'Scripts', 'python.exe')
			: join(backendDir, 'packages', pkg, '.venv', 'bin', 'python');

		if (existsSync(venvPython)) {
			return venvPython;
		}

		// 产品模式：打包时内嵌的 Python
		const bundledPython = process.platform === 'win32'
			? join(backendDir, 'python', 'python.exe')
			: join(backendDir, 'python', 'bin', 'python3');

		if (existsSync(bundledPython)) {
			return bundledPython;
		}

		return 'python3';
	}

	/**
	 * PYTHONPATH = packages/shared/src : packages/reasoning/src : packages/execution/src
	 */
	private _buildEnv(backendDir: string): NodeJS.ProcessEnv {
		const sep = process.platform === 'win32' ? ';' : ':';
		const pythonPath = [
			join(backendDir, 'packages', 'shared', 'src'),
			join(backendDir, 'packages', 'reasoning', 'src'),
			join(backendDir, 'packages', 'execution', 'src'),
		].join(sep);

		const existing = process.env['PYTHONPATH'];
		return {
			...process.env,
			PYTHONPATH: existing ? `${pythonPath}${sep}${existing}` : pythonPath,
			PYTHONDONTWRITEBYTECODE: '1',
		};
	}

	// ── Process management ──────────────────────────────────────────────

	private _attachHandlers(proc: ChildProcess, label: string): void {
		proc.stdout?.on('data', (data: Buffer) => {
			const lines = data.toString().trim();
			if (lines) { this._logService.info(`[ChipOS ${label}]`, lines); }
		});

		proc.stderr?.on('data', (data: Buffer) => {
			const lines = data.toString().trim();
			if (lines) { this._logService.warn(`[ChipOS ${label}]`, lines); }
		});

		proc.once('exit', (code, signal) => {
			this._logService.info(`[ChipOS ${label}] Exited, code: ${code}, signal: ${signal}`);

			if (label === 'Backend') {
				this._process = undefined;
				if (!this._disposed && this._state !== SidecarState.NotStarted) {
					this._handleCrash(code);
				}
			} else {
				this._workerProcess = undefined;
				this._setWorkerState(WorkerState.Disconnected);
				if (!this._disposed && this._mode === BackendMode.CloudReasoning && code !== 0) {
					this._handleWorkerCrash(code);
				}
			}
		});

		proc.once('error', (err) => {
			this._logService.error(`[ChipOS ${label}] Error:`, err.message);
		});
	}

	private async _killProcess(proc: ChildProcess | undefined, label: string): Promise<void> {
		if (!proc || proc.killed) {
			return;
		}

		this._logService.info(`[ChipOS ${label}] Sending SIGTERM`);
		proc.kill('SIGTERM');

		const killed = await new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => resolve(false), KILL_TIMEOUT_MS);
			proc.once('exit', () => { clearTimeout(timeout); resolve(true); });
		});

		if (!killed) {
			this._logService.info(`[ChipOS ${label}] SIGTERM timeout, SIGKILL`);
			proc.kill('SIGKILL');
		}
	}

	// ── Health check ────────────────────────────────────────────────────

	private async _healthCheckLoop(port: number): Promise<void> {
		const ok = await this._httpHealthCheck(`http://127.0.0.1:${port}`);
		if (ok) {
			this._restartCount = 0;
			this._setState(SidecarState.Connected);
			this._logService.info('[ChipOS] Connected on port', port);
		} else if (this._state === SidecarState.HealthChecking) {
			this._logService.error('[ChipOS] Health check timed out');
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * HTTP GET health check for remote reasoning servers.
	 * Tries up to HEALTH_CHECK_TIMEOUT_MS with retries.
	 */
	private async _httpHealthCheck(baseUrl: string): Promise<boolean> {
		const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
		while (Date.now() < deadline && !this._disposed) {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
				clearTimeout(timeout);
				if (resp.ok) {
					const body = await resp.json() as { status?: string; workers_connected?: number };
					if (body.workers_connected && body.workers_connected > 0) {
						this._logService.info('[ChipOS] Health check passed, workers_connected:', body.workers_connected);
						return true;
					}
					this._logService.trace('[ChipOS] Health check: waiting for workers_connected > 0');
				}
			} catch {
				// retry
			}
			await this._delay(HEALTH_CHECK_INTERVAL_MS);
		}
		return false;
	}

	/**
	 * Poll GET /api/v1/workers on the Reasoning server until our worker_id appears as registered.
	 */
	/**
	 * Poll GET /health to confirm worker count increased, as a proxy for our worker having registered.
	 * Falls back to simple delay if /health is not available.
	 */
	private async _waitForWorkerRegistered(_workerId: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && !this._disposed) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
				clearTimeout(timer);
				if (resp.ok) {
					const body = await resp.json() as { status?: string; workers_connected?: number };
					if (body.workers_connected && body.workers_connected > 0) {
						return true;
					}
				}
			} catch {
				// Reasoner may not be ready yet
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		return false;
	}

	// ── Crash recovery ──────────────────────────────────────────────────

	private _handleCrash(code: number | null): void {
		this._clearTimer();
		this._setState(SidecarState.Disconnected);
		this._restartCount++;

		this._logService.info('[ChipOS] Crash, exit code:', code, 'attempt:', this._restartCount, '/', MAX_RESTART_COUNT);

		if (this._restartCount > MAX_RESTART_COUNT) {
			this._logService.error('[ChipOS] Max restarts exceeded');
			this._setState(SidecarState.Error);
			return;
		}

		this._logService.info('[ChipOS] Restarting in', RESTART_DELAY_MS, 'ms');
		this._timer = setTimeout(() => {
			if (!this._disposed) {
				this.startBackend();
			}
		}, RESTART_DELAY_MS);
	}

	private _workerRestartCount = 0;
	private _workerTimer: ReturnType<typeof setTimeout> | undefined;

	private _handleWorkerCrash(code: number | null): void {
		this._workerRestartCount++;
		this._logService.info('[ChipOS Worker] Crash, exit code:', code, 'attempt:', this._workerRestartCount, '/', MAX_RESTART_COUNT);

		if (this._workerRestartCount > MAX_RESTART_COUNT) {
			this._logService.error('[ChipOS Worker] Max restarts exceeded');
			this._setWorkerState(WorkerState.Error);
			return;
		}

		this._logService.info('[ChipOS Worker] Restarting in', RESTART_DELAY_MS, 'ms');
		this._workerTimer = setTimeout(() => {
			this._workerTimer = undefined;
			if (!this._disposed && this._mode === BackendMode.CloudReasoning) {
				this._spawnWorker();
			}
		}, RESTART_DELAY_MS);
	}

	private _clearWorkerTimer(): void {
		if (this._workerTimer !== undefined) {
			clearTimeout(this._workerTimer);
			this._workerTimer = undefined;
		}
	}

	// ── State ───────────────────────────────────────────────────────────

	private _setState(state: SidecarState): void {
		if (this._state === state) { return; }
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	private _setWorkerState(state: WorkerState): void {
		if (this._workerState === state) { return; }
		this._workerState = state;
		this._onDidChangeWorkerState.fire(state);
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private _parseMode(modeStr: string): BackendMode {
		switch (modeStr) {
			case 'cloud-reasoning': return BackendMode.CloudReasoning;
			case 'manual': return BackendMode.Manual;
			default: return BackendMode.Local;
		}
	}

	private _clearTimer(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(resolve => { this._timer = setTimeout(resolve, ms); });
	}
}
