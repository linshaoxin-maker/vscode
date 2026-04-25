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
import { SelectBox, ISelectOptionItem } from '../../../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';

export class ConnectionTab extends Disposable {

	private _statusContainer!: HTMLElement;
	private _workerStatusContainer!: HTMLElement;
	private _modeSpecificContainer!: HTMLElement;
	private _modeSpecificTitleEl: HTMLElement | undefined;
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

		// ── Sub-section: Backend Mode ──
		const modeSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(modeSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.settings.section.mode', 'Backend')));
		this._renderBackendMode(modeSection);

		// ── Sub-section: Live Status ──
		const statusSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(statusSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.settings.section.status', 'Status')));
		this._renderConnectionStatus(statusSection);
		this._renderWorkerStatus(statusSection);

		// ── Sub-section: Mode-specific settings (dynamic) ──
		// Wrapped in its own section so the joined-card CSS selector
		// (.chipos-settings-section > .chipos-mode-specific > …) still applies.
		const configSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		this._modeSpecificTitleEl = dom.append(configSection, dom.$('.chipos-settings-section-title'));
		this._modeSpecificContainer = dom.append(configSection, dom.$('.chipos-mode-specific'));
		this._renderModeSpecificSettings();

		// ── Sub-section: Legacy / v1 fallback (collapsed) ──
		this._renderLegacySettings(this._container);
	}

	private _updateModeSpecificTitle(mode: string): void {
		if (!this._modeSpecificTitleEl) {
			return;
		}
		switch (mode) {
			case 'local':
				this._modeSpecificTitleEl.textContent = localize('chipos.settings.section.local', 'Local Backend');
				break;
			case 'cloud-reasoning':
				this._modeSpecificTitleEl.textContent = localize('chipos.settings.section.cloud', 'Cloud Reasoning');
				break;
			case 'manual':
				this._modeSpecificTitleEl.textContent = localize('chipos.settings.section.manual', 'Manual Endpoints');
				break;
			default:
				this._modeSpecificTitleEl.textContent = localize('chipos.settings.section.endpoints', 'Endpoints');
		}
	}

	// ── v2: Backend Mode 选择器 ─────────────────────────────────────────

	private _renderBackendMode(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.mode', 'Backend Mode')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.mode.desc', 'How the IDE connects to reasoning and execution layers. Remote-SSH is orthogonal — when connected via SSH, "local" mode runs on the remote server.')
		));

		const modeValues = ['local', 'cloud-reasoning', 'manual'];
		const modeOptions: ISelectOptionItem[] = [
			{ text: localize('chipos.mode.local', 'Local (reasoning + execution in one process)') },
			{ text: localize('chipos.mode.cloud', 'Cloud Reasoning (local execution + cloud reasoning)') },
			{ text: localize('chipos.mode.manual', 'Manual (pre-deployed, specify URLs)') },
		];

		const current = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
		const selectedIndex = Math.max(0, modeValues.indexOf(current));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const selectBox = this._disposables.add(new SelectBox(modeOptions, selectedIndex, this._contextViewProvider!, defaultSelectBoxStyles));
		selectBox.render(selectContainer);

		this._disposables.add(selectBox.onDidSelect(e => {
			if (e.index < modeValues.length) {
				this._configurationService.updateValue('chipos.backend.mode', modeValues[e.index], ConfigurationTarget.USER);
				this._renderModeSpecificSettings();
			}
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.backend.mode')) {
				const mode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
				const idx = modeValues.indexOf(mode);
				if (idx >= 0) {
					selectBox.select(idx);
				}
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

		// Worker is an independent process in all modes — always show status
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
		this._updateModeSpecificTitle(mode);

		switch (mode) {
			case 'local':
				this._renderWorkerHttpPortInput(this._modeSpecificContainer);
				this._renderWorkerHttpUrlInput(this._modeSpecificContainer);
				this._renderPythonPathInput(this._modeSpecificContainer);
				this._renderBackendDirInput(this._modeSpecificContainer);
				break;

			case 'cloud-reasoning':
				// Authentication has moved to the General tab.
				this._renderWebsiteUrlInput(this._modeSpecificContainer);
				this._renderReasoningUrlInput(this._modeSpecificContainer);
				this._renderGrpcAddressInput(this._modeSpecificContainer);
				this._renderTokenInput(this._modeSpecificContainer);
				this._renderWorkerApiKeyInput(this._modeSpecificContainer);
				this._renderTlsEnabled(this._modeSpecificContainer);
				this._renderWorkerHttpPortInput(this._modeSpecificContainer);
				this._renderWorkerHttpUrlInput(this._modeSpecificContainer);
				this._renderPythonPathInput(this._modeSpecificContainer);
				this._renderBackendDirInput(this._modeSpecificContainer);
				break;

			case 'manual':
				// Authentication has moved to the General tab.
				this._renderWebsiteUrlInput(this._modeSpecificContainer);
				this._renderReasoningUrlInput(this._modeSpecificContainer);
				this._renderTokenInput(this._modeSpecificContainer);
				this._renderWorkerApiKeyInput(this._modeSpecificContainer);
				this._renderTlsEnabled(this._modeSpecificContainer);
				this._renderWorkerHttpUrlInput(this._modeSpecificContainer);
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
			validationOptions: {
				validation: (value) => {
					if (!value) { return null; }
					try {
						const u = new URL(value);
						if (u.protocol !== 'http:' && u.protocol !== 'https:') {
							return { content: localize('chipos.settings.reasoningUrl.invalid', 'Must start with http:// or https://'), type: 2 };
						}
					} catch {
						return { content: localize('chipos.settings.reasoningUrl.invalid', 'Must start with http:// or https://'), type: 2 };
					}
					return null;
				}
			}
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.reasoningUrl') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			if (!value) {
				this._configurationService.updateValue('chipos.backend.reasoningUrl', value, ConfigurationTarget.USER);
				return;
			}
			try {
				const u = new URL(value);
				if (u.protocol === 'http:' || u.protocol === 'https:') {
					this._configurationService.updateValue('chipos.backend.reasoningUrl', value, ConfigurationTarget.USER);
				}
			} catch { /* invalid URL — don't save */ }
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
			validationOptions: {
				validation: (value) => {
					if (!value) { return null; }
					// host:port  or  host (port optional)
					const m = value.match(/^([^:]+)(?::(\d+))?$/);
					if (!m) {
						return { content: localize('chipos.settings.grpcAddress.invalid', 'Format: host:port (e.g. reasoning.chipos.ai:50051)'), type: 2 };
					}
					if (m[2]) {
						const port = parseInt(m[2]);
						if (port < 1 || port > 65535) {
							return { content: localize('chipos.settings.port.invalid', 'Port must be between 1024 and 65535'), type: 2 };
						}
					}
					return null;
				}
			}
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.grpcAddress') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			if (!value) {
				this._configurationService.updateValue('chipos.backend.grpcAddress', value, ConfigurationTarget.USER);
				return;
			}
			const m = value.match(/^([^:]+)(?::(\d+))?$/);
			if (m && (!m[2] || (parseInt(m[2]) >= 1 && parseInt(m[2]) <= 65535))) {
				this._configurationService.updateValue('chipos.backend.grpcAddress', value, ConfigurationTarget.USER);
			}
		}));
	}

	// ── Phase 1 Unified Auth: Worker API Key input ──

	private _renderWebsiteUrlInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.websiteUrl', 'ChipOS Website URL')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.websiteUrl.desc', 'Required for OAuth login and token refresh. Example: http://121.89.82.122')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'http://121.89.82.122',
			inputBoxStyles: defaultInputBoxStyles,
			validationOptions: {
				validation: (value) => {
					if (!value) {
						return { content: localize('chipos.settings.websiteUrl.required', 'Required for OAuth login and refresh'), type: 1 };
					}
					try {
						const u = new URL(value);
						if (u.protocol !== 'http:' && u.protocol !== 'https:') {
							return { content: localize('chipos.settings.websiteUrl.invalid', 'Must start with http:// or https://'), type: 2 };
						}
					} catch {
						return { content: localize('chipos.settings.websiteUrl.invalid', 'Must start with http:// or https://'), type: 2 };
					}
					return null;
				}
			}
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.auth.websiteUrl') || '';
		this._disposables.add(inputBox.onDidChange(value => {
			if (!value) {
				this._configurationService.updateValue('chipos.auth.websiteUrl', value, ConfigurationTarget.USER);
				return;
			}
			try {
				const u = new URL(value);
				if (u.protocol === 'http:' || u.protocol === 'https:') {
					this._configurationService.updateValue('chipos.auth.websiteUrl', value, ConfigurationTarget.USER);
				}
			} catch {
				// invalid URL — don't save
			}
		}));
	}

	private _renderWorkerApiKeyInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.workerApiKey', 'Worker API Key')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.workerApiKey.desc', 'Independent API key for Worker → Reasoner gRPC authentication. Separate from user login token.')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, undefined, {
			type: 'password',
			placeholder: localize('chipos.settings.workerApiKey.placeholder', 'Worker API key (optional for local mode)'),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.worker.apiKey') ?? '';
		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.worker.apiKey', value, ConfigurationTarget.USER);
		}));
	}

	private _renderTokenInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.token', 'Manual Token (Legacy Fallback)')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.token.desc', 'Manual JWT token fallback. Prefer using the Login button above for OAuth authentication.')
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

	// ── v2: Worker HTTP Port ─────────────────────────────────────────────

	private _renderWorkerHttpPortInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.workerHttpPort', 'Worker HTTP Port')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.workerHttpPort.desc', 'HTTP port for the Worker process (default: 8081).')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: '8081',
			type: 'number',
			inputBoxStyles: defaultInputBoxStyles,
			validationOptions: {
				validation: (value) => {
					const n = parseInt(value);
					if (isNaN(n) || n < 1024 || n > 65535) {
						return { content: localize('chipos.settings.port.invalid', 'Port must be between 1024 and 65535'), type: 2 };
					}
					return null;
				}
			}
		}));
		inputBox.value = String(this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081);

		this._disposables.add(inputBox.onDidChange(value => {
			const n = parseInt(value);
			if (!isNaN(n) && n >= 1024 && n <= 65535) {
				this._configurationService.updateValue('chipos.backend.workerHttpPort', n, ConfigurationTarget.USER);
			}
		}));
	}

	// ── v2: Worker HTTP URL (override) ───────────────────────────────────

	private _renderWorkerHttpUrlInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.workerHttpUrl', 'Worker HTTP URL (override)')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.workerHttpUrl.desc', 'Explicit Worker HTTP URL. Leave empty to auto-derive from port.')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'http://127.0.0.1:8081',
			inputBoxStyles: defaultInputBoxStyles,
			validationOptions: {
				validation: (value) => {
					if (!value) { return null; }
					try {
						const u = new URL(value);
						if (u.protocol !== 'http:' && u.protocol !== 'https:') {
							return { content: localize('chipos.settings.reasoningUrl.invalid', 'Must start with http:// or https://'), type: 2 };
						}
					} catch {
						return { content: localize('chipos.settings.reasoningUrl.invalid', 'Must start with http:// or https://'), type: 2 };
					}
					return null;
				}
			}
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.workerHttpUrl') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			if (!value) {
				this._configurationService.updateValue('chipos.backend.workerHttpUrl', value, ConfigurationTarget.USER);
				return;
			}
			try {
				const u = new URL(value);
				if (u.protocol === 'http:' || u.protocol === 'https:') {
					this._configurationService.updateValue('chipos.backend.workerHttpUrl', value, ConfigurationTarget.USER);
				}
			} catch { /* invalid — don't save */ }
		}));
	}

	// ── v2: Python Path ──────────────────────────────────────────────────

	private _renderPythonPathInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.pythonPath', 'Python Path')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.pythonPath.desc', 'Path to Python executable for spawning backend processes (default: python3).')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'python3',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.pythonPath') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.backend.pythonPath', value, ConfigurationTarget.USER);
		}));
	}

	// ── v2: Backend Directory ────────────────────────────────────────────

	private _renderBackendDirInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.backendDir', 'Backend Directory')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.backendDir.desc', 'Path to the ChipOS backend directory. Leave empty for auto-detection.')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: '/path/to/backend',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.dir') || '';

		this._disposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.backend.dir', value, ConfigurationTarget.USER);
		}));
	}

	// ── v2: TLS Enabled ─────────────────────────────────────────────────

	private _renderTlsEnabled(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const checkbox = this._disposables.add(new Checkbox(
			localize('chipos.settings.tlsEnabled', 'Enable TLS for gRPC'),
			this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false,
			defaultCheckboxStyles,
		));
		dom.append(row, checkbox.domNode);

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.tlsEnabled.desc', 'Enable TLS encryption for gRPC connections between Worker and Reasoner.')
		));

		this._disposables.add(checkbox.onChange(() => {
			this._configurationService.updateValue('chipos.backend.tlsEnabled', checkbox.checked, ConfigurationTarget.USER);
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
