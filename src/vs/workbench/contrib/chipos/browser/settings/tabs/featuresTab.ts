/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { SelectBox, ISelectOptionItem } from '../../../../../../base/browser/ui/selectBox/selectBox.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultSelectBoxStyles, defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';

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
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextViewService contextViewService: IContextViewService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
		this._render();
	}

	private _render(): void {
		dom.clearNode(this._container);

		// Group 1: Display
		const displaySection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(displaySection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.features.group.display', 'Display')));
		this._renderToggle(displaySection, TOGGLE_SETTINGS[0]); // Show Thinking

		// Group 2: Context & Tools
		const contextSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(contextSection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.features.group.context', 'Context & Tools')));
		this._renderToggle(contextSection, TOGGLE_SETTINGS[1]); // Auto Context
		this._renderTokenBudget(contextSection);
		this._renderToggle(contextSection, TOGGLE_SETTINGS[2]); // Built-in Tools
		this._renderToggle(contextSection, TOGGLE_SETTINGS[3]); // Dynamic Skills

		// Group 3: Agent Behavior
		const agentSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(agentSection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.features.group.agent', 'Agent Behavior')));
		for (const setting of SELECT_SETTINGS) {
			this._renderSelect(agentSection, setting);
		}
	}

	private _renderToggle(parent: HTMLElement, setting: ToggleSetting): void {
		const row = dom.append(parent, dom.$('.chipos-toggle-row'));

		const info = dom.append(row, dom.$('.chipos-toggle-info'));
		dom.append(info, dom.$('.chipos-setting-label', undefined, setting.label));
		dom.append(info, dom.$('.chipos-setting-description', undefined, setting.description));

		const toggle = dom.append(row, dom.$('.chipos-toggle-switch'));
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-label', setting.label);
		toggle.tabIndex = 0;

		const input = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		input.type = 'checkbox';
		input.id = `chipos-toggle-${setting.key}`;
		const initialChecked = this._configurationService.getValue<boolean>(setting.key) ?? false;
		input.checked = initialChecked;
		toggle.setAttribute('aria-checked', String(initialChecked));
		dom.append(toggle, dom.$('.chipos-toggle-slider'));

		const updateValue = (checked: boolean) => {
			input.checked = checked;
			toggle.setAttribute('aria-checked', String(checked));
			this._configurationService.updateValue(setting.key, checked, ConfigurationTarget.USER);
		};

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			toggle.setAttribute('aria-checked', String(input.checked));
			this._configurationService.updateValue(setting.key, input.checked, ConfigurationTarget.USER);
		}));

		this._disposables.add(dom.addDisposableListener(toggle, 'keydown', (e: KeyboardEvent) => {
			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				updateValue(!input.checked);
			}
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(setting.key)) {
				const val = this._configurationService.getValue<boolean>(setting.key) ?? false;
				input.checked = val;
				toggle.setAttribute('aria-checked', String(val));
			}
		}));
	}

	private _renderSelect(parent: HTMLElement, setting: SelectSetting): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, setting.label));
		dom.append(row, dom.$('.chipos-setting-description', undefined, setting.description));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const options: ISelectOptionItem[] = setting.options.map(o => ({ text: o.label }));
		const values = setting.options.map(o => o.value);
		const current = this._configurationService.getValue<string>(setting.key) || setting.options[0].value;
		const selectedIndex = Math.max(0, values.indexOf(current));

		const selectBox = this._disposables.add(new SelectBox(options, selectedIndex, this._contextViewProvider!, defaultSelectBoxStyles));
		selectBox.render(selectContainer);

		this._disposables.add(selectBox.onDidSelect(e => {
			if (e.index < values.length) {
				this._configurationService.updateValue(setting.key, values[e.index], ConfigurationTarget.USER);
			}
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(setting.key)) {
				const val = this._configurationService.getValue<string>(setting.key) || setting.options[0].value;
				const idx = values.indexOf(val);
				if (idx >= 0) {
					selectBox.select(idx);
				}
			}
		}));
	}

	private _renderTokenBudget(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.features.tokenBudget', 'Auto Context Token Budget')));
		dom.append(row, dom.$('.chipos-setting-description', undefined, localize('chipos.features.tokenBudget.desc', 'Maximum token budget for auto-collected context (1000–32000).')));

		const inputContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const inputBox = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: '8000',
			type: 'number',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = String(this._configurationService.getValue<number>('chipos.autoContextTokenBudget') ?? 8000);

		this._disposables.add(inputBox.onDidChange(value => {
			const val = Math.max(1000, Math.min(32000, parseInt(value) || 8000));
			this._configurationService.updateValue('chipos.autoContextTokenBudget', val, ConfigurationTarget.USER);
		}));

		this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.autoContextTokenBudget')) {
				inputBox.value = String(this._configurationService.getValue<number>('chipos.autoContextTokenBudget') ?? 8000);
			}
		}));
	}
}
