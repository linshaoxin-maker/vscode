/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R30 + R49 + R50: SidecarManagerElectron — Electron desktop 实现。
 *
 * R49: Worker 启动策略改为 "二进制优先"：
 *   1. 已有 Worker（instance.json PID 活着） → acquire ref_count（多窗口共享）
 *   2. 本地二进制缓存 → IPC spawn 二进制
 *   3. 自动下载二进制 → IPC spawn
 *   4. Fallback: Python 开发环境
 *
 * R50: 多窗口隔离（instance.json + ref_count + workspace hash）
 *   - 不同 workspace → 不同 Worker 实例
 *   - 同 workspace 多窗口 → 共享 Worker + ref_count
 *   - dispose() 时 ref_count-- → 归零才 kill
 *
 * IPC 通道（由 sidecarManagerMain.ts 注册）：
 * - chipos:spawnProcess    → 启动子进程
 * - chipos:killProcess     → 停止子进程
 * - chipos:findBinary      → 查找缓存的二进制
 * - chipos:downloadBinary  → 下载二进制
 * - chipos:checkInstance   → 检查 instance.json + PID
 * - chipos:acquireRef      → ref_count++
 * - chipos:releaseRef      → ref_count--
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
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
	private _isSharedInstance = false;
	private _callerId: string;

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
		return `${this.reasoningUrl}/api/v1/events`;
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
		@INativeHostService _nativeHostService: INativeHostService,
		@IEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const modeStr = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
		this._mode = modeStr as BackendMode;
		this._callerId = `electron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		this._logService.info(`[ChipOS SidecarElectron] mode=${this._mode}`);
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

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

			await this._spawnWorkerViaIpc();
			await this._healthCheckLoop();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] startBackend failed: ${msg}`);
			this._setState(SidecarState.Error);
		}
	}

	async stopBackend(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] stopBackend()');

		if (this._isSharedInstance) {
			const remaining = await this._invokeIpc('chipos:releaseRef', {
				workspaceRoot: this._resolveWorkspaceRoot(),
				callerId: this._callerId,
			});
			this._logService.info(`[ChipOS SidecarElectron] Released ref, remaining=${remaining}`);
			if (remaining && remaining > 0) {
				this._workerPid = undefined;
				this._setWorkerState(WorkerState.NotStarted);
				this._setState(SidecarState.NotStarted);
				return;
			}
		}

		await this._killProcessViaIpc('worker');
		this._setWorkerState(WorkerState.NotStarted);

		if (this._mode === BackendMode.Local) {
			await this._killProcessViaIpc('reasoner');
		}

		this._setState(SidecarState.NotStarted);
	}

	async restartWorker(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] restartWorker()');
		await this._killProcessViaIpc('worker');
		await this._spawnWorkerViaIpc();
	}

	override dispose(): void {
		if (this._isSharedInstance) {
			// R50 fix: dispose 时也要检查 ref_count 归零并 kill Worker
			this._invokeIpc('chipos:releaseRef', {
				workspaceRoot: this._resolveWorkspaceRoot(),
				callerId: this._callerId,
			}).then((remaining: number | undefined) => {
				if (!remaining || remaining <= 0) {
					this._logService.info('[ChipOS SidecarElectron] dispose: ref_count=0, killing Worker');
					this._invokeIpc('chipos:killProcess', 'worker').catch(() => {});
				}
			}).catch(() => {});
		}
		super.dispose();
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	async spawn(): Promise<void> { return this.startBackend(); }
	async kill(): Promise<void> { return this.stopBackend(); }
	setManualUrl(_url: string | undefined): void { /* noop */ }

	// ── Private: IPC 委托 ────────────────────────────────────────────────

	private _resolveBackendDir(): string {
		const explicit = this._configurationService.getValue<string>('chipos.backend.dir');
		if (explicit) {
			return explicit;
		}
		const appRoot = this._environmentService.appRoot;
		const productDir = join(appRoot, 'resources', 'chipos-backend');
		const devDir = join(appRoot, '..', 'backend_v2');
		if (appRoot.includes('/out/') || appRoot.endsWith('/out')) {
			return devDir;
		}
		return productDir;
	}

	private _resolveWorkspaceRoot(): string {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders[0].uri.fsPath;
		}
		return '';
	}

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
	 * R49 + R50: Worker 启动（二进制优先 + 多窗口隔离）
	 *
	 * 启动策略：
	 *   1. chipos:checkInstance → 已有 Worker → acquireRef → done
	 *   2. chipos:findBinary → 有缓存二进制 → spawn 二进制
	 *   3. chipos:downloadBinary → 自动下载 → spawn 二进制
	 *   4. fallback → spawn Python
	 */
	private async _spawnWorkerViaIpc(): Promise<void> {
		this._setWorkerState(WorkerState.Starting);

		const grpcTarget = this.grpcAddress;
		// Phase 1 Unified Auth: use independent worker API key, NOT user JWT
		const workerApiKey = this._configurationService.getValue<string>('chipos.worker.apiKey') ?? '';
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		const tlsEnabled = this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false;
		const workspaceRoot = this._resolveWorkspaceRoot();
		const configDownloadUrl = this._configurationService.getValue<string>('chipos.worker.downloadUrl') || '';
		const configVersion = this._configurationService.getValue<string>('chipos.worker.version') || 'latest';
		const backendDir = this._resolveBackendDir();

		const env: Record<string, string> = {
			CHIPOS_REASONING_SERVER: grpcTarget,
			CHIPOS_WORKER_HTTP_PORT: String(workerHttpPort),
			CHIPOS_TLS_ENABLED: String(tlsEnabled),
			...(workerApiKey ? { CHIPOS_API_KEY: workerApiKey } : {}),
			...(workspaceRoot ? { CHIPOS_WORKSPACE_ROOT: workspaceRoot } : {}),
		};

		// --- Step 1: Check existing Worker instance (R50 multi-window) ---
		const existing = await this._invokeIpc('chipos:checkInstance', { workspaceRoot });
		if (existing?.alive) {
			this._logService.info(`[ChipOS SidecarElectron] Existing Worker (pid=${existing.pid}), acquiring ref`);
			await this._invokeIpc('chipos:acquireRef', { workspaceRoot, callerId: this._callerId });
			this._workerPid = existing.pid;
			this._isSharedInstance = true;
			// Don't blindly trust PID alive = HTTP ready; verify the Worker
			// is actually serving before declaring Connected.
			this._setWorkerState(WorkerState.Starting);
			return;
		}

		// --- Step 2: Find cached binary (R49) ---
		let binaryPath = await this._invokeIpc('chipos:findBinary', {
			version: configVersion !== 'latest' ? configVersion : undefined,
		});

		// --- Step 3: Auto-download if no cache ---
		if (!binaryPath) {
			this._logService.info('[ChipOS SidecarElectron] No cached binary, trying download...');
			binaryPath = await this._invokeIpc('chipos:downloadBinary', {
				version: configVersion,
				downloadUrl: configDownloadUrl || undefined,
			});
		}

		// --- Step 4: Spawn binary or fallback to Python ---
		if (binaryPath) {
			this._logService.info(`[ChipOS SidecarElectron] Spawning binary: ${binaryPath}`);
			try {
				const result = await this._invokeIpc('chipos:spawnProcess', {
					binaryPath,
					args: ['start', '--server', grpcTarget, '--workspace', workspaceRoot,
						'--http-port', String(workerHttpPort)],
					env,
					cwd: workspaceRoot,
					role: 'worker',
					workspaceRoot,
				});
				this._workerPid = result?.pid;
				this._isSharedInstance = true;
				this._logService.info(`[ChipOS SidecarElectron] Binary Worker spawned: pid=${this._workerPid}`);
				return;
			} catch (err) {
				this._logService.warn(`[ChipOS SidecarElectron] Binary spawn failed: ${err}, falling back to Python`);
			}
		}

		// --- Fallback: Python ---
		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';

		try {
			const result = await this._invokeIpc('chipos:spawnProcess', {
				pythonPath,
				moduleArgs: ['-m', 'execution.server.cli', 'start', '--server', grpcTarget,
					'--workspace', workspaceRoot, '--http-port', String(workerHttpPort)],
				env,
				cwd: backendDir,
				role: 'worker',
				workspaceRoot,
			});
			this._workerPid = result?.pid;
			this._isSharedInstance = true;
			this._logService.info(`[ChipOS SidecarElectron] Python Worker spawned: pid=${this._workerPid}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] Worker start failed: ${msg}`);
			this._setWorkerState(WorkerState.Error);
		}
	}

	private async _killProcessViaIpc(role: 'reasoner' | 'worker'): Promise<void> {
		try {
			await this._invokeIpc('chipos:killProcess', role);
			if (role === 'worker') {
				this._workerPid = undefined;
				this._isSharedInstance = false;
			}
		} catch (err) {
			this._logService.warn(`[ChipOS SidecarElectron] kill ${role} failed: ${err}`);
		}
	}

	private async _healthCheckLoop(): Promise<void> {
		this._setState(SidecarState.HealthChecking);
		const timeout = this._mode === BackendMode.CloudReasoning ? 60_000 : 15_000;
		const interval = 500;
		const start = Date.now();
		let attempts = 0;
		let lastError = '';

		while (Date.now() - start < timeout) {
			if (this._store.isDisposed) { return; }
			attempts++;
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
						this._logService.info('[ChipOS SidecarElectron] Health check passed');
						return;
					}
				}
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
				if (attempts % 10 === 0) {
					this._logService.info(`[ChipOS SidecarElectron] Health check attempt ${attempts}, last error: ${lastError}`);
				}
			}
			await new Promise<void>(r => setTimeout(r, interval));
		}

		this._logService.warn(`[ChipOS SidecarElectron] Health check failed after ${attempts} attempts. Last error: ${lastError}`);
		this._setState(SidecarState.Error);
	}

	private async _invokeIpc(channel: string, ...args: any[]): Promise<any> {
		const bridge = (globalThis as any).chiposIpc;
		if (!bridge) {
			const msg = `ChipOS IPC bridge not available for "${channel}". IDE installation may be incomplete.`;
			this._logService.error(`[ChipOS SidecarElectron] ${msg}`);
			throw new Error(msg);
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
