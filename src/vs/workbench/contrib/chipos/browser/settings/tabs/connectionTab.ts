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
	private _modeSpecificContainer: HTMLElement | undefined;
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

		const developerMode = this._configurationService.getValue<boolean>('chipos.backend.developerMode') ?? false;

		// ── Sub-section: Live Status (always shown) ──
		const statusSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(statusSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.settings.section.status', 'Status')));
		this._renderResolvedMode(statusSection);
		this._renderConnectionStatus(statusSection);
		this._renderWorkerStatus(statusSection);

		// ── Sub-section: Developer Mode toggle ──
		// Always shown so the user can enable it without hand-editing settings.json.
		const devSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(devSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.settings.section.developer', 'Developer Options')));
		this._renderDeveloperModeToggle(devSection);

		if (developerMode) {
			// ── Sub-section: Backend Mode override (developer-only) ──
			const modeSection = dom.append(this._container, dom.$('.chipos-settings-section'));
			dom.append(modeSection, dom.$('.chipos-settings-section-title', undefined,
				localize('chipos.settings.section.mode', 'Backend Mode (Developer Override)')));
			this._renderBackendMode(modeSection);

			// ── Sub-section: Mode-specific settings (dynamic) ──
			const configSection = dom.append(this._container, dom.$('.chipos-settings-section'));
			this._modeSpecificTitleEl = dom.append(configSection, dom.$('.chipos-settings-section-title'));
			this._modeSpecificContainer = dom.append(configSection, dom.$('.chipos-mode-specific'));
			this._renderModeSpecificSettings();

			// ── Sub-section: Legacy / v1 fallback (collapsed, dev only) ──
			this._renderLegacySettings(this._container);
		}

		// Re-render the whole tab if developerMode toggles on/off.
		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.backend.developerMode')) {
				this._render();
			}
		}));
	}

	// ── New: read-only "resolved mode" indicator ─────────────────────────
	private _renderResolvedMode(parent: HTMLElement): void {
		const update = () => {
			// Clean up any prior row first
			const prior = parent.querySelector('.chipos-resolved-mode');
			if (prior) { prior.remove(); }

			const row = dom.append(parent, dom.$('.chipos-resolved-mode'));
			const resolved = this._sidecarManager.mode;
			const label = resolved === BackendMode.Auto
				? localize('chipos.mode.resolving', 'Mode: detecting...')
				: localize('chipos.mode.resolved', 'Mode: {0} (auto-detected)', resolved);
			dom.append(row, dom.$('span', undefined, label));
		};
		update();
		this._disposables.add(this._sidecarManager.onDidChangeState(update));
	}

	// ── New: developer mode toggle ───────────────────────────────────────
	private _renderDeveloperModeToggle(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const checkbox = this._disposables.add(new Checkbox(
			localize('chipos.settings.developerMode', 'Developer Mode'),
			this._configurationService.getValue<boolean>('chipos.backend.developerMode') ?? false,
			defaultCheckboxStyles,
		));
		dom.append(row, checkbox.domNode);

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.developerMode.desc', 'Show advanced backend settings (mode override, raw URLs/ports). Most users should leave this off — backend deployment is auto-detected based on whether you are connected via Remote-SSH and whether services are already running.')
		));

		this._disposables.add(checkbox.onChange(() => {
			this._configurationService.updateValue('chipos.backend.developerMode', checkbox.checked, ConfigurationTarget.USER);
		}));
	}

	private _updateModeSpecificTitle(mode: string): void {
		if (!this._modeSpecificTitleEl) {
			return;
		}
		switch (mode) {
			case 'auto':
				this._modeSpecificTitleEl.textContent = localize('chipos.settings.section.auto', 'Auto-Detected Endpoints');
				break;
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
			localize('chipos.settings.mode.desc', 'Override auto-detection. "auto" looks at workspace remoteness and existing processes to pick the right mode — recommended.')
		));

		const modeValues = ['auto', 'local', 'cloud-reasoning', 'manual'];
		const modeOptions: ISelectOptionItem[] = [
			{ text: localize('chipos.mode.auto', 'Auto (recommended — detect from environment)') },
			{ text: localize('chipos.mode.local', 'Local (spawn reasoning + execution on this machine)') },
			{ text: localize('chipos.mode.cloud', 'Cloud Reasoning (local execution + remote reasoning)') },
			{ text: localize('chipos.mode.manual', 'Manual (connect to pre-deployed URLs)') },
		];

		const current = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
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
				const mode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
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
		// In non-developer mode the container isn't created; nothing to render.
		const container = this._modeSpecificContainer;
		if (!container) {
			return;
		}
		dom.clearNode(container);

		const mode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
		this._updateModeSpecificTitle(mode);

		switch (mode) {
			case 'auto':
				// In auto mode we don't render an editable form — settings used at
				// runtime are derived from the resolved mode and the URL fields
				// below (which are still useful for power users).
				dom.append(container, dom.$('.chipos-setting-hint', undefined,
					localize('chipos.mode.auto.hint', 'Auto mode picks Local / Cloud Reasoning / Manual based on workspace remoteness and existing processes. Switch to a specific mode above to edit endpoint URLs directly.')
				));
				this._renderReasoningUrlInput(container);
				this._renderWorkerHttpUrlInput(container);
				break;

			case 'local':
				this._renderWorkerHttpPortInput(container);
				this._renderWorkerHttpUrlInput(container);
				this._renderPythonPathInput(container);
				this._renderBackendDirInput(container);
				break;

			case 'cloud-reasoning':
				// Authentication has moved to the General tab.
				// `grpcAddress` is intentionally NOT exposed: it's auto-derived
				// from `reasoningUrl.host + grpcPort` for the only case where
				// it matters (IDE-side spawning a local Worker). Power users
				// can still override via raw settings.json if needed.
				this._renderWebsiteUrlInput(container);
				this._renderReasoningUrlInput(container);
				this._renderTokenInput(container);
				this._renderWorkerApiKeyInput(container);
				this._renderTlsEnabled(container);
				this._renderWorkerHttpPortInput(container);
				this._renderWorkerHttpUrlInput(container);
				this._renderPythonPathInput(container);
				this._renderBackendDirInput(container);
				break;

			case 'manual':
				// Authentication has moved to the General tab.
				this._renderWebsiteUrlInput(container);
				this._renderReasoningUrlInput(container);
				this._renderTokenInput(container);
				this._renderWorkerApiKeyInput(container);
				this._renderTlsEnabled(container);
				this._renderWorkerHttpUrlInput(container);
				dom.append(container, dom.$('.chipos-setting-hint', undefined,
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

	// `_renderGrpcAddressInput` removed — grpcAddress is auto-derived from
	// reasoningUrl.host + grpcPort in the only case it matters (IDE-side
	// Worker spawn). Power users can still override via raw settings.json.

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
