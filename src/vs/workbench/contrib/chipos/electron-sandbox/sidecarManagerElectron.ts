/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R30: SidecarManagerElectron — Electron desktop 实现。
 *
 * 与 SidecarManagerBrowser 的区别：
 * - 本地模式（Local）下通过 IPC 委托 main 进程 spawn Worker 子进程
 * - cloud-reasoning 模式下行为与 Browser 版一致（连接远端 Reasoner）
 * - manual 模式下行为与 Browser 版一致
 *
 * IPC 通道（由 R29 sidecarManagerMain.ts 注册）：
 * - chipos:spawnWorker  → 启动 Worker 子进程
 * - chipos:killWorker   → 停止 Worker 子进程
 * - chipos:workerStatus → 查询 Worker 状态
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
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

	get grpcAddress(): string {
		const explicit = this._configurationService.getValue<string>('chipos.backend.grpcAddress');
		if (explicit) {
			return explicit;
		}
		try {
			const url = new URL(this.reasoningUrl);
			if (url.port === '443' || url.protocol === 'https:') {
				return `${url.hostname}:443`;
			}
			return `${url.hostname}:50051`;
		} catch {
			return 'localhost:50051';
		}
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	get port(): number { return 0; }
	get wsUrl(): string { return this.reasoningUrl; }

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
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
				// Local 模式：spawn Reasoner + Worker
				await this._spawnViaIpc();
			}

			// 启动 Worker（Local 和 CloudReasoning 都需要）
			await this._startWorkerViaIpc();

			this._setState(SidecarState.Connected);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] startBackend failed: ${msg}`);
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * 停止后端。
	 */
	async stopBackend(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] stopBackend()');

		await this._stopWorkerViaIpc();
		this._setState(SidecarState.NotStarted);
	}

	/**
	 * 重启 Worker（不影响 Reasoner 连接）。
	 */
	async restartWorker(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] restartWorker()');
		await this._stopWorkerViaIpc();
		await this._startWorkerViaIpc();
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	async spawn(): Promise<void> { return this.startBackend(); }
	async kill(): Promise<void> { return this.stopBackend(); }
	setManualUrl(_url: string | undefined): void { /* noop */ }

	// ── Private: IPC 委托 ────────────────────────────────────────────────

	/**
	 * 通过 IPC 委托 main 进程 spawn Reasoner 进程。
	 * 对应 R29 的 chipos:spawnWorker handler。
	 */
	private async _spawnViaIpc(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] Spawning reasoner via IPC...');

		// 获取 Python 路径和参数
		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';
		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		const grpcPort = this._configurationService.getValue<number>('chipos.backend.grpcPort') ?? 50051;

		const env: Record<string, string> = {
			CHIPOS_REASONING_HTTP_PORT: String(httpPort),
			CHIPOS_REASONING_GRPC_PORT: String(grpcPort),
			CHIPOS_DEPLOYMENT_MODE: 'local',
		};

		// 通过 window.chiposIpc（preload 注入）或 ipcRenderer 调用
		try {
			const result = await (globalThis as any).chiposIpc?.invoke('chipos:spawnWorker', {
				pythonPath,
				moduleArgs: ['-m', 'reasoning.server.cli', 'start'],
				env,
				cwd: '.',
			});
			this._logService.info(`[ChipOS SidecarElectron] Reasoner spawned: pid=${result?.pid}`);
		} catch (err) {
			throw new Error(`IPC spawnWorker failed: ${err}`);
		}
	}

	/**
	 * 通过 IPC 启动 Worker 子进程。
	 */
	private async _startWorkerViaIpc(): Promise<void> {
		this._setWorkerState(WorkerState.Starting);

		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';
		const grpcTarget = this.grpcAddress;
		const apiKey = this._configurationService.getValue<string>('chipos.backend.apiKey') ?? '';

		const env: Record<string, string> = {
			CHIPOS_REASONING_GRPC_TARGET: grpcTarget,
			...(apiKey ? { CHIPOS_WORKER_OUTBOUND_KEY: apiKey } : {}),
		};

		try {
			const result = await (globalThis as any).chiposIpc?.invoke('chipos:spawnWorker', {
				pythonPath,
				moduleArgs: ['-m', 'execution.server.cli', 'start'],
				env,
				cwd: '.',
			});
			this._workerPid = result?.pid;
			this._setWorkerState(WorkerState.Connected);
			this._logService.info(`[ChipOS SidecarElectron] Worker started: pid=${this._workerPid}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] Worker start failed: ${msg}`);
			this._setWorkerState(WorkerState.Error);
		}
	}

	/**
	 * 通过 IPC 停止 Worker 子进程。
	 */
	private async _stopWorkerViaIpc(): Promise<void> {
		try {
			await (globalThis as any).chiposIpc?.invoke('chipos:killWorker');
			this._workerPid = undefined;
			this._setWorkerState(WorkerState.NotStarted);
		} catch (err) {
			this._logService.warn(`[ChipOS SidecarElectron] Worker stop failed: ${err}`);
		}
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
