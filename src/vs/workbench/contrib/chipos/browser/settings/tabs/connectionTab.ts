/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState } from '../../../common/sidecarService.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';

export class ConnectionTab extends Disposable {

	private _statusContainer!: HTMLElement;
	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		dom.clearNode(this._container);

		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.settings.connection', 'Connection Settings')));

		this._renderConnectionStatus(section);
		this._renderManualUrl(section);
		this._renderSidecarPort(section);
		this._renderAutoStart(section);
		this._renderAutoRestart(section);
	}

	private _renderConnectionStatus(parent: HTMLElement): void {
		this._statusContainer = dom.append(parent, dom.$('.chipos-connection-status'));
		this._updateConnectionStatus();

		this._disposables.add(this._sidecarManager.onDidChangeState(() => {
			this._updateConnectionStatus();
		}));
	}

	private _updateConnectionStatus(): void {
		const state = this._sidecarManager.state;
		dom.clearNode(this._statusContainer);

		let cssClass: string;
		let label: string;

		switch (state) {
			case SidecarState.Connected:
				cssClass = 'connected';
				label = localize('chipos.connection.connected', 'Connected to Sidecar backend');
				break;
			case SidecarState.Spawning:
			case SidecarState.HealthChecking:
				cssClass = 'connecting';
				label = localize('chipos.connection.connecting', 'Connecting to Sidecar backend...');
				break;
			case SidecarState.Error:
				cssClass = 'disconnected';
				label = localize('chipos.connection.error', 'Connection error — check backend status');
				break;
			default:
				cssClass = 'disconnected';
				label = localize('chipos.connection.disconnected', 'Not connected');
				break;
		}

		this._statusContainer.className = `chipos-connection-status ${cssClass}`;
		dom.append(this._statusContainer, dom.$('.chipos-status-dot'));
		dom.append(this._statusContainer, dom.$('span', undefined, label));
	}

	private _renderManualUrl(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.manualUrl', 'Manual Backend URL')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.manualUrl.desc', 'Set a manual WebSocket URL for development mode. When set, Sidecar auto-start is bypassed. Example: ws://127.0.0.1:8000/ws/agent')));

		const input = dom.append(row, dom.$<HTMLInputElement>('input.chipos-setting-input'));
		input.type = 'text';
		input.placeholder = 'ws://127.0.0.1:8000/ws/agent';
		input.value = this._configurationService.getValue<string>('chipos.sidecar.manualUrl') || '';

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			this._configurationService.updateValue('chipos.sidecar.manualUrl', input.value, ConfigurationTarget.USER);
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.sidecar.manualUrl')) {
				input.value = this._configurationService.getValue<string>('chipos.sidecar.manualUrl') || '';
			}
		}));
	}

	private _renderSidecarPort(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.sidecarPort', 'Sidecar Port')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.sidecarPort.desc', 'Starting port for the Sidecar backend (auto-increments if occupied).')));

		const input = dom.append(row, dom.$<HTMLInputElement>('input.chipos-setting-input'));
		input.type = 'number';
		input.min = '1024';
		input.max = '65535';
		input.value = String(this._configurationService.getValue<number>('chipos.sidecar.port') ?? 8765);

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			const val = Math.max(1024, Math.min(65535, parseInt(input.value) || 8765));
			input.value = String(val);
			this._configurationService.updateValue('chipos.sidecar.port', val, ConfigurationTarget.USER);
		}));
	}

	private _renderAutoStart(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const toggle = dom.append(row, dom.$('.chipos-toggle'));
		const input = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		input.type = 'checkbox';
		input.checked = this._configurationService.getValue<boolean>('chipos.sidecar.autoStart') ?? false;
		dom.append(toggle, dom.$('.chipos-toggle-slider'));

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.autoStart', 'Auto-Start Sidecar')));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.autoStart.desc', 'Automatically start the Sidecar backend when the IDE launches.')));

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			this._configurationService.updateValue('chipos.sidecar.autoStart', input.checked, ConfigurationTarget.USER);
		}));
	}

	private _renderAutoRestart(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const toggle = dom.append(row, dom.$('.chipos-toggle'));
		const input = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		input.type = 'checkbox';
		input.checked = this._configurationService.getValue<boolean>('chipos.sidecar.autoRestart') ?? true;
		dom.append(toggle, dom.$('.chipos-toggle-slider'));

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.autoRestart', 'Auto-Restart on Crash')));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.autoRestart.desc', 'Automatically restart the Sidecar backend if it crashes (up to 3 attempts).')));

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			this._configurationService.updateValue('chipos.sidecar.autoRestart', input.checked, ConfigurationTarget.USER);
		}));
	}
}
