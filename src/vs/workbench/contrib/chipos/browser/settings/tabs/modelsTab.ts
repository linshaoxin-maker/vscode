/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { IModelDiscoveryService, ModelInfo } from '../modelDiscoveryService.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';

const PROVIDER_OPTIONS: { value: string; label: string }[] = [
	{ value: 'zhipu', label: 'ZhiPu (智谱)' },
	{ value: 'openai', label: 'OpenAI' },
	{ value: 'anthropic', label: 'Anthropic' },
	{ value: 'deepseek', label: 'DeepSeek' },
	{ value: 'custom', label: 'Custom' },
];

const PROVIDER_BASE_URLS: Record<string, string> = {
	zhipu: 'https://open.bigmodel.cn/api/paas/v4',
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com',
	deepseek: 'https://api.deepseek.com',
};

export class ModelsTab extends Disposable {

	private _providerSelect!: HTMLSelectElement;
	private _apiKeyInput!: HTMLInputElement;
	private _baseUrlInput!: HTMLInputElement;
	private _baseUrlRow!: HTMLElement;
	private _modelSelect!: HTMLSelectElement;
	private _verifyButton!: HTMLButtonElement;
	private _verifyStatus!: HTMLElement;
	private _models: ModelInfo[] = [];
	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IModelDiscoveryService private readonly _modelDiscoveryService: IModelDiscoveryService,
	) {
		super();
		this._render();
		this._bindConfigListener();
	}

	private _render(): void {
		dom.clearNode(this._container);

		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.settings.models', 'Model Configuration')));

		this._renderProviderRow(section);
		this._renderApiKeyRow(section);
		this._renderBaseUrlRow(section);
		this._renderVerifyRow(section);
		this._renderModelRow(section);
	}

	private _renderProviderRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.provider', 'Provider')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.provider.desc', 'Select the LLM provider for ChipOS.')));

		this._providerSelect = dom.append(row, dom.$<HTMLSelectElement>('select.chipos-setting-select'));
		for (const opt of PROVIDER_OPTIONS) {
			const option = dom.append(this._providerSelect, dom.$<HTMLOptionElement>('option'));
			option.value = opt.value;
			option.textContent = opt.label;
		}

		const current = this._configurationService.getValue<string>('chipos.provider') || 'zhipu';
		this._providerSelect.value = current;

		this._disposables.add(dom.addDisposableListener(this._providerSelect, 'change', () => {
			const provider = this._providerSelect.value;
			this._configurationService.updateValue('chipos.provider', provider, ConfigurationTarget.USER);

			if (provider !== 'custom' && PROVIDER_BASE_URLS[provider]) {
				this._configurationService.updateValue('chipos.apiBaseUrl', PROVIDER_BASE_URLS[provider], ConfigurationTarget.USER);
				this._baseUrlInput.value = PROVIDER_BASE_URLS[provider];
			}

			this._updateBaseUrlVisibility();
			this._clearVerifyStatus();
			this._clearModels();
		}));
	}

	private _renderApiKeyRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.apiKey', 'API Key')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.apiKey.desc', 'Your API key for the selected provider. Stored locally in settings.json.')));

		this._apiKeyInput = dom.append(row, dom.$<HTMLInputElement>('input.chipos-setting-input'));
		this._apiKeyInput.type = 'password';
		this._apiKeyInput.placeholder = 'sk-...';
		this._apiKeyInput.value = this._configurationService.getValue<string>('chipos.apiKey') || '';

		this._disposables.add(dom.addDisposableListener(this._apiKeyInput, 'change', () => {
			this._configurationService.updateValue('chipos.apiKey', this._apiKeyInput.value, ConfigurationTarget.USER);
			this._clearVerifyStatus();
		}));
	}

	private _renderBaseUrlRow(parent: HTMLElement): void {
		this._baseUrlRow = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(this._baseUrlRow, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.baseUrl', 'API Base URL')));
		dom.append(this._baseUrlRow, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.baseUrl.desc', 'Base URL for the LLM API endpoint.')));

		this._baseUrlInput = dom.append(this._baseUrlRow, dom.$<HTMLInputElement>('input.chipos-setting-input'));
		this._baseUrlInput.type = 'text';
		this._baseUrlInput.placeholder = 'https://api.example.com/v1';
		this._baseUrlInput.value = this._configurationService.getValue<string>('chipos.apiBaseUrl') || '';

		this._disposables.add(dom.addDisposableListener(this._baseUrlInput, 'change', () => {
			this._configurationService.updateValue('chipos.apiBaseUrl', this._baseUrlInput.value, ConfigurationTarget.USER);
		}));

		this._updateBaseUrlVisibility();
	}

	private _renderVerifyRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-verify-row'));

		this._verifyButton = dom.append(row, dom.$<HTMLButtonElement>('button.chipos-verify-button', undefined, localize('chipos.settings.verify', 'Verify & Fetch Models')));
		this._verifyStatus = dom.append(row, dom.$('.chipos-verify-status'));

		this._disposables.add(dom.addDisposableListener(this._verifyButton, 'click', () => {
			this._doVerify();
		}));
	}

	private _renderModelRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.model', 'Model')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.model.desc', 'Select the model to use. Click "Verify & Fetch Models" to refresh the list.')));

		this._modelSelect = dom.append(row, dom.$<HTMLSelectElement>('select.chipos-setting-select'));

		const currentModel = this._configurationService.getValue<string>('chipos.model') || '';
		if (currentModel) {
			const opt = dom.append(this._modelSelect, dom.$<HTMLOptionElement>('option'));
			opt.value = currentModel;
			opt.textContent = currentModel;
			this._modelSelect.value = currentModel;
		}

		this._disposables.add(dom.addDisposableListener(this._modelSelect, 'change', () => {
			this._configurationService.updateValue('chipos.model', this._modelSelect.value, ConfigurationTarget.USER);
		}));
	}

	private _updateBaseUrlVisibility(): void {
		const provider = this._providerSelect.value;
		this._baseUrlRow.style.display = provider === 'custom' ? '' : 'none';
	}

	private async _doVerify(): Promise<void> {
		const provider = this._providerSelect.value;
		const apiKey = this._apiKeyInput.value;
		const baseUrl = provider === 'custom' ? this._baseUrlInput.value : undefined;

		this._verifyButton.disabled = true;
		this._verifyStatus.className = 'chipos-verify-status loading';
		this._verifyStatus.textContent = localize('chipos.settings.verifying', '$(sync~spin) Verifying...');

		try {
			const result = await this._modelDiscoveryService.verifyApiKey(provider, apiKey, baseUrl);

			if (result.valid) {
				this._verifyStatus.className = 'chipos-verify-status success';
				this._verifyStatus.textContent = `$(pass) ${localize('chipos.settings.verified', 'Valid')} — ${result.models?.length ?? 0} models`;
				if (result.models) {
					this._updateModelList(result.models);
				}
			} else {
				this._verifyStatus.className = 'chipos-verify-status error';
				this._verifyStatus.textContent = `$(error) ${result.error || 'Invalid API key'}`;
			}
		} catch (err) {
			this._verifyStatus.className = 'chipos-verify-status error';
			this._verifyStatus.textContent = `$(error) ${err instanceof Error ? err.message : 'Unknown error'}`;
		} finally {
			this._verifyButton.disabled = false;
		}
	}

	private _updateModelList(models: ModelInfo[]): void {
		this._models = models;
		const currentModel = this._configurationService.getValue<string>('chipos.model') || '';

		dom.clearNode(this._modelSelect);
		for (const model of models) {
			const opt = dom.append(this._modelSelect, dom.$<HTMLOptionElement>('option'));
			opt.value = model.id;
			opt.textContent = model.displayName || model.id;
		}

		if (models.some(m => m.id === currentModel)) {
			this._modelSelect.value = currentModel;
		} else if (models.length > 0) {
			this._modelSelect.value = models[0].id;
			this._configurationService.updateValue('chipos.model', models[0].id, ConfigurationTarget.USER);
		}
	}

	private _clearVerifyStatus(): void {
		this._verifyStatus.className = 'chipos-verify-status';
		this._verifyStatus.textContent = '';
	}

	private _clearModels(): void {
		this._models = [];
		const currentModel = this._configurationService.getValue<string>('chipos.model') || '';
		dom.clearNode(this._modelSelect);
		if (currentModel) {
			const opt = dom.append(this._modelSelect, dom.$<HTMLOptionElement>('option'));
			opt.value = currentModel;
			opt.textContent = currentModel;
		}
	}

	private _bindConfigListener(): void {
		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.provider')) {
				const provider = this._configurationService.getValue<string>('chipos.provider') || 'zhipu';
				if (this._providerSelect.value !== provider) {
					this._providerSelect.value = provider;
					this._updateBaseUrlVisibility();
				}
			}
			if (e.affectsConfiguration('chipos.apiKey')) {
				const key = this._configurationService.getValue<string>('chipos.apiKey') || '';
				if (this._apiKeyInput.value !== key) {
					this._apiKeyInput.value = key;
				}
			}
			if (e.affectsConfiguration('chipos.model')) {
				const model = this._configurationService.getValue<string>('chipos.model') || '';
				if (this._modelSelect.value !== model && this._models.some(m => m.id === model)) {
					this._modelSelect.value = model;
				}
			}
		}));
	}
}
