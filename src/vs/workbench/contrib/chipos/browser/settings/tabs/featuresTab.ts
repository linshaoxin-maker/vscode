/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';

interface ToggleSetting {
	key: string;
	label: string;
	description: string;
}

interface SelectSetting {
	key: string;
	label: string;
	description: string;
	options: { value: string; label: string }[];
}

const TOGGLE_SETTINGS: ToggleSetting[] = [
	{
		key: 'chipos.showThinking',
		label: localize('chipos.features.thinking', 'Show Thinking'),
		description: localize('chipos.features.thinking.desc', 'Display LLM reasoning/thinking output in chat messages.'),
	},
	{
		key: 'chipos.autoContext',
		label: localize('chipos.features.autoContext', 'Auto Context'),
		description: localize('chipos.features.autoContext.desc', 'Automatically collect IDE context (active file, selection, git diff, linter errors) and send with each task.'),
	},
	{
		key: 'chipos.enableBuiltinTools',
		label: localize('chipos.features.builtinTools', 'Enable Built-in Tools'),
		description: localize('chipos.features.builtinTools.desc', 'Enable model-native tools (web search, code execution) for supported models.'),
	},
	{
		key: 'chipos.dynamicSkill.enabled',
		label: localize('chipos.features.dynamicSkills', 'Dynamic Skills'),
		description: localize('chipos.features.dynamicSkills.desc', 'Automatically extract coding rules from debug sessions to assist subsequent tasks.'),
	},
];

const SELECT_SETTINGS: SelectSetting[] = [
	{
		key: 'chipos.autoApproveMode',
		label: localize('chipos.features.autoApprove', 'Auto-Approve Mode'),
		description: localize('chipos.features.autoApprove.desc', 'Control how Hook confirmations are handled.'),
		options: [
			{ value: 'strict', label: localize('chipos.autoApprove.strict', 'Strict — Pause on every Hook') },
			{ value: 'standard', label: localize('chipos.autoApprove.standard', 'Standard — Skip quality gates (default)') },
			{ value: 'full_auto', label: localize('chipos.autoApprove.fullAuto', 'Full Auto — Auto-approve all') },
		],
	},
	{
		key: 'chipos.chatMode',
		label: localize('chipos.features.chatMode', 'Default Chat Mode'),
		description: localize('chipos.features.chatMode.desc', 'Default chat mode for new conversations.'),
		options: [
			{ value: 'agent', label: localize('chipos.chatMode.agent', 'Agent — Autonomous coding') },
			{ value: 'spec', label: localize('chipos.chatMode.spec', 'Spec — Specification review (read-only)') },
		],
	},
];

export class FeaturesTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		dom.clearNode(this._container);

		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.settings.features', 'Feature Settings')));

		for (const setting of TOGGLE_SETTINGS) {
			this._renderToggle(section, setting);
		}

		for (const setting of SELECT_SETTINGS) {
			this._renderSelect(section, setting);
		}

		this._renderTokenBudget(section);
	}

	private _renderToggle(parent: HTMLElement, setting: ToggleSetting): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row-horizontal'));

		const toggle = dom.append(row, dom.$('.chipos-toggle'));
		const input = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		input.type = 'checkbox';
		input.checked = this._configurationService.getValue<boolean>(setting.key) ?? false;
		dom.append(toggle, dom.$('.chipos-toggle-slider'));

		const textContainer = dom.append(row, dom.$('div'));
		dom.append(textContainer, dom.$('.chipos-setting-label', undefined, setting.label));
		dom.append(textContainer, dom.$('.chipos-setting-description', undefined, setting.description));

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			this._configurationService.updateValue(setting.key, input.checked, ConfigurationTarget.USER);
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(setting.key)) {
				input.checked = this._configurationService.getValue<boolean>(setting.key) ?? false;
			}
		}));
	}

	private _renderSelect(parent: HTMLElement, setting: SelectSetting): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, setting.label));
		dom.append(row, dom.$('.chipos-setting-description', undefined, setting.description));

		const select = dom.append(row, dom.$<HTMLSelectElement>('select.chipos-setting-select'));
		for (const opt of setting.options) {
			const option = dom.append(select, dom.$<HTMLOptionElement>('option'));
			option.value = opt.value;
			option.textContent = opt.label;
		}
		select.value = this._configurationService.getValue<string>(setting.key) || setting.options[0].value;

		this._disposables.add(dom.addDisposableListener(select, 'change', () => {
			this._configurationService.updateValue(setting.key, select.value, ConfigurationTarget.USER);
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(setting.key)) {
				select.value = this._configurationService.getValue<string>(setting.key) || setting.options[0].value;
			}
		}));
	}

	private _renderTokenBudget(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.features.tokenBudget', 'Auto Context Token Budget')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.features.tokenBudget.desc', 'Maximum token budget for auto-collected context (1000–32000).')));

		const input = dom.append(row, dom.$<HTMLInputElement>('input.chipos-setting-input'));
		input.type = 'number';
		input.min = '1000';
		input.max = '32000';
		input.step = '500';
		input.value = String(this._configurationService.getValue<number>('chipos.autoContextTokenBudget') ?? 8000);

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			const val = Math.max(1000, Math.min(32000, parseInt(input.value) || 8000));
			input.value = String(val);
			this._configurationService.updateValue('chipos.autoContextTokenBudget', val, ConfigurationTarget.USER);
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.autoContextTokenBudget')) {
				input.value = String(this._configurationService.getValue<number>('chipos.autoContextTokenBudget') ?? 8000);
			}
		}));
	}
}
