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
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import * as dom from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

const TAB_DEFINITIONS: { id: ChipOSSettingsTab; label: string }[] = [
	{ id: 'models', label: localize('chipos.tab.models', 'Models') },
	{ id: 'features', label: localize('chipos.tab.features', 'Features') },
	{ id: 'connection', label: localize('chipos.tab.connection', 'Connection') },
];

export class ChipOSSettingsEditor extends EditorPane {

	static readonly ID = 'workbench.editor.chiposSettings';

	private _rootElement!: HTMLElement;
	private _tabButtons: Map<ChipOSSettingsTab, HTMLButtonElement> = new Map();
	private _tabContents: Map<ChipOSSettingsTab, HTMLElement> = new Map();
	private _tabInstances = new DisposableStore();

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

		const header = dom.append(this._rootElement, dom.$('.chipos-settings-header'));
		const tabBar = dom.append(header, dom.$('.chipos-settings-tabs'));
		for (const tabDef of TAB_DEFINITIONS) {
			const button = dom.append(tabBar, dom.$<HTMLButtonElement>('button.chipos-settings-tab', undefined, tabDef.label));
			button.addEventListener('click', () => this._switchTab(tabDef.id));
			this._tabButtons.set(tabDef.id, button);
		}

		const customizationsLink = dom.append(header, dom.$('a.chipos-settings-customizations-link'));
		customizationsLink.textContent = localize('chipos.openCustomizations', 'AI Customizations');
		customizationsLink.title = localize('chipos.openCustomizations.tooltip', 'Open AI Customizations (Agents, Skills, Prompts, Hooks, MCP)');
		customizationsLink.addEventListener('click', (e) => {
			e.preventDefault();
			this._commandService.executeCommand('aiCustomization.openManagementEditor');
		});

		for (const tabDef of TAB_DEFINITIONS) {
			const content = dom.append(this._rootElement, dom.$('.chipos-settings-content'));
			content.style.display = 'none';
			this._tabContents.set(tabDef.id, content);
		}

		try {
			this._createTabInstances();
		} catch (err) {
			const errorContainer = this._tabContents.get('models')!;
			const msg = err instanceof Error ? err.message : String(err);
			dom.append(errorContainer, dom.$('.chipos-settings-section', undefined,
				`Failed to initialize settings: ${msg}. Try reloading the window.`
			));
		}
		// Do NOT call _switchTab here — setInput() handles initial tab selection.
		// Calling it here causes a race: setInput() runs after createEditor() and
		// may reset display styles, leaving the panel blank until the user clicks a tab.
	}

	private _createTabInstances(): void {
		this._tabInstances.clear();

		const modelsContainer = this._tabContents.get('models')!;
		this._tabInstances.add(this._instantiationService.createInstance(ModelsTab, modelsContainer));

		const featuresContainer = this._tabContents.get('features')!;
		this._tabInstances.add(this._instantiationService.createInstance(FeaturesTab, featuresContainer));

		const connectionContainer = this._tabContents.get('connection')!;
		this._tabInstances.add(this._instantiationService.createInstance(ConnectionTab, connectionContainer));
	}

	private _switchTab(tabId: ChipOSSettingsTab): void {
		for (const [id, button] of this._tabButtons) {
			button.classList.toggle('active', id === tabId);
		}

		for (const [id, content] of this._tabContents) {
			content.style.display = id === tabId ? '' : 'none';
		}
	}

	override async setInput(input: ChipOSSettingsEditorInput, options: (IEditorOptions & IChipOSSettingsEditorOptions) | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		// Always activate a tab — use the requested one or fall back to 'models'
		this._switchTab(options?.initialTab ?? 'models');
	}

	override layout(dimension: dom.Dimension): void {
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
		this._tabInstances.dispose();
		super.dispose();
	}
}
