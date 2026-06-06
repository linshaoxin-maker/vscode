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
import { IProductService } from '../../../../../../platform/product/common/productService.js';

export class ConnectionTab extends Disposable {

	private _statusContainer!: HTMLElement;
	private _workerStatusContainer!: HTMLElement;
	private _modeSpecificContainer: HTMLElement | undefined;
	private _modeSpecificTitleEl: HTMLElement | undefined;
	private readonly _disposables = this._register(new DisposableStore());
	// The mode-specific inputs (InputBoxes + their listeners) are re-created every
	// time the backend mode changes (`_renderModeSpecificSettings` clearNodes +
	// rebuilds). They must NOT go on `_disposables` — that leaks a full set of
	// InputBox widgets per mode change. This store is cleared on each rebuild.
	private readonly _modeSettingsDisposables = this._register(new DisposableStore());
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@IContextViewService contextViewService: IContextViewService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
		this._render();
	}

	private _render(): void {
		dom.clearNode(this._container);

		// Build-time flag from product.json. End-user release builds set this
		// to false (or omit it); ChipOS-team / private-deployment-debug builds
		// set it to true. NOT a runtime user setting — there is intentionally
		// no in-IDE toggle for this.
		const developerBuild = this._productService.chiposDefaults?.developerBuild === true;

		// ── Sub-section: Live Status (always shown) ──
		const statusSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(statusSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.settings.section.status', 'Status')));
		this._renderResolvedMode(statusSection);
		this._renderConnectionStatus(statusSection);
		this._renderWorkerStatus(statusSection);

		if (developerBuild) {
			// ── Sub-section: Backend Mode override (developer build only) ──
			const modeSection = dom.append(this._container, dom.$('.chipos-settings-section'));
			dom.append(modeSection, dom.$('.chipos-settings-section-title', undefined,
				localize('chipos.settings.section.mode', 'Backend Mode (Developer Build Override)')));
			this._renderBackendMode(modeSection);

			// ── Sub-section: Mode-specific settings (dynamic) ──
			const configSection = dom.append(this._container, dom.$('.chipos-settings-section'));
			this._modeSpecificTitleEl = dom.append(configSection, dom.$('.chipos-settings-section-title'));
			this._modeSpecificContainer = dom.append(configSection, dom.$('.chipos-mode-specific'));
			this._renderModeSpecificSettings();

			// 2026-05-25: removed _renderLegacySettings call (v1 sidecar UI section).
			// v2 backend has fully superseded the WebSocket sidecar — the chipos.sidecar.*
			// schema is preserved with deprecationMessage for backward compat, but the
			// editable UI rows were dead settings that did nothing in v2.
		}
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

	private _updateModeSpecificTitle(mode: string): void {
		if (!this._modeSpecificTitleEl) {
			return;
		}
		switch (mode) {
			case 'auto':
				this._modeSpecificTitleEl.textContent = localize('chipos.settings.section.auto', 'Auto-Detected Endpoints');
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
			{ text: localize('chipos.mode.auto', 'Auto (recommended — detect from workspace + product defaults)') },
			{ text: localize('chipos.mode.local', 'Local (IDE spawns Worker on this machine; cache → download from chiposReleases.repo)') },
			{ text: localize('chipos.mode.cloud', 'Cloud Reasoning (SSH-Remote forwards a remote Worker; chat goes direct to cloud Reasoner)') },
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
		this._modeSettingsDisposables.clear(); // dispose the previous mode's inputs

		const mode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
		this._updateModeSpecificTitle(mode);

		switch (mode) {
			case 'auto':
				// Auto mode derives the resolved mode (Local / Cloud / Manual) at
				// runtime from workspace remoteness + existing processes. The three
				// fields below act as fallback overrides — leave them empty to let
				// auto-detection do its job.
				dom.append(container, dom.$('.chipos-setting-hint', undefined,
					localize('chipos.mode.auto.hint', 'Auto mode picks Local / Cloud Reasoning / Manual based on workspace remoteness and existing processes. The fields below are optional overrides — leave them empty unless auto-detection picks the wrong endpoint.')
				));
				this._renderReasoningUrlInput(container);
				this._renderWorkerHttpPortRangeInput(container);
				this._renderWorkerHttpUrlInput(container);
				break;

			case 'cloud-reasoning':
				// Authentication has moved to the General tab.
				// `grpcAddress` is the cross-network gRPC URL the Worker uses to
				// reach Reasoner — meaningful for the default split-machine
				// deployment. Auto-derived from reasoningUrl when both share the
				// same hostname (cloud Reasoner case).
				this._renderWebsiteUrlInput(container);
				this._renderReasoningUrlInput(container);
				this._renderGrpcAddressInput(container);
				this._renderTokenInput(container);
				this._renderWorkerApiKeyInput(container);
				this._renderTlsEnabled(container);
				// 2026-05-25: dropped _renderWorkerHttpPortInput (single deprecated port).
				// Port Range supersedes it; schema kept only as startup-window fallback.
				this._renderWorkerHttpPortRangeInput(container);
				this._renderWorkerHttpUrlInput(container);
				break;

			case 'manual':
				// Authentication has moved to the General tab.
				this._renderWebsiteUrlInput(container);
				this._renderReasoningUrlInput(container);
				this._renderTokenInput(container);
				this._renderWorkerApiKeyInput(container);
				this._renderTlsEnabled(container);
				this._renderWorkerHttpPortRangeInput(container);
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
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, this._contextViewProvider, {
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

		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
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
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.grpcAddress', 'Reasoner gRPC Address (Worker → Reasoner)')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.grpcAddress.desc', 'Cross-network gRPC URL the Worker uses to reach Reasoner. Required when Reasoner and Worker are on different machines (the default deployment). Example: `reasoning.chipos.ai:50051`. Leave empty to auto-derive from Reasoning URL host (when not loopback) or fall back to 127.0.0.1:50051 for single-machine setups.')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'reasoning.chipos.ai:50051',
			inputBoxStyles: defaultInputBoxStyles,
			validationOptions: {
				validation: (value) => {
					if (!value) { return null; }
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

		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
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
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, this._contextViewProvider, {
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
		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
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
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, undefined, {
			type: 'password',
			placeholder: localize('chipos.settings.workerApiKey.placeholder', 'Worker API key (optional for local mode)'),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.worker.apiKey') ?? '';
		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
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
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'eyJhbGciOiJIUzI1NiIs...',
			type: 'password',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this._configurationService.getValue<string>('chipos.backend.token') || '';

		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
			this._configurationService.updateValue('chipos.backend.token', value, ConfigurationTarget.USER);
		}));
	}

	// 2026-05-25: removed _renderWorkerHttpPortInput.
	// `chipos.backend.workerHttpPort` is DEPRECATED — worker uses kernel-assigned
	// ports written to instance.json. Schema is kept (with deprecationMessage in
	// chiposConfiguration.ts) so legacy settings.json values are still tolerated
	// as a one-shot startup fallback, but the editable UI row is gone — it only
	// invited misconfiguration that conflicts with Port Range / kernel assignment.

	// ── v2: Worker HTTP Port Range (ops firewall whitelist) ─────────────

	private _renderWorkerHttpPortRangeInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined,
			localize('chipos.settings.workerHttpPortRange', 'Worker HTTP Port Range')
		));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.workerHttpPortRange.desc',
				'Bind worker HTTP in a specific port range (e.g. "50000-50099"). Use this when firewall rules require worker port to be in a whitelisted range. Empty → kernel-assigned random port (recommended for most users). Format: LOW-HIGH (both inclusive, 1024-65535).')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: localize('chipos.settings.workerHttpPortRange.placeholder', 'e.g. 50000-50099 (empty = kernel-assigned)'),
			inputBoxStyles: defaultInputBoxStyles,
			validationOptions: {
				validation: (value) => {
					const trimmed = (value || '').trim();
					if (!trimmed) { return null; } // empty is valid (= kernel-assigned)
					const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
					if (!m) {
						return { content: localize('chipos.settings.workerHttpPortRange.invalidFormat', 'Format must be LOW-HIGH (e.g. 50000-50099)'), type: 2 };
					}
					const low = parseInt(m[1]);
					const high = parseInt(m[2]);
					if (low < 1024 || high > 65535) {
						return { content: localize('chipos.settings.workerHttpPortRange.outOfRange', 'Ports must be 1024-65535'), type: 2 };
					}
					if (low > high) {
						return { content: localize('chipos.settings.workerHttpPortRange.lowGtHigh', 'LOW must be <= HIGH'), type: 2 };
					}
					if (high - low < 1) {
						return { content: localize('chipos.settings.workerHttpPortRange.tooNarrow', 'Range too narrow; need at least 2 ports for headroom'), type: 1 };
					}
					return null;
				}
			}
		}));
		// "调整这些参数带来的影响" — 三块提示，常驻不占空间，状态变化时切换
		// 显示什么取决于：(a) 当前 config 值是不是空，(b) 用户刚改完
		const impactBox = dom.append(row, dom.$('.chipos-setting-impact-box'));
		impactBox.style.marginTop = '6px';
		impactBox.style.fontSize = '12px';
		impactBox.style.lineHeight = '1.5';
		impactBox.style.padding = '8px 10px';
		impactBox.style.borderRadius = '4px';
		impactBox.style.borderLeft = '3px solid var(--vscode-textBlockQuote-border, #888)';
		impactBox.style.background = 'var(--vscode-textBlockQuote-background, rgba(127,127,127,0.07))';

		const initialValue = this._configurationService.getValue<string>('chipos.backend.workerHttpPortRange') || '';
		inputBox.value = initialValue;

		const renderImpact = (currentValue: string, justChanged: boolean): void => {
			dom.clearNode(impactBox);
			const trimmed = (currentValue || '').trim();
			if (!trimmed) {
				// 空值 — 走默认 kernel-assigned，告诉用户这是常态 + 怎么诊断
				dom.append(impactBox, dom.$('div', undefined,
					'✓ ', dom.$('strong', undefined, localize('chipos.settings.workerHttpPortRange.impact.default.title', 'Default: kernel-assigned')),
					' — ', localize('chipos.settings.workerHttpPortRange.impact.default.body', 'Worker uses any free port from the OS ephemeral range. No port conflict between multiple workers. To see what port is in use right now:')
				));
				const codeBox = dom.append(impactBox, dom.$('code', undefined,
					'cat ~/.chipos/instances/*/instance.json | jq .http_port'
				));
				codeBox.style.display = 'block';
				codeBox.style.marginTop = '4px';
				codeBox.style.padding = '4px 6px';
				codeBox.style.background = 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15))';
				codeBox.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
				return;
			}
			// 有值 — 解析、估算后果
			const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
			const low = m ? parseInt(m[1]) : 0;
			const high = m ? parseInt(m[2]) : 0;
			const count = (m && low <= high) ? (high - low + 1) : 0;

			const headerDiv = dom.append(impactBox, dom.$('div'));
			dom.append(headerDiv, dom.$('strong', undefined, localize(
				'chipos.settings.workerHttpPortRange.impact.set.title',
				'⚠ Override active: worker will bind in {0}',
				trimmed
			)));

			if (count > 0) {
				const lines: { icon: string; text: string }[] = [
					{ icon: '•', text: localize('chipos.settings.workerHttpPortRange.impact.set.scope', 'Range size: {0} port(s). If all are busy, worker startup fails loudly (not silent).', String(count)) },
					{ icon: '•', text: localize('chipos.settings.workerHttpPortRange.impact.set.firewall', 'Only useful if your firewall whitelist or audit logs require ports in this range.') },
				];
				if (count < 5) {
					lines.push({ icon: '⚠', text: localize('chipos.settings.workerHttpPortRange.impact.set.narrow', 'Range is narrow (<5 ports). Two IDE windows opening different workspaces at the same time may exhaust it. Consider widening.') });
				}
				for (const line of lines) {
					const lineDiv = dom.append(impactBox, dom.$('div'));
					lineDiv.style.marginTop = '3px';
					dom.append(lineDiv, dom.$('span', undefined, `${line.icon} ${line.text}`));
				}
			}

			// 重启提示 — 仅在用户刚改完时高亮（不是每次重渲都显示）
			if (justChanged) {
				const restartHint = dom.append(impactBox, dom.$('div'));
				restartHint.style.marginTop = '6px';
				restartHint.style.padding = '4px 6px';
				restartHint.style.background = 'var(--vscode-inputValidation-warningBackground, rgba(255,160,0,0.15))';
				restartHint.style.borderRadius = '3px';
				dom.append(restartHint, dom.$('span', undefined,
					'🔄 ',
					dom.$('strong', undefined, localize('chipos.settings.workerHttpPortRange.impact.restart.title', 'Restart worker to apply:')),
					' ',
					localize('chipos.settings.workerHttpPortRange.impact.restart.body', 'Command Palette → "ChipOS: Restart Worker" (the running worker keeps its current port until restart).')
				));
			}
		};

		// 首次渲染
		renderImpact(initialValue, false);

		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
			const trimmed = (value || '').trim();
			// Only persist when format is valid OR explicitly empty (clear it).
			if (!trimmed) {
				this._configurationService.updateValue('chipos.backend.workerHttpPortRange', '', ConfigurationTarget.USER);
				renderImpact('', true);
				return;
			}
			const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
			if (m) {
				const low = parseInt(m[1]);
				const high = parseInt(m[2]);
				if (low >= 1024 && high <= 65535 && low <= high) {
					this._configurationService.updateValue('chipos.backend.workerHttpPortRange', `${low}-${high}`, ConfigurationTarget.USER);
					renderImpact(`${low}-${high}`, true);
					return;
				}
			}
			// 格式不对就只刷影响说明（不持久化），等用户改对
			renderImpact(trimmed, false);
		}));
	}

	// ── v2: Worker HTTP URL (override) ───────────────────────────────────

	private _renderWorkerHttpUrlInput(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.workerHttpUrl', 'Worker HTTP URL (override)')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.workerHttpUrl.desc', 'Hard-coded Worker HTTP URL. Leave empty in 99% of cases — only set this if Worker is behind a reverse proxy or runs on a host the IDE cannot derive automatically.')
		));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._modeSettingsDisposables.add(new InputBox(inputContainer, this._contextViewProvider, {
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

		// Impact box — explains the precedence between override / Port Range /
		// instance.json. Without this, users who fill override silently bypass
		// every other port-related setting and wonder why Port Range "doesn't work".
		const impactBox = dom.append(row, dom.$('.chipos-setting-impact-box'));
		const renderImpact = (currentValue: string) => {
			dom.clearNode(impactBox);
			if (!currentValue) {
				dom.append(impactBox,
					dom.$('span', undefined,
						'✓ ', dom.$('strong', undefined, localize('chipos.settings.workerHttpUrl.impact.empty.title', 'Empty (recommended)')),
						' — ', localize('chipos.settings.workerHttpUrl.impact.empty.body',
							'IDE auto-derives the Worker URL from instance.json (port chosen by Port Range or the kernel). Multi-worker, port-roll, and REH all work correctly.')
					)
				);
			} else {
				dom.append(impactBox,
					dom.$('span.chipos-setting-impact-warn', undefined,
						'⚠ ', dom.$('strong', undefined, localize('chipos.settings.workerHttpUrl.impact.set.title', 'Override is active')),
						' — ', localize('chipos.settings.workerHttpUrl.impact.set.body',
							'IDE will hit THIS URL and ignore both Worker HTTP Port Range and instance.json. If Worker rolls to a different port, IDE will not follow — Worker pill will flap. Only use this if Worker is reachable on a fixed URL you control (e.g. behind nginx).')
					)
				);
			}
		};
		renderImpact(inputBox.value);

		this._modeSettingsDisposables.add(inputBox.onDidChange(value => {
			renderImpact(value);
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

	// (Removed 2026-04-27)
	// `_renderPythonPathInput` and `_renderBackendDirInput` were UI rows for
	// `chipos.backend.pythonPath` / `chipos.backend.dir`, which only mattered
	// when the IDE could spawn a local backend. Both settings + their UI rows
	// are deleted; backend deployment is the user's responsibility now.

	// ── v2: TLS Enabled ─────────────────────────────────────────────────

	private _renderTlsEnabled(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const checkbox = this._modeSettingsDisposables.add(new Checkbox(
			localize('chipos.settings.tlsEnabled', 'Enable TLS for gRPC'),
			this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false,
			defaultCheckboxStyles,
		));
		dom.append(row, checkbox.domNode);

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined,
			localize('chipos.settings.tlsEnabled.desc', 'Enable TLS encryption for gRPC connections between Worker and Reasoner.')
		));

		this._modeSettingsDisposables.add(checkbox.onChange(() => {
			this._configurationService.updateValue('chipos.backend.tlsEnabled', checkbox.checked, ConfigurationTarget.USER);
		}));
	}

	// 2026-05-25: removed _renderLegacySettings + _renderManualUrl +
	// _renderSidecarPort + _renderAutoStart + _renderAutoRestart.
	// These edited chipos.sidecar.* keys which control the v1 WebSocket sidecar,
	// a component that no longer exists in v2 (Worker HTTP + Reasoner gRPC has
	// fully superseded it). The schema entries are kept in chiposConfiguration.ts
	// with deprecationMessage so a legacy settings.json doesn't error, but the
	// editable UI rows were misleading — they implied the values still affected
	// runtime behavior, which is false in v2.
}
