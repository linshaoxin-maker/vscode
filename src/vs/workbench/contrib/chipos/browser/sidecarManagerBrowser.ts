/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState, BackendMode, WorkerState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';

/**
 * Browser-safe implementation of ISidecarManagerService.
 *
 * Does NOT spawn a child process (that requires Node.js APIs unavailable
 * in the renderer). Instead it relies on a manual URL or pre-deployed backend.
 * This is used in Web IDE mode (场景 C).
 */
export class SidecarManagerBrowser extends Disposable implements ISidecarManagerService {

	declare readonly _serviceBrand: undefined;

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	private readonly _onDidChangeState = this._register(new Emitter<SidecarState>());
	readonly onDidChangeState: Event<SidecarState> = this._onDidChangeState.event;

	private _state: SidecarState = SidecarState.NotStarted;
	private _manualUrl: string | undefined;

	get state(): SidecarState { return this._state; }
	get port(): number { return 0; }
	get wsUrl(): string { return this._manualUrl ?? ''; }

	// ── v2: BackendManager ───────────────────────────────────────────────

	private readonly _onDidChangeWorkerState = this._register(new Emitter<WorkerState>());
	readonly onDidChangeWorkerState: Event<WorkerState> = this._onDidChangeWorkerState.event;

	private _workerState: WorkerState = WorkerState.NotStarted;

	get mode(): BackendMode { return BackendMode.Manual; }
	get workerState(): WorkerState { return this._workerState; }
	get reasoningUrl(): string {
		return this._configurationService.getValue<string>('chipos.backend.reasoningUrl') || '';
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		const manualUrl = this._configurationService.getValue<string>('chipos.sidecar.manualUrl');
		if (manualUrl) {
			this._manualUrl = manualUrl;
		}
	}

	// ── v1 ──

	async spawn(): Promise<void> {
		if (this._manualUrl) {
			this._logService.info('[ChipOS SidecarBrowser] Using manual URL:', this._manualUrl);
			this._setState(SidecarState.Connected);
		} else {
			this._logService.warn('[ChipOS SidecarBrowser] Cannot spawn in browser mode. Set chipos.sidecar.manualUrl or use chipos.backend.mode=manual.');
			this._setState(SidecarState.Error);
		}
	}

	async kill(): Promise<void> {
		this._setState(SidecarState.Disconnected);
	}

	setManualUrl(url: string | undefined): void {
		this._manualUrl = url;
		if (url) {
			this._logService.info('[ChipOS SidecarBrowser] Manual URL set:', url);
		}
	}

	// ── v2 ──

	async startBackend(): Promise<void> {
		// 浏览器模式 = 场景 C，后端预部署，直接标记连接
		this._setState(SidecarState.Connected);
		this._setWorkerState(WorkerState.Connected);
		this._logService.info('[ChipOS SidecarBrowser] Browser mode, assuming pre-deployed backend');
	}

	async stopBackend(): Promise<void> {
		this._setState(SidecarState.Disconnected);
		this._setWorkerState(WorkerState.NotStarted);
	}

	async restartWorker(): Promise<void> {
		this._logService.warn('[ChipOS SidecarBrowser] Cannot restart worker in browser mode');
	}

	// ── State ──

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
