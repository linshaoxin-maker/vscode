/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';

/**
 * Browser-safe implementation of ISidecarManagerService.
 *
 * Does NOT spawn a child process (that requires Node.js APIs unavailable
 * in the renderer). Instead it relies on a manually started backend
 * configured via `chipos.sidecar.manualUrl`.
 *
 * A future iteration can bridge to the main process via IPC for real
 * process management.
 */
export class SidecarManagerBrowser extends Disposable implements ISidecarManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<SidecarState>());
	readonly onDidChangeState: Event<SidecarState> = this._onDidChangeState.event;

	private _state = SidecarState.NotStarted;
	private _port = 0;
	private _manualUrl: string | undefined;

	get state(): SidecarState { return this._state; }
	get port(): number { return this._port; }

	get wsUrl(): string {
		if (this._manualUrl) {
			return this._manualUrl;
		}
		return `ws://127.0.0.1:${this._port}/ws/agent`;
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._port = this._configurationService.getValue<number>('chipos.sidecar.port') ?? 8000;
	}

	async spawn(): Promise<void> {
		if (this._manualUrl) {
			this._logService.info('[ChipOS SidecarBrowser] Using manual URL:', this._manualUrl);
			this._setState(SidecarState.Connected);
			return;
		}

		this._logService.warn(
			'[ChipOS SidecarBrowser] Auto-start is not supported in the browser layer. '
			+ 'Please start the backend manually and set chipos.sidecar.manualUrl.'
		);
		this._setState(SidecarState.Error);
	}

	async kill(): Promise<void> {
		this._logService.info('[ChipOS SidecarBrowser] kill() called');
		this._setState(SidecarState.Disconnected);
	}

	setManualUrl(url: string | undefined): void {
		this._manualUrl = url;
		if (url) {
			this._logService.info('[ChipOS SidecarBrowser] Manual URL set:', url);
		}
	}

	private _setState(s: SidecarState): void {
		if (this._state !== s) {
			this._state = s;
			this._onDidChangeState.fire(s);
		}
	}
}
