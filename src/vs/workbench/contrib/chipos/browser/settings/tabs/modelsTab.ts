/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { IModelDiscoveryService, ModelInfo } from '../modelDiscoveryService.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { SelectBox, ISelectOptionItem } from '../../../../../../base/browser/ui/selectBox/selectBox.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultSelectBoxStyles, defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';

const PROVIDER_OPTIONS: { value: string; label: string }[] = [
	{ value: 'zhipu', label: 'ZhiPu (智谱)' },
	{ value: 'openai', label: 'OpenAI' },
	{ value: 'anthropic', label: 'Anthropic' },
	{ value: 'deepseek', label: 'DeepSeek' },
	{ value: 'custom', label: 'Custom' },
];

const PROVIDER_VALUES = PROVIDER_OPTIONS.map(o => o.value);

const PROVIDER_BASE_URLS: Record<string, string> = {
	zhipu: 'https://open.bigmodel.cn/api/paas/v4',
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com',
	deepseek: 'https://api.deepseek.com',
};

export class ModelsTab extends Disposable {

	private _providerSelect!: SelectBox;
	private _apiKeyInput!: InputBox;
	private _baseUrlInput!: InputBox;
	private _baseUrlRow!: HTMLElement;
	private _modelSelect!: SelectBox;
	private _verifyButton!: HTMLButtonElement;
	private _verifyStatus!: HTMLElement;
	private _models: ModelInfo[] = [];
	private readonly _disposables = this._register(new DisposableStore());
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IModelDiscoveryService private readonly _modelDiscoveryService: IModelDiscoveryService,
		@IContextViewService contextViewService: IContextViewService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
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
		this._renderModelRow(section);
	}

	private _renderProviderRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.provider', 'Provider')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.provider.desc', 'Select the LLM provider for ChipOS.')));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const options: ISelectOptionItem[] = PROVIDER_OPTIONS.map(o => ({ text: o.label }));
		const current = this._configurationService.getValue<string>('chipos.provider') || 'zhipu';
		const selectedIndex = Math.max(0, PROVIDER_VALUES.indexOf(current));

		this._providerSelect = this._disposables.add(new SelectBox(options, selectedIndex, this._contextViewProvider!, defaultSelectBoxStyles));
		this._providerSelect.render(selectContainer);

		this._disposables.add(this._providerSelect.onDidSelect(e => {
			const provider = PROVIDER_VALUES[e.index];
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

	private get _selectedProvider(): string {
		return PROVIDER_VALUES[Math.max(0, PROVIDER_VALUES.indexOf(
			this._configurationService.getValue<string>('chipos.provider') || 'zhipu'
		))];
	}

	private _renderApiKeyRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.apiKey', 'API Key')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.apiKey.desc', 'Your API key for the selected provider. Stored locally in settings.json.')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		this._apiKeyInput = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'sk-...',
			type: 'password',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._apiKeyInput.value = this._configurationService.getValue<string>('chipos.apiKey') || '';

		this._disposables.add(this._apiKeyInput.onDidChange(value => {
			this._configurationService.updateValue('chipos.apiKey', value, ConfigurationTarget.USER);
			this._clearVerifyStatus();
		}));
	}

	private _renderBaseUrlRow(parent: HTMLElement): void {
		this._baseUrlRow = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(this._baseUrlRow, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.baseUrl', 'API Base URL')));
		dom.append(this._baseUrlRow, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.baseUrl.desc', 'Base URL for the LLM API endpoint.')));

		const inputContainer = dom.append(this._baseUrlRow, dom.$('.chipos-setting-input-container'));
		this._baseUrlInput = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: 'https://api.example.com/v1',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._baseUrlInput.value = this._configurationService.getValue<string>('chipos.apiBaseUrl') || '';

		this._disposables.add(this._baseUrlInput.onDidChange(value => {
			this._configurationService.updateValue('chipos.apiBaseUrl', value, ConfigurationTarget.USER);
		}));

		this._updateBaseUrlVisibility();
	}

	private _renderModelRow(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row.chipos-model-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.settings.model', 'Model')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.settings.model.desc', 'Select the model to use. Click Refresh to update the list.')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container.chipos-model-controls'));
		const selectWrapper = dom.append(inputContainer, dom.$('.chipos-model-select-wrapper'));
		const currentModel = this._configurationService.getValue<string>('chipos.model') || '';
		const initialOptions: ISelectOptionItem[] = currentModel ? [{ text: currentModel }] : [{ text: '—' }];

		this._modelSelect = this._disposables.add(new SelectBox(initialOptions, 0, this._contextViewProvider!, defaultSelectBoxStyles));
		this._modelSelect.render(selectWrapper);

		this._verifyButton = dom.append(inputContainer, dom.$<HTMLButtonElement>('button.chipos-verify-button.chipos-verify-button-inline', undefined, localize('chipos.settings.verify', 'Refresh Models')));
		this._verifyStatus = dom.append(row, dom.$('.chipos-verify-status'));

		this._disposables.add(dom.addDisposableListener(this._verifyButton, 'click', () => {
			this._doVerify();
		}));

		this._disposables.add(this._modelSelect.onDidSelect(e => {
			if (this._models.length > 0 && e.index < this._models.length) {
				this._configurationService.updateValue('chipos.model', this._models[e.index].id, ConfigurationTarget.USER);
			}
		}));
	}

	private _updateBaseUrlVisibility(): void {
		const provider = this._selectedProvider;
		this._baseUrlRow.style.display = provider === 'custom' ? '' : 'none';
	}

	private async _doVerify(): Promise<void> {
		const provider = this._selectedProvider;
		const apiKey = this._apiKeyInput.value;
		const baseUrl = provider === 'custom' ? this._baseUrlInput.value : undefined;

		this._verifyButton.disabled = true;
		this._verifyStatus.className = 'chipos-verify-status loading';
		dom.reset(this._verifyStatus, ...renderLabelWithIcons(localize('chipos.settings.verifying', '$(sync~spin) Verifying...')));

		try {
			const result = await this._modelDiscoveryService.verifyApiKey(provider, apiKey, baseUrl);

			if (result.valid) {
				this._verifyStatus.className = 'chipos-verify-status success';
				dom.reset(this._verifyStatus, ...renderLabelWithIcons(`$(pass) ${localize('chipos.settings.verified', 'Valid')} — ${result.models?.length ?? 0} models`));
				if (result.models) {
					this._updateModelList(result.models);
				}
			} else {
				this._verifyStatus.className = 'chipos-verify-status error';
				dom.reset(this._verifyStatus, ...renderLabelWithIcons(`$(error) ${result.error || 'Invalid API key'}`));
			}
		} catch (err) {
			this._verifyStatus.className = 'chipos-verify-status error';
			dom.reset(this._verifyStatus, ...renderLabelWithIcons(`$(error) ${err instanceof Error ? err.message : 'Unknown error'}`));
		} finally {
			this._verifyButton.disabled = false;
		}
	}

	private _updateModelList(models: ModelInfo[]): void {
		this._models = models;
		const currentModel = this._configurationService.getValue<string>('chipos.model') || '';

		const options: ISelectOptionItem[] = models.map(m => ({ text: m.displayName || m.id }));
		const selectedIndex = Math.max(0, models.findIndex(m => m.id === currentModel));

		this._modelSelect.setOptions(options, selectedIndex);

		if (!models.some(m => m.id === currentModel) && models.length > 0) {
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
		const options: ISelectOptionItem[] = currentModel ? [{ text: currentModel }] : [{ text: '—' }];
		this._modelSelect.setOptions(options, 0);
	}

	private _bindConfigListener(): void {
		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.provider')) {
				const provider = this._configurationService.getValue<string>('chipos.provider') || 'zhipu';
				const idx = PROVIDER_VALUES.indexOf(provider);
				if (idx >= 0) {
					this._providerSelect.select(idx);
				}
				this._updateBaseUrlVisibility();
			}
			if (e.affectsConfiguration('chipos.apiKey')) {
				const key = this._configurationService.getValue<string>('chipos.apiKey') || '';
				if (this._apiKeyInput.value !== key) {
					this._apiKeyInput.value = key;
				}
			}
			if (e.affectsConfiguration('chipos.model')) {
				const model = this._configurationService.getValue<string>('chipos.model') || '';
				const idx = this._models.findIndex(m => m.id === model);
				if (idx >= 0) {
					this._modelSelect.select(idx);
				}
			}
		}));
	}
}
