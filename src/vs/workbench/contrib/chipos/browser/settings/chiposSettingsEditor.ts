/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import './chiposSettingsEditor.css';

import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ChipOSSettingsEditorInput, ChipOSSettingsTab, IChipOSSettingsEditorOptions } from './chiposSettingsEditorInput.js';
import { ModelsTab } from './tabs/modelsTab.js';
import { FeaturesTab } from './tabs/featuresTab.js';
import { ConnectionTab } from './tabs/connectionTab.js';
import { RulesTab } from './tabs/rulesTab.js';
import { BetaTab } from './tabs/betaTab.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import * as dom from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

interface ICategoryDef {
	readonly id: ChipOSSettingsTab;
	readonly label: string;
	readonly icon: ThemeIcon;
}

const CATEGORIES: ICategoryDef[] = [
	{ id: 'models', label: localize('chipos.cat.models', 'Models'), icon: Codicon.hubot },
	{ id: 'features', label: localize('chipos.cat.features', 'Features'), icon: Codicon.extensions },
	{ id: 'connection', label: localize('chipos.cat.connection', 'Connection'), icon: Codicon.plug },
	{ id: 'rules', label: localize('chipos.cat.rules', 'Rules'), icon: Codicon.law },
	{ id: 'beta', label: localize('chipos.cat.beta', 'Beta'), icon: Codicon.beaker },
];

export class ChipOSSettingsEditor extends EditorPane {

	static readonly ID = 'workbench.editor.chiposSettings';

	private _rootElement: HTMLElement | undefined;
	private _navList: HTMLElement | undefined;
	private _contentArea: HTMLElement | undefined;
	private _activeTab: ChipOSSettingsTab = 'models';
	private _navItems = new Map<ChipOSSettingsTab, HTMLElement>();
	private _tabInstances = new DisposableStore();
	private _activeTabDisposable: IDisposable | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super(ChipOSSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.chipos-settings-editor'));
		this._rootElement.tabIndex = 0;

		// ── Header ──
		const header = dom.append(this._rootElement, dom.$('.chipos-settings-header'));
		dom.append(header, dom.$('.chipos-settings-title', undefined, localize('chipos.settings.title', 'ChipOS Settings')));
		const customLink = dom.append(header, dom.$('.chipos-settings-customizations-link'));
		customLink.textContent = localize('chipos.settings.openJson', 'Open JSON Settings');
		customLink.addEventListener('click', () => {
			this._commandService.executeCommand('workbench.action.openSettingsJson');
		});

		// ── SplitView body ──
		const body = dom.append(this._rootElement, dom.$('.chipos-settings-body'));

		// Left: navigation list
		this._navList = dom.append(body, dom.$('.chipos-settings-nav'));
		for (const cat of CATEGORIES) {
			const item = dom.append(this._navList, dom.$('.chipos-settings-nav-item'));
			item.dataset.category = cat.id;

			const iconEl = dom.append(item, dom.$('.chipos-settings-nav-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(cat.icon));

			dom.append(item, dom.$('.chipos-settings-nav-label', undefined, cat.label));

			item.addEventListener('click', () => this._switchTab(cat.id));
			this._navItems.set(cat.id, item);
		}

		// Right: content area
		this._contentArea = dom.append(body, dom.$('.chipos-settings-content'));
		this._contentArea.tabIndex = 0; // Ensure content area can receive focus for input interaction
	}

	override async setInput(
		input: ChipOSSettingsEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const tab = (options as IChipOSSettingsEditorOptions | undefined)?.initialTab ?? 'models';
		this._switchTab(tab);
	}

	private _switchTab(tab: ChipOSSettingsTab): void {
		if (this._activeTab === tab && this._activeTabDisposable) {
			return; // already showing
		}
		this._activeTab = tab;

		// Update nav selection
		for (const [id, el] of this._navItems) {
			el.classList.toggle('active', id === tab);
		}

		// Clear content
		if (this._contentArea) {
			dom.clearNode(this._contentArea);
		}
		this._activeTabDisposable?.dispose();

		// Create tab content
		if (!this._contentArea) {
			return;
		}

		const store = new DisposableStore();
		this._activeTabDisposable = store;
		this._tabInstances.add(store);

		switch (tab) {
			case 'models':
				store.add(this._instantiationService.createInstance(ModelsTab, this._contentArea));
				break;
			case 'features':
				store.add(this._instantiationService.createInstance(FeaturesTab, this._contentArea));
				break;
			case 'connection':
				store.add(this._instantiationService.createInstance(ConnectionTab, this._contentArea));
				break;
			case 'rules':
				store.add(this._instantiationService.createInstance(RulesTab, this._contentArea));
				break;
			case 'beta':
				store.add(this._instantiationService.createInstance(BetaTab, this._contentArea));
				break;
		}
	}

	layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this._rootElement?.focus();
	}

	override dispose(): void {
		this._activeTabDisposable?.dispose();
		this._tabInstances.dispose();
		super.dispose();
	}
}
