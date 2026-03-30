/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R30: SidecarManagerElectron — Electron desktop 实现。
 *
 * 与 SidecarManagerBrowser 的区别：
 * - 本地模式（Local）下通过 IPC 委托 main 进程 spawn Reasoner + Worker 子进程
 * - cloud-reasoning 模式下只启动 Worker，连接远端 Reasoner
 * - manual 模式下不启动任何进程
 *
 * IPC 通道（由 R29 sidecarManagerMain.ts 注册）：
 * - chipos:spawnProcess  → 启动子进程（role='reasoner'|'worker'）
 * - chipos:killProcess   → 停止子进程（按 role）
 * - chipos:processStatus → 查询进程状态
 *
 * 复盘修复:
 * - Fix1: IPC 通道名从 chipos:spawnWorker 改为 chipos:spawnProcess + role 参数
 *         （R29 分离了 Reasoner/Worker 两个进程变量，必须用 role 区分）
 * - Fix2: Worker 环境变量名从 CHIPOS_REASONING_GRPC_TARGET 改为 CHIPOS_REASONING_SERVER
 *         （WorkerConfig.from_env 读的是 CHIPOS_REASONING_SERVER）
 * - Fix3: stopBackend 需要同时停 Reasoner 和 Worker（之前只停 Worker）
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	ISidecarManagerService,
	SidecarState,
	BackendMode,
	WorkerState,
} from '../common/sidecarService.js';

export class SidecarManagerElectron extends Disposable implements ISidecarManagerService {

	declare readonly _serviceBrand: undefined;

	// ── Events ───────────────────────────────────────────────────────────

	private readonly _onDidChangeState = this._register(new Emitter<SidecarState>());
	readonly onDidChangeState: Event<SidecarState> = this._onDidChangeState.event;

	private readonly _onDidChangeWorkerState = this._register(new Emitter<WorkerState>());
	readonly onDidChangeWorkerState: Event<WorkerState> = this._onDidChangeWorkerState.event;

	// ── State ────────────────────────────────────────────────────────────

	private _state: SidecarState = SidecarState.NotStarted;
	private _workerState: WorkerState = WorkerState.NotStarted;
	private _mode: BackendMode;
	private _workerPid: number | undefined;

	get state(): SidecarState { return this._state; }
	get workerState(): WorkerState { return this._workerState; }
	get mode(): BackendMode { return this._mode; }

	// ── URLs ─────────────────────────────────────────────────────────────

	get reasoningUrl(): string {
		const url = this._configurationService.getValue<string>('chipos.backend.reasoningUrl');
		if (url) {
			return url;
		}
		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		return `http://127.0.0.1:${httpPort}`;
	}

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

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	get port(): number { return 0; }
	get wsUrl(): string { return this.reasoningUrl; }

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const modeStr = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
		this._mode = modeStr as BackendMode;

		this._logService.info(`[ChipOS SidecarElectron] mode=${this._mode}`);
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/**
	 * 启动后端。
	 *
	 * Local 模式：通过 IPC 委托 main 进程 spawn Reasoner + Worker。
	 * CloudReasoning 模式：只启动本地 Worker，连接远端 Reasoner。
	 * Manual 模式：不启动任何进程，直接连接。
	 */
	async startBackend(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] startBackend()');

		if (this._mode === BackendMode.Manual) {
			this._setState(SidecarState.Connected);
			return;
		}

		this._setState(SidecarState.Spawning);

		try {
			if (this._mode === BackendMode.Local) {
				await this._spawnReasonerViaIpc();
			}

			// Worker（Local 和 CloudReasoning 都需要）
			await this._spawnWorkerViaIpc();

			// 健康检查：轮询 /health 确认 workers_connected > 0
			await this._healthCheckLoop();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] startBackend failed: ${msg}`);
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * 停止后端。
	 * Fix3: 同时停 Worker 和 Reasoner（之前只停 Worker）。
	 */
	async stopBackend(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] stopBackend()');

		// 先停 Worker 再停 Reasoner（Worker 依赖 Reasoner）
		await this._killProcessViaIpc('worker');
		this._setWorkerState(WorkerState.NotStarted);

		if (this._mode === BackendMode.Local) {
			await this._killProcessViaIpc('reasoner');
		}

		this._setState(SidecarState.NotStarted);
	}

	/**
	 * 重启 Worker（不影响 Reasoner 连接）。
	 */
	async restartWorker(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] restartWorker()');
		await this._killProcessViaIpc('worker');
		await this._spawnWorkerViaIpc();
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	async spawn(): Promise<void> { return this.startBackend(); }
	async kill(): Promise<void> { return this.stopBackend(); }
	setManualUrl(_url: string | undefined): void { /* noop */ }

	// ── Private: IPC 委托 ────────────────────────────────────────────────

	/**
	 * 解析后端目录路径。
	 * 优先使用显式配置 → 产品目录 → 开发目录。
	 * sandbox 中无法检查文件存在性，通过 appRoot 路径特征判断环境。
	 */
	private _resolveBackendDir(): string {
		const explicit = this._configurationService.getValue<string>('chipos.backend.dir');
		if (explicit) {
			return explicit;
		}
		const appRoot = this._environmentService.appRoot;
		// 产品模式: resources/chipos-backend
		const productDir = join(appRoot, 'resources', 'chipos-backend');
		// 开发模式: ../backend_v2
		const devDir = join(appRoot, '..', 'backend_v2');
		// sandbox 中无法 fs.existsSync，用 appRoot 路径特征判断
		if (appRoot.includes('/out/') || appRoot.endsWith('/out')) {
			return devDir;
		}
		return productDir;
	}

	/**
	 * 获取当前工作区根目录。
	 */
	private _resolveWorkspaceRoot(): string {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders[0].uri.fsPath;
		}
		return '';
	}

	/**
	 * 通过 IPC 委托 main 进程 spawn Reasoner 进程。
	 * Fix1: 使用 chipos:spawnProcess + role='reasoner'（不再用 chipos:spawnWorker）。
	 */
	private async _spawnReasonerViaIpc(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] Spawning reasoner via IPC...');

		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';
		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		const grpcPort = this._configurationService.getValue<number>('chipos.backend.grpcPort') ?? 50051;

		const env: Record<string, string> = {
			CHIPOS_REASONING_HTTP_PORT: String(httpPort),
			CHIPOS_REASONING_GRPC_PORT: String(grpcPort),
			CHIPOS_DEPLOYMENT_MODE: 'local',
		};

		try {
			const result = await this._invokeIpc('chipos:spawnProcess', {
				pythonPath,
				moduleArgs: ['-m', 'reasoning.server.cli', 'start'],
				env,
				cwd: this._resolveBackendDir(),
				role: 'reasoner',
			});
			this._logService.info(`[ChipOS SidecarElectron] Reasoner spawned: pid=${result?.pid}`);
		} catch (err) {
			throw new Error(`IPC spawn reasoner failed: ${err}`);
		}
	}

	/**
	 * 通过 IPC 启动 Worker 子进程。
	 * Fix1: 使用 chipos:spawnProcess + role='worker'。
	 * Fix2: 环境变量名改为 CHIPOS_REASONING_SERVER（匹配 WorkerConfig.from_env）。
	 */
	private async _spawnWorkerViaIpc(): Promise<void> {
		this._setWorkerState(WorkerState.Starting);

		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';
		const grpcTarget = this.grpcAddress;
		const token = this._configurationService.getValue<string>('chipos.backend.token') ?? '';
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		const tlsEnabled = this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false;
		const workspaceRoot = this._resolveWorkspaceRoot();

		const env: Record<string, string> = {
			// Fix2: WorkerConfig.from_env 读 CHIPOS_REASONING_SERVER，不是 CHIPOS_REASONING_GRPC_TARGET
			CHIPOS_REASONING_SERVER: grpcTarget,
			CHIPOS_WORKER_HTTP_PORT: String(workerHttpPort),
			CHIPOS_TLS_ENABLED: String(tlsEnabled),
			...(token ? { CHIPOS_API_KEY: token } : {}),
			...(workspaceRoot ? { CHIPOS_WORKSPACE_ROOT: workspaceRoot } : {}),
		};

		try {
			const result = await this._invokeIpc('chipos:spawnProcess', {
				pythonPath,
				moduleArgs: ['-m', 'execution.server.cli', 'start', '--server', grpcTarget],
				env,
				cwd: this._resolveBackendDir(),
				role: 'worker',
			});
			this._workerPid = result?.pid;
			this._logService.info(`[ChipOS SidecarElectron] Worker spawned: pid=${this._workerPid}, awaiting health check`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] Worker start failed: ${msg}`);
			this._setWorkerState(WorkerState.Error);
		}
	}

	/**
	 * 通过 IPC 停止指定角色的子进程。
	 */
	private async _killProcessViaIpc(role: 'reasoner' | 'worker'): Promise<void> {
		try {
			await this._invokeIpc('chipos:killProcess', role);
			if (role === 'worker') {
				this._workerPid = undefined;
			}
		} catch (err) {
			this._logService.warn(`[ChipOS SidecarElectron] kill ${role} failed: ${err}`);
		}
	}

	/**
	 * 健康检查轮询：等待 /health 返回 workers_connected > 0 才设 Connected。
	 * 超时后降级为 Connected（避免永远卡在 HealthChecking）。
	 */
	private async _healthCheckLoop(): Promise<void> {
		this._setState(SidecarState.HealthChecking);
		const timeout = 15_000;
		const interval = 500;
		const start = Date.now();

		while (Date.now() - start < timeout) {
			if (this._store.isDisposed) { return; }
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
				clearTimeout(timer);
				if (resp.ok) {
					const body = await resp.json() as { status?: string; workers_connected?: number };
					if (body.workers_connected && body.workers_connected > 0) {
						this._setState(SidecarState.Connected);
						this._setWorkerState(WorkerState.Connected);
						this._logService.info('[ChipOS SidecarElectron] Health check passed, workers_connected:', body.workers_connected);
						return;
					}
				}
			} catch { /* retry */ }
			await new Promise<void>(r => setTimeout(r, interval));
		}

		this._logService.warn('[ChipOS SidecarElectron] Health check timeout — backend may not be fully ready');
		this._setState(SidecarState.Error);
	}

	/**
	 * IPC 调用封装。
	 *
	 * electron-sandbox 层不能直接 import electron 的 ipcRenderer，
	 * 需要通过 preload 脚本注入的 bridge 或 VS Code 的 INativeHostService 间接调用。
	 *
	 * 当前实现：通过 globalThis.chiposIpc（preload 注入）调用。
	 * 如果 preload 未注入，降级为 noop（不会崩溃，但功能不可用）。
	 */
	private async _invokeIpc(channel: string, ...args: any[]): Promise<any> {
		const bridge = (globalThis as any).chiposIpc;
		if (!bridge) {
			this._logService.warn(`[ChipOS SidecarElectron] IPC bridge not available, skipping ${channel}`);
			return undefined;
		}
		return bridge.invoke(channel, ...args);
	}

	// ── State helpers ────────────────────────────────────────────────────

	private _setState(s: SidecarState): void {
		if (this._state !== s) {
			this._state = s;
			this._onDidChangeState.fire(s);
		}
	}

	private _setWorkerState(s: WorkerState): void {
		if (this._workerState !== s) {
			this._workerState = s;
			this._onDidChangeWorkerState.fire(s);
		}
	}
}
