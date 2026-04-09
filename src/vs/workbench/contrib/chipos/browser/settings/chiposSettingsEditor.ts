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
import { ToolsTab } from './tabs/toolsTab.js';
import { GeneralTab } from './tabs/generalTab.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import * as dom from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';

interface ICategoryDef {
	readonly id: ChipOSSettingsTab;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly searchableTerms: string[];
}

const CATEGORIES: ICategoryDef[] = [
	{ id: 'general', label: localize('chipos.cat.general', 'General'), icon: Codicon.gear, searchableTerms: ['privacy', 'telemetry', 'logging', 'log level', 'editor', 'hints'] },
	{ id: 'models', label: localize('chipos.cat.models', 'Models'), icon: Codicon.hubot, searchableTerms: ['provider', 'api key', 'model', 'base url', 'zhipu', 'openai', 'anthropic', 'deepseek'] },
	{ id: 'features', label: localize('chipos.cat.features', 'Features'), icon: Codicon.extensions, searchableTerms: ['thinking', 'context', 'tools', 'skills', 'approve', 'chat mode', 'token budget'] },
	{ id: 'connection', label: localize('chipos.cat.connection', 'Connection'), icon: Codicon.plug, searchableTerms: ['backend', 'mode', 'reasoning', 'worker', 'grpc', 'tls', 'port', 'python', 'sidecar'] },
	{ id: 'rules', label: localize('chipos.cat.rules', 'Rules'), icon: Codicon.law, searchableTerms: ['rules', 'global', 'project', 'hook'] },
	{ id: 'beta', label: localize('chipos.cat.beta', 'Beta'), icon: Codicon.beaker, searchableTerms: ['inline chat', 'terminal agent', 'multi-agent', 'simulation', 'spec mode'] },
	{ id: 'tools', label: localize('chipos.cat.tools', 'Tools'), icon: Codicon.tools, searchableTerms: ['mcp', 'server', 'configuration'] },
];

export class ChipOSSettingsEditor extends EditorPane {

	static readonly ID = 'workbench.editor.chiposSettings';

	private _rootElement: HTMLElement | undefined;
	private _navList: HTMLElement | undefined;
	private _contentArea: HTMLElement | undefined;
	private _activeTab: ChipOSSettingsTab = 'general';
	private _navItems = new Map<ChipOSSettingsTab, HTMLElement>();
	private _navBadges = new Map<ChipOSSettingsTab, HTMLElement>();
	private _tabInstances = new DisposableStore();
	private _activeTabDisposable: IDisposable | undefined;
	private _searchInput: HTMLInputElement | undefined;
	private _currentFilter = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
	) {
		super(ChipOSSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.chipos-settings-editor'));
		this._rootElement.tabIndex = 0;

		// ── Header ──
		const header = dom.append(this._rootElement, dom.$('.chipos-settings-header'));
		const headerLeft = dom.append(header, dom.$('.chipos-settings-header-left'));
		dom.append(headerLeft, dom.$('.chipos-settings-title', undefined, localize('chipos.settings.title', 'ChipOS Settings')));

		// Search box
		const searchContainer = dom.append(headerLeft, dom.$('.chipos-settings-search'));
		this._searchInput = dom.append(searchContainer, dom.$<HTMLInputElement>('input.chipos-settings-search-input'));
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('chipos.settings.search', 'Search settings...');
		this._searchInput.addEventListener('input', () => {
			this._currentFilter = this._searchInput!.value.toLowerCase().trim();
			this._updateSearchBadges();
			this._filterCurrentTab();
		});

		const customLink = dom.append(header, dom.$('.chipos-settings-customizations-link'));
		customLink.textContent = localize('chipos.settings.openJson', 'Open JSON Settings');
		customLink.addEventListener('click', () => {
			this._commandService.executeCommand('workbench.action.openSettingsJson');
		});

		// ── Keyboard shortcut hint ──
		const kb = this._keybindingService.lookupKeybinding('chipos.openSettings');
		if (kb) {
			const kbHint = dom.append(header, dom.$('.chipos-settings-keybinding-hint'));
			kbHint.textContent = kb.getLabel() ?? '';
			kbHint.title = localize('chipos.settings.keybindingHint', 'Keyboard shortcut to open this page');
		}

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

			const badge = dom.append(item, dom.$('.chipos-settings-nav-badge'));
			badge.style.display = 'none';
			this._navBadges.set(cat.id, badge);

			item.addEventListener('click', () => this._switchTab(cat.id));
			this._navItems.set(cat.id, item);
		}

		// Right: content area
		this._contentArea = dom.append(body, dom.$('.chipos-settings-content'));
		this._contentArea.tabIndex = 0;
	}

	override async setInput(
		input: ChipOSSettingsEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const tab = (options as IChipOSSettingsEditorOptions | undefined)?.initialTab ?? 'general';
		this._switchTab(tab);
	}

	private _switchTab(tab: ChipOSSettingsTab): void {
		if (this._activeTab === tab && this._activeTabDisposable) {
			return;
		}
		this._activeTab = tab;

		for (const [id, el] of this._navItems) {
			el.classList.toggle('active', id === tab);
		}

		if (this._contentArea) {
			dom.clearNode(this._contentArea);
		}
		this._activeTabDisposable?.dispose();

		if (!this._contentArea) {
			return;
		}
		const store = new DisposableStore();
		this._activeTabDisposable = store;
		this._tabInstances.add(store);

		// Inner wrapper re-created on each switch to trigger fade-in animation
		const inner = dom.append(this._contentArea, dom.$('.chipos-settings-content-inner'));

		try {
			switch (tab) {
				case 'general':
					store.add(this._instantiationService.createInstance(GeneralTab, inner));
					break;
				case 'models':
					store.add(this._instantiationService.createInstance(ModelsTab, inner));
					break;
				case 'features':
					store.add(this._instantiationService.createInstance(FeaturesTab, inner));
					break;
				case 'connection':
					store.add(this._instantiationService.createInstance(ConnectionTab, inner));
					break;
				case 'rules':
					store.add(this._instantiationService.createInstance(RulesTab, inner));
					break;
				case 'beta':
					store.add(this._instantiationService.createInstance(BetaTab, inner));
					break;
				case 'tools':
					store.add(this._instantiationService.createInstance(ToolsTab, inner));
					break;
			}
		} catch (err) {
			const errorEl = dom.append(inner, dom.$('.chipos-settings-empty'));
			const icon = dom.append(errorEl, dom.$('.codicon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
			dom.append(errorEl, dom.$('span', undefined, localize('chipos.settings.tabError', 'Failed to load {0} tab: {1}', tab, String(err))));
		}

		this._filterCurrentTab();
	}

	private _updateSearchBadges(): void {
		const q = this._currentFilter;
		for (const cat of CATEGORIES) {
			const badge = this._navBadges.get(cat.id);
			if (!badge) { continue; }
			if (!q) {
				badge.style.display = 'none';
				continue;
			}
			const matches = cat.searchableTerms.filter(t => t.includes(q)).length;
			const labelMatch = cat.label.toLowerCase().includes(q) ? 1 : 0;
			const total = matches + labelMatch;
			if (total > 0) {
				badge.textContent = String(total);
				badge.style.display = '';
			} else {
				badge.style.display = 'none';
			}
		}
	}

	private _filterCurrentTab(): void {
		if (!this._contentArea) { return; }
		const q = this._currentFilter;
		const rows = this._contentArea.querySelectorAll<HTMLElement>(
			'.chipos-setting-row, .chipos-toggle-row, .chipos-setting-row-horizontal, .chipos-verify-row, .chipos-mcp-server-row, .chipos-config-link-row'
		);
		for (const row of rows) {
			if (!q) {
				row.style.display = '';
				row.classList.remove('chipos-search-highlight');
				continue;
			}
			const text = row.textContent?.toLowerCase() ?? '';
			if (text.includes(q)) {
				row.style.display = '';
				row.classList.add('chipos-search-highlight');
			} else {
				row.style.display = 'none';
				row.classList.remove('chipos-search-highlight');
			}
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
