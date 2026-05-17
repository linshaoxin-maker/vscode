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
import { EdaToolsTab } from './tabs/edaToolsTab.js';
import { GeneralTab } from './tabs/generalTab.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import * as dom from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IChipOSTokenManager } from '../auth/chiposTokenManager.js';

interface ICategoryDef {
	readonly id: ChipOSSettingsTab;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly searchableTerms: string[];
}

/* Nav categories grouped into visual sections separated by hairline dividers
 * (Cursor-style sidebar). Order within each group is the display order. */
const CATEGORY_GROUPS: ICategoryDef[][] = [
	[
		{ id: 'general', label: localize('chipos.cat.general', 'General'), icon: Codicon.gear, searchableTerms: ['account', 'auth', 'sign in', 'privacy', 'telemetry', 'logging', 'log level', 'editor', 'hints'] },
	],
	[
		{ id: 'models', label: localize('chipos.cat.models', 'Models'), icon: Codicon.hubot, searchableTerms: ['provider', 'api key', 'model', 'base url', 'zhipu', 'openai', 'anthropic', 'deepseek'] },
		{ id: 'features', label: localize('chipos.cat.features', 'Features'), icon: Codicon.extensions, searchableTerms: ['thinking', 'context', 'tools', 'skills', 'approve', 'chat mode', 'token budget'] },
		{ id: 'rules', label: localize('chipos.cat.rules', 'Rules'), icon: Codicon.law, searchableTerms: ['rules', 'global', 'project', 'hook'] },
	],
	[
		{ id: 'connection', label: localize('chipos.cat.connection', 'Connection'), icon: Codicon.plug, searchableTerms: ['backend', 'mode', 'reasoning', 'worker', 'grpc', 'tls', 'port', 'python', 'sidecar'] },
		{ id: 'tools', label: localize('chipos.cat.tools', 'Tools'), icon: Codicon.tools, searchableTerms: ['mcp', 'server', 'configuration'] },
		{ id: 'edaTools', label: localize('chipos.cat.edaTools', 'EDA Tools'), icon: Codicon.circuitBoard, searchableTerms: ['eda', 'vivado', 'quartus', 'yosys', 'openroad', 'verilator', 'managed', 'mcp', 'install', 'strategy'] },
	],
	[
		{ id: 'beta', label: localize('chipos.cat.beta', 'Beta'), icon: Codicon.beaker, searchableTerms: ['inline chat', 'terminal agent', 'multi-agent', 'simulation', 'spec mode'] },
	],
];

const CATEGORIES: readonly ICategoryDef[] = CATEGORY_GROUPS.flat();

export class ChipOSSettingsEditor extends EditorPane {

	static readonly ID = 'workbench.editor.chiposSettings';

	private _rootElement: HTMLElement | undefined;
	private _navList: HTMLElement | undefined;
	private _contentArea: HTMLElement | undefined;
	private _activeTab: ChipOSSettingsTab | undefined;
	private _pendingTab: ChipOSSettingsTab | undefined;
	private _navItems = new Map<ChipOSSettingsTab, HTMLElement>();
	private _navBadges = new Map<ChipOSSettingsTab, HTMLElement>();
	private _tabInstances = new DisposableStore();
	private _activeTabDisposable: IDisposable | undefined;
	private _searchInput: HTMLInputElement | undefined;
	private _currentFilter = '';
	private readonly _ownDisposables = this._register(new DisposableStore());

	private _accountAvatarEl: HTMLElement | undefined;
	private _accountNameEl: HTMLElement | undefined;
	private _accountStatusEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
	) {
		super(ChipOSSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.chipos-settings-editor'));
		this._rootElement.tabIndex = 0;

		// ── SplitView body (no top header — Cursor-style: account + search live in the sidebar) ──
		const body = dom.append(this._rootElement, dom.$('.chipos-settings-body'));

		// Left: navigation list
		this._navList = dom.append(body, dom.$('.chipos-settings-nav'));

		// Account card pinned to the top of the nav.
		this._renderAccountCard(this._navList);

		// Search box sits directly under the account card.
		const searchContainer = dom.append(this._navList, dom.$('.chipos-settings-search'));
		this._searchInput = dom.append(searchContainer, dom.$<HTMLInputElement>('input.chipos-settings-search-input'));
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('chipos.settings.search', 'Search settings...');
		this._searchInput.addEventListener('input', () => {
			this._currentFilter = this._searchInput!.value.toLowerCase().trim();
			this._updateSearchBadges();
			this._filterCurrentTab();
		});

		const navItemsContainer = dom.append(this._navList, dom.$('.chipos-settings-nav-items'));
		CATEGORY_GROUPS.forEach((group, groupIdx) => {
			if (groupIdx > 0) {
				dom.append(navItemsContainer, dom.$('.chipos-settings-nav-divider'));
			}
			for (const cat of group) {
				const item = dom.append(navItemsContainer, dom.$('.chipos-settings-nav-item'));
				item.dataset.category = cat.id;
				// Tooltip surfaces the label when the nav collapses to icons-only.
				item.title = cat.label;

				const iconEl = dom.append(item, dom.$('.chipos-settings-nav-icon'));
				iconEl.classList.add(...ThemeIcon.asClassNameArray(cat.icon));

				dom.append(item, dom.$('.chipos-settings-nav-label', undefined, cat.label));

				const badge = dom.append(item, dom.$('.chipos-settings-nav-badge'));
				badge.style.display = 'none';
				this._navBadges.set(cat.id, badge);

				item.addEventListener('click', () => this._switchTab(cat.id));
				this._navItems.set(cat.id, item);
			}
		});

		// Right: content area
		this._contentArea = dom.append(body, dom.$('.chipos-settings-content'));
		this._contentArea.tabIndex = 0;

		// Cmd/Ctrl+F focuses the search box from anywhere inside the editor.
		this._ownDisposables.add(dom.addDisposableListener(this._rootElement, 'keydown', (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
				e.preventDefault();
				e.stopPropagation();
				this._searchInput?.focus();
				this._searchInput?.select();
			}
		}));

		// If setInput was called before createEditor finished (race) it stashes
		// the requested tab in _pendingTab. Now that the DOM is ready, flush it.
		// Falling back to 'general' guarantees something is always shown — the
		// editor never sits with a blank right pane and no active nav item.
		const initialTab = this._pendingTab ?? 'general';
		this._pendingTab = undefined;
		this._switchTab(initialTab);
	}

	// ── Account card (top of nav) ──────────────────────────────────
	private _renderAccountCard(parent: HTMLElement): void {
		const card = dom.append(parent, dom.$('.chipos-settings-account-card'));

		this._accountAvatarEl = dom.append(card, dom.$('.chipos-settings-account-avatar'));

		const info = dom.append(card, dom.$('.chipos-settings-account-info'));
		this._accountNameEl = dom.append(info, dom.$('.chipos-settings-account-name'));
		this._accountStatusEl = dom.append(info, dom.$('.chipos-settings-account-status'));

		let signedIn = false;

		const updateAccount = () => {
			const user = this._tokenManager.getUser();
			if (user) {
				const display = (user.display_name?.trim() || user.email || '?').trim();
				this._accountNameEl!.textContent = display;
				this._accountStatusEl!.textContent = user.email && display !== user.email
					? user.email
					: localize('chipos.settings.account.connected', 'Signed in');
				this._accountAvatarEl!.textContent = display.charAt(0).toUpperCase();
				card.classList.remove('signed-out');
				this._accountAvatarEl!.classList.remove('signed-out');
				signedIn = true;
			} else if (this._tokenManager.isUsingManualTokenFallback()) {
				this._accountNameEl!.textContent = localize('chipos.settings.account.manualToken', 'Manual token');
				this._accountStatusEl!.textContent = localize('chipos.settings.account.manualHint', 'Using fallback token');
				this._accountAvatarEl!.textContent = '!';
				card.classList.remove('signed-out');
				this._accountAvatarEl!.classList.remove('signed-out');
				signedIn = true;
			} else {
				this._accountNameEl!.textContent = localize('chipos.settings.account.signedOut', 'Sign in');
				this._accountStatusEl!.textContent = localize('chipos.settings.account.signInHint', 'Click to sync settings');
				this._accountAvatarEl!.textContent = '';
				card.classList.add('signed-out');
				this._accountAvatarEl!.classList.add('signed-out');
				signedIn = false;
			}
		};

		updateAccount();

		this._ownDisposables.add(this._tokenManager.onDidChangeUser(updateAccount));
		this._ownDisposables.add(this._tokenManager.onDidChangeToken(updateAccount));

		// Click: when signed out, trigger login command directly. When signed
		// in, navigate to the General tab where the Account section lives.
		card.setAttribute('role', 'button');
		card.tabIndex = 0;
		const activate = () => {
			if (signedIn) {
				this._switchTab('general');
			} else {
				this._commandService.executeCommand('chipos.auth.login');
			}
		};
		this._ownDisposables.add(dom.addDisposableListener(card, 'click', activate));
		this._ownDisposables.add(dom.addDisposableListener(card, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate();
			}
		}));
	}

	override async setInput(
		input: ChipOSSettingsEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		// Decide the target tab BEFORE awaiting super.setInput, so we still
		// switch even if super throws / the await is cancelled mid-flight.
		const tab = (options as IChipOSSettingsEditorOptions | undefined)?.initialTab ?? 'general';
		try {
			await super.setInput(input, options, context, token);
		} finally {
			this._switchTab(tab);
		}
	}

	/**
	 * VS Code skips `setInput()` and only calls `setOptions()` when an editor
	 * is reopened with an input that already matches the current pane's input
	 * (see editorPanes.ts `doSetInput`). Without this override, our
	 * `initialTab` would be ignored on every reopen — meaning the user would
	 * stay on whatever tab they last looked at instead of resetting to General
	 * (or whichever tab was explicitly requested).
	 */
	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		const requested = (options as IChipOSSettingsEditorOptions | undefined)?.initialTab;
		if (requested) {
			this._switchTab(requested);
		}
	}

	private _switchTab(tab: ChipOSSettingsTab): void {
		// DOM not ready yet — createEditor hasn't run. Stash the request and
		// bail; createEditor will pick it up via _pendingTab once the DOM is
		// laid out. Without this, the editor would sit blank forever.
		if (!this._contentArea || this._navItems.size === 0) {
			this._pendingTab = tab;
			return;
		}
		// Only short-circuit when we're already showing this tab AND it has
		// rendered content. (Previously this also checked _activeTabDisposable
		// alone, which could keep us stuck on a stale state if the content
		// area got cleared externally.)
		if (this._activeTab === tab && this._activeTabDisposable && this._contentArea.firstChild) {
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
				case 'edaTools':
					store.add(this._instantiationService.createInstance(EdaToolsTab, inner));
					break;
			}
		} catch (err) {
			// Surface the failure in DevTools console too, so empty-pane bugs
			// can be diagnosed without tearing into TS source.
			console.error('[ChipOSSettings] Failed to render tab', tab, err);
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
