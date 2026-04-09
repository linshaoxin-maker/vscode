/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { SelectBox, ISelectOptionItem } from '../../../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultSelectBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'off'];

export class GeneralTab extends Disposable {

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

		// Privacy
		const privacySection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(privacySection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.general.privacy', 'Privacy')));

		this._renderToggle(privacySection, 'chipos.telemetry.enabled',
			localize('chipos.general.telemetry', 'Anonymous Usage Telemetry'),
			localize('chipos.general.telemetry.desc', 'Help improve ChipOS by sending anonymous usage data.'));

		this._renderToggle(privacySection, 'chipos.privacy.redactSensitive',
			localize('chipos.general.redact', 'Redact Sensitive Paths'),
			localize('chipos.general.redact.desc', 'Automatically redact file paths and personal identifiers from data sent to AI providers.'));

		// Logging
		const loggingSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(loggingSection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.general.logging', 'Logging')));

		this._renderLogLevel(loggingSection);

		// Editor Integration
		const editorSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(editorSection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.general.editor', 'Editor Integration')));

		this._renderToggle(editorSection, 'chipos.editor.showInlineHints',
			localize('chipos.general.inlineHints', 'Show Inline Hints'),
			localize('chipos.general.inlineHints.desc', 'Show subtle inline hints for AI-assisted actions in the editor gutter.'));
	}

	private _renderToggle(parent: HTMLElement, key: string, label: string, description: string): void {
		const row = dom.append(parent, dom.$('.chipos-toggle-row'));
		const info = dom.append(row, dom.$('.chipos-toggle-info'));
		dom.append(info, dom.$('.chipos-setting-label', undefined, label));
		dom.append(info, dom.$('.chipos-setting-description', undefined, description));

		const toggle = dom.append(row, dom.$('.chipos-toggle-switch'));
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-label', label);
		toggle.tabIndex = 0;

		const input = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		input.type = 'checkbox';
		const initialChecked = this._configurationService.getValue<boolean>(key) ?? false;
		input.checked = initialChecked;
		toggle.setAttribute('aria-checked', String(initialChecked));
		dom.append(toggle, dom.$('.chipos-toggle-slider'));

		const updateValue = (checked: boolean) => {
			input.checked = checked;
			toggle.setAttribute('aria-checked', String(checked));
			this._configurationService.updateValue(key, checked, ConfigurationTarget.USER);
		};

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			toggle.setAttribute('aria-checked', String(input.checked));
			this._configurationService.updateValue(key, input.checked, ConfigurationTarget.USER);
		}));

		this._disposables.add(dom.addDisposableListener(toggle, 'keydown', (e: KeyboardEvent) => {
			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				updateValue(!input.checked);
			}
		}));
	}

	private _renderLogLevel(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.general.logLevel', 'ChipOS Log Level')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.general.logLevel.desc', 'Set the verbosity of ChipOS-specific logging output.')));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const options: ISelectOptionItem[] = LOG_LEVELS.map(l => ({ text: l.charAt(0).toUpperCase() + l.slice(1) }));
		const current = this._configurationService.getValue<string>('chipos.logLevel') || 'info';
		const selectedIndex = Math.max(0, LOG_LEVELS.indexOf(current));

		const selectBox = this._disposables.add(new SelectBox(options, selectedIndex, this._contextViewProvider!, defaultSelectBoxStyles));
		selectBox.render(selectContainer);

		this._disposables.add(selectBox.onDidSelect(e => {
			if (e.index < LOG_LEVELS.length) {
				this._configurationService.updateValue('chipos.logLevel', LOG_LEVELS[e.index], ConfigurationTarget.USER);
			}
		}));
	}
}
