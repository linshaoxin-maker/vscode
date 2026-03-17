/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState } from '../../../common/sidecarService.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../../../base/browser/ui/toggle/toggle.js';
import { defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';

export class ConnectionTab extends Disposable {

	private _statusContainer!: HTMLElement;
	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
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

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewService, {
			placeholder: 'ws://127.0.0.1:8000/ws/agent',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.sidecar.manualUrl') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.sidecar.manualUrl', value, ConfigurationTarget.USER);
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.sidecar.manualUrl')) {
				inputBox.value = this._configurationService.getValue<string>('chipos.sidecar.manualUrl') || '';
			}
		}));
	}

	private _renderSidecarPort(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.sidecarPort', 'Sidecar Port')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.sidecarPort.desc', 'Starting port for the Sidecar backend (auto-increments if occupied).')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewService, {
			placeholder: '8765',
			type: 'number',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = String(this._configurationService.getValue<number>('chipos.sidecar.port') ?? 8765);

		this._disposables.add(inputBox.onDidChange(value => {
			const val = Math.max(1024, Math.min(65535, parseInt(value) || 8765));
			this._configurationService.updateValue('chipos.sidecar.port', val, ConfigurationTarget.USER);
		}));
	}

	private _renderAutoStart(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const checkbox = this._disposables.add(new Checkbox(
			localize('chipos.settings.autoStart', 'Auto-Start Sidecar'),
			this._configurationService.getValue<boolean>('chipos.sidecar.autoStart') ?? false,
			defaultCheckboxStyles,
		));
		dom.append(row, checkbox.domNode);

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.autoStart.desc', 'Automatically start the Sidecar backend when the IDE launches.')));

		this._disposables.add(checkbox.onChange(() => {
			this._configurationService.updateValue('chipos.sidecar.autoStart', checkbox.checked, ConfigurationTarget.USER);
		}));
	}

	private _renderAutoRestart(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const checkbox = this._disposables.add(new Checkbox(
			localize('chipos.settings.autoRestart', 'Auto-Restart on Crash'),
			this._configurationService.getValue<boolean>('chipos.sidecar.autoRestart') ?? true,
			defaultCheckboxStyles,
		));
		dom.append(row, checkbox.domNode);

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.autoRestart.desc', 'Automatically restart the Sidecar backend if it crashes (up to 3 attempts).')));

		this._disposables.add(checkbox.onChange(() => {
			this._configurationService.updateValue('chipos.sidecar.autoRestart', checkbox.checked, ConfigurationTarget.USER);
		}));
	}
}
