/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState, BackendMode, WorkerState } from '../../../common/sidecarService.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../../../base/browser/ui/toggle/toggle.js';
import { defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';

export class ConnectionTab extends Disposable {

	private _statusContainer!: HTMLElement;
	private _workerStatusContainer!: HTMLElement;
	private _modeSpecificContainer!: HTMLElement;
	private readonly _disposables = this._register(new DisposableStore());
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@IContextViewService contextViewService: IContextViewService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
		this._render();
	}

	private _render(): void {
		dom.clearNode(this._container);

		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.settings.connection', 'Connection Settings')));

		// v2: 模式选择器 + 双状态指示器
		this._renderBackendMode(section);
		this._renderConnectionStatus(section);
		this._renderWorkerStatus(section);

		// v2: 模式相关配置（动态显示）
		this._modeSpecificContainer = dom.append(section, dom.$('.chipos-mode-specific'));
		this._renderModeSpecificSettings();

		// v1 兼容配置（折叠）
		this._renderLegacySettings(section);
	}

	// ── v2: Backend Mode 选择器 ─────────────────────────────────────────

	private _renderBackendMode(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.mode', 'Backend Mode')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.mode.desc', 'How the IDE connects to reasoning and execution layers. Remote-SSH is orthogonal — when connected via SSH, "local" mode runs on the remote server.')
		));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const select = dom.append(selectContainer, dom.$('select.chipos-mode-select')) as HTMLSelectElement;

		const modes: { value: string; label: string }[] = [
			{ value: 'local', label: localize('chipos.mode.local', 'Local (reasoning + execution in one process)') },
			{ value: 'cloud-reasoning', label: localize('chipos.mode.cloud', 'Cloud Reasoning (local execution + cloud reasoning)') },
			{ value: 'manual', label: localize('chipos.mode.manual', 'Manual (pre-deployed, specify URLs)') },
		];

		for (const mode of modes) {
			const option = dom.append(select, dom.$('option')) as HTMLOptionElement;
			option.value = mode.value;
			option.textContent = mode.label;
		}

		select.value = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';

		this._disposables.add(dom.addDisposableListener(select, 'change', () => {
			this._configurationService.updateValue('chipos.backend.mode', select.value, ConfigurationTarget.USER);
			this._renderModeSpecificSettings();
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.backend.mode')) {
				select.value = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
				this._renderModeSpecificSettings();
			}
		}));
	}

	// ── v2: 推理层连接状态 ──────────────────────────────────────────────

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
				label = localize('chipos.connection.connected', 'Reasoning: Connected');
				break;
			case SidecarState.Spawning:
			case SidecarState.HealthChecking:
				cssClass = 'connecting';
				label = localize('chipos.connection.connecting', 'Reasoning: Connecting...');
				break;
			case SidecarState.Error:
				cssClass = 'disconnected';
				label = localize('chipos.connection.error', 'Reasoning: Error — check backend status');
				break;
			default:
				cssClass = 'disconnected';
				label = localize('chipos.connection.disconnected', 'Reasoning: Not connected');
				break;
		}

		this._statusContainer.className = `chipos-connection-status ${cssClass}`;
		dom.append(this._statusContainer, dom.$('.chipos-status-dot'));
		dom.append(this._statusContainer, dom.$('span', undefined, label));
	}

	// ── v2: Worker 连接状态 ─────────────────────────────────────────────

	private _renderWorkerStatus(parent: HTMLElement): void {
		this._workerStatusContainer = dom.append(parent, dom.$('.chipos-connection-status'));
		this._updateWorkerStatus();

		this._disposables.add(this._sidecarManager.onDidChangeWorkerState(() => {
			this._updateWorkerStatus();
		}));
	}

	private _updateWorkerStatus(): void {
		const mode = this._sidecarManager.mode;
		const state = this._sidecarManager.workerState;
		dom.clearNode(this._workerStatusContainer);

		if (mode === BackendMode.Local) {
			this._workerStatusContainer.style.display = 'none';
			return;
		}
		this._workerStatusContainer.style.display = '';

		// Manual mode: Worker is externally managed
		if (mode === BackendMode.Manual) {
			this._workerStatusContainer.className = 'chipos-connection-status connected';
			dom.append(this._workerStatusContainer, dom.$('.chipos-status-dot'));
			dom.append(this._workerStatusContainer, dom.$('span', undefined,
				localize('chipos.worker.external', 'Worker: Managed externally')
			));
			return;
		}

		let cssClass: string;
		let label: string;

		switch (state) {
			case WorkerState.Connected:
				cssClass = 'connected';
				label = localize('chipos.worker.connected', 'Worker: Connected');
				break;
			case WorkerState.Starting:
				cssClass = 'connecting';
				label = localize('chipos.worker.starting', 'Worker: Starting...');
				break;
			case WorkerState.Error:
				cssClass = 'disconnected';
				label = localize('chipos.worker.error', 'Worker: Error');
				break;
			default:
				cssClass = 'disconnected';
				label = localize('chipos.worker.disconnected', 'Worker: Not started');
				break;
		}

		this._workerStatusContainer.className = `chipos-connection-status ${cssClass}`;
		dom.append(this._workerStatusContainer, dom.$('.chipos-status-dot'));
		dom.append(this._workerStatusContainer, dom.$('span', undefined, label));
	}

	// ── v2: 模式相关配置（动态渲染）─────────────────────────────────────

	private _renderModeSpecificSettings(): void {
		dom.clearNode(this._modeSpecificContainer);

		const mode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';

		switch (mode) {
			case 'local':
				// local 模式无额外配置
				dom.append(this._modeSpecificContainer, dom.$('.chipos-setting-hint', undefined,
					localize('chipos.mode.local.hint', 'No additional configuration needed. The backend starts automatically.')
				));
				break;

			case 'cloud-reasoning':
				this._renderReasoningUrlInput(this._modeSpecificContainer);
				this._renderGrpcAddressInput(this._modeSpecificContainer);
				this._renderTokenInput(this._modeSpecificContainer);
				break;

			case 'manual':
				this._renderReasoningUrlInput(this._modeSpecificContainer);
				this._renderTokenInput(this._modeSpecificContainer);
				dom.append(this._modeSpecificContainer, dom.$('.chipos-setting-hint', undefined,
					localize('chipos.mode.manual.hint', 'Worker is managed externally. Deploy it separately and point it to the Reasoning gRPC address.')
				));
				break;
		}
	}

	private _renderReasoningUrlInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.reasoningUrl', 'Reasoning Layer URL')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.reasoningUrl.desc', 'URL of the reasoning layer (e.g. https://reasoning.chipos.ai)')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'https://reasoning.chipos.ai',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.reasoningUrl') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.backend.reasoningUrl', value, ConfigurationTarget.USER);
		}));
	}

	private _renderGrpcAddressInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.grpcAddress', 'Worker gRPC Target')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.grpcAddress.desc', 'gRPC address for the local Worker to connect to the Reasoning server (e.g. reasoning.chipos.ai:50051). If empty, derived from Reasoning URL host + port 50051.')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'reasoning.chipos.ai:50051',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.grpcAddress') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.backend.grpcAddress', value, ConfigurationTarget.USER);
		}));
	}

	private _renderTokenInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.token', 'Authentication Token')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.token.desc', 'JWT token for authenticating with the reasoning layer')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'eyJhbGciOiJIUzI1NiIs...',
			type: 'password',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.token') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.backend.token', value, ConfigurationTarget.USER);
		}));
	}

	// ── v1 兼容配置（折叠区域）──────────────────────────────────────────

	private _renderLegacySettings(parent: HTMLElement): void {
		const details = dom.append(parent, dom.$('details.chipos-legacy-settings'));
		dom.append(details, dom.$('summary', undefined,
			localize('chipos.settings.legacy', 'Legacy Settings (v1 Sidecar)')
		));

		const content = dom.append(details, dom.$('.chipos-legacy-content'));
		this._renderManualUrl(content);
		this._renderSidecarPort(content);
		this._renderAutoStart(content);
		this._renderAutoRestart(content);
	}

	private _renderManualUrl(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.manualUrl', 'Manual Backend URL')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.manualUrl.desc', 'Set a manual WebSocket URL for development mode. When set, Sidecar auto-start is bypassed. Example: ws://127.0.0.1:8000/ws/agent')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
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
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
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
