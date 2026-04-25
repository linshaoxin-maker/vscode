/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';

interface IBetaFeature {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly available: boolean;
}

const BETA_FEATURES: IBetaFeature[] = [
	{
		key: 'chipos.beta.inlineChat',
		label: localize('chipos.beta.inlineChat', 'Inline Chat'),
		description: localize('chipos.beta.inlineChat.desc', 'Enable inline chat directly in the editor. Press Cmd+I to start an inline conversation.'),
		available: false,
	},
	{
		key: 'chipos.beta.terminalAgent',
		label: localize('chipos.beta.terminalAgent', 'Terminal Agent'),
		description: localize('chipos.beta.terminalAgent.desc', 'Allow the AI agent to execute commands in the integrated terminal.'),
		available: true,
	},
	{
		key: 'chipos.beta.multiAgent',
		label: localize('chipos.beta.multiAgent', 'Multi-Agent Orchestration'),
		description: localize('chipos.beta.multiAgent.desc', 'Enable multi-agent workflows where specialized sub-agents handle different tasks.'),
		available: false,
	},
	{
		key: 'chipos.beta.edaSimulation',
		label: localize('chipos.beta.edaSim', 'EDA Simulation Integration'),
		description: localize('chipos.beta.edaSim.desc', 'Deep integration with EDA simulation tools for automated testbench generation and waveform analysis.'),
		available: false,
	},
	{
		key: 'chipos.beta.specMode',
		label: localize('chipos.beta.specMode', 'Spec Review Mode'),
		description: localize('chipos.beta.specMode.desc', 'A specialized mode for reviewing and analyzing hardware specifications with AI assistance.'),
		available: true,
	},
];

export class BetaTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		// ── Header description ──
		const headerDesc = dom.append(this._container, dom.$('.chipos-setting-description.chipos-tab-header-desc'));
		headerDesc.textContent = localize('chipos.beta.header',
			'Experimental features that are still in development. Enable at your own risk — some may be unstable or incomplete.');

		// ── Section: Available Beta Features ──
		const availableSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(availableSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.beta.available', 'Available')));

		for (const feature of BETA_FEATURES.filter(f => f.available)) {
			this._renderToggle(availableSection, feature);
		}

		// ── Section: Coming Soon ──
		const comingSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(comingSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.beta.coming', 'Coming Soon')));

		for (const feature of BETA_FEATURES.filter(f => !f.available)) {
			this._renderToggle(comingSection, feature, true);
		}
	}

	private _renderToggle(parent: HTMLElement, feature: IBetaFeature, greyed = false): void {
		const row = dom.append(parent, dom.$('.chipos-toggle-row'));
		if (greyed) {
			row.classList.add('greyed-out');
		}

		const info = dom.append(row, dom.$('.chipos-toggle-info'));
		dom.append(info, dom.$('.chipos-setting-label', undefined, feature.label));
		dom.append(info, dom.$('.chipos-setting-description', undefined, feature.description));

		const toggle = dom.append(row, dom.$('.chipos-toggle-switch'));
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-label', feature.label);
		toggle.tabIndex = greyed ? -1 : 0;
		if (greyed) {
			toggle.setAttribute('aria-disabled', 'true');
		}

		const checkbox = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		checkbox.type = 'checkbox';
		const initialChecked = feature.available
			? (this._configurationService.getValue<boolean>(feature.key) ?? false)
			: false;
		checkbox.checked = initialChecked;
		checkbox.disabled = greyed;
		toggle.setAttribute('aria-checked', String(initialChecked));

		const slider = dom.append(toggle, dom.$('.chipos-toggle-slider'));
		slider.setAttribute('aria-hidden', 'true');

		if (!greyed) {
			const updateValue = (checked: boolean) => {
				checkbox.checked = checked;
				toggle.setAttribute('aria-checked', String(checked));
				this._configurationService.updateValue(feature.key, checked, ConfigurationTarget.USER);
			};

			this._disposables.add(dom.addDisposableListener(checkbox, 'change', () => {
				toggle.setAttribute('aria-checked', String(checkbox.checked));
				this._configurationService.updateValue(feature.key, checkbox.checked, ConfigurationTarget.USER);
			}));

			this._disposables.add(dom.addDisposableListener(toggle, 'keydown', (e: KeyboardEvent) => {
				if (e.key === ' ' || e.key === 'Enter') {
					e.preventDefault();
					updateValue(!checkbox.checked);
				}
			}));

			// Sync from external changes
			this._disposables.add(this._configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(feature.key)) {
					const val = this._configurationService.getValue<boolean>(feature.key) ?? false;
					checkbox.checked = val;
					toggle.setAttribute('aria-checked', String(val));
				}
			}));
		}
	}
}
