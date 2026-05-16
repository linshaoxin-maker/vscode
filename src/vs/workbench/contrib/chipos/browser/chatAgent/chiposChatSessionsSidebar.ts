/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { AgentSessionSection, IAgentSession, IAgentSessionSection } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { groupAgentSessionsByDate } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsViewer.js';
import { openSession } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsOpener.js';
import { isMarkdownString } from '../../../../../base/common/htmlContent.js';

/**
 * ChipOS Chat Sessions Sidebar — a persistent in-panel session list that
 * mirrors Cursor's chat history sidebar. Lives next to the chat-controls-
 * container inside ChatViewPane (see chatViewPane.ts:_chiposSessionsSidebarSlot)
 * and shows the user's chat history grouped by recency.
 *
 * Why a sidebar, not the existing `chipos.pickSession` quickPick?
 * Power users want a persistent overview of their sessions while they're
 * working — quickPicks dismiss themselves the moment you click outside.
 * This widget renders into the slot exposed by ChatViewPane and stays
 * visible until the user toggles it off.
 *
 * Layout: handled by chiposOverrides.css via the
 * `chipos-chat-with-sidebar-{left,right}` classes set by ChatViewPane based
 * on the panel's docked location.
 */
export class ChipOSChatSessionsSidebar extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _listContainer: HTMLElement;
	private readonly _searchInput: HTMLInputElement;
	private _filter: string = '';
	private readonly _listListeners = this._register(new DisposableStore());

	constructor(
		host: HTMLElement,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._domNode = host;
		this._domNode.classList.add('chipos-chat-sessions-sidebar');

		// Header: collapse button + title + new-chat button. The collapse
		// button just runs the toggle command so closing the sidebar from
		// inside is a single click (matches Cursor's UX where the
		// sidebar-toggle lives in the same spot the open button lives).
		const header = dom.append(this._domNode, dom.$('.chipos-sessions-header'));
		const collapseBtn = dom.append(header, dom.$('a.chipos-sessions-collapse-btn.codicon.codicon-layout-sidebar-right'));
		collapseBtn.setAttribute('role', 'button');
		collapseBtn.setAttribute('aria-label', localize('chipos.sessions.collapse', 'Hide chat sessions'));
		collapseBtn.title = localize('chipos.sessions.collapse', 'Hide chat sessions');
		this._register(dom.addDisposableListener(collapseBtn, dom.EventType.CLICK, () => {
			this._commandService.executeCommand('chipos.toggleChatSessionsSidebar');
		}));
		const headerTitle = dom.append(header, dom.$('.chipos-sessions-title'));
		headerTitle.textContent = localize('chipos.sessions.title', 'Chats');
		const newBtn = dom.append(header, dom.$('a.chipos-sessions-new-btn.codicon.codicon-add'));
		newBtn.setAttribute('role', 'button');
		newBtn.setAttribute('aria-label', localize('chipos.sessions.new', 'New chat'));
		newBtn.title = localize('chipos.sessions.new', 'New chat');
		this._register(dom.addDisposableListener(newBtn, dom.EventType.CLICK, () => {
			this._commandService.executeCommand('workbench.action.chat.newChat');
		}));

		// Search input
		const searchRow = dom.append(this._domNode, dom.$('.chipos-sessions-search-row'));
		const searchIcon = dom.append(searchRow, dom.$('.codicon.codicon-search.chipos-sessions-search-icon'));
		searchIcon.setAttribute('aria-hidden', 'true');
		this._searchInput = dom.append(searchRow, dom.$('input.chipos-sessions-search-input')) as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('chipos.sessions.search', 'Search chats…');
		this._register(dom.addDisposableListener(this._searchInput, 'input', () => {
			this._filter = this._searchInput.value.toLowerCase();
			this._render();
		}));

		// List container
		this._listContainer = dom.append(this._domNode, dom.$('.chipos-sessions-list'));

		// Subscribe to model changes (new chats, deletes, archive toggles) and
		// re-render. The framework's `IAgentSessionsModel.onDidChange` (or
		// equivalent) emits whenever sessions/resolution state shifts.
		this._render();
		const model = this._agentSessionsService.model;
		this._register(model.onDidChangeSessions(() => this._render()));
	}

	override dispose(): void {
		super.dispose();
		this._domNode.classList.remove('chipos-chat-sessions-sidebar');
		dom.clearNode(this._domNode);
	}

	private _render(): void {
		this._listListeners.clear();
		dom.clearNode(this._listContainer);

		const allSessions: IAgentSession[] = this._agentSessionsService.model.sessions.slice();
		const filtered = this._filter
			? allSessions.filter(s => (s.label ?? '').toLowerCase().includes(this._filter))
			: allSessions;

		if (filtered.length === 0) {
			const empty = dom.append(this._listContainer, dom.$('.chipos-sessions-empty'));
			empty.textContent = this._filter
				? localize('chipos.sessions.noMatch', 'No chats match "{0}"', this._filter)
				: localize('chipos.sessions.empty', 'No chat history yet');
			return;
		}

		const grouped: Map<AgentSessionSection, IAgentSessionSection> = groupAgentSessionsByDate(filtered);
		for (const section of grouped.values()) {
			if (section.sessions.length === 0) {
				continue;
			}
			const sectionEl = dom.append(this._listContainer, dom.$('.chipos-sessions-section'));
			const sectionHeader = dom.append(sectionEl, dom.$('.chipos-sessions-section-header'));
			sectionHeader.textContent = section.label;
			for (const session of section.sessions) {
				this._renderRow(sectionEl, session);
			}
		}
	}

	private _renderRow(parent: HTMLElement, session: IAgentSession): void {
		const row = dom.append(parent, dom.$('.chipos-sessions-row'));
		row.setAttribute('role', 'button');
		row.setAttribute('tabindex', '0');
		const tip = session.tooltip;
		row.title = typeof tip === 'string'
			? tip
			: isMarkdownString(tip)
				? tip.value
				: session.label;

		const icon = dom.append(row, dom.$('span.chipos-sessions-row-icon.codicon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(session.icon ?? Codicon.commentDiscussion));

		const label = dom.append(row, dom.$('span.chipos-sessions-row-label'));
		label.textContent = session.label;

		const onActivate = () => {
			this._instantiationService
				.invokeFunction(openSession, session, {})
				.catch((err: unknown) => this._logService.warn('[ChipOS Sidebar] openSession failed', err));
		};
		this._listListeners.add(dom.addDisposableListener(row, dom.EventType.CLICK, onActivate));
		this._listListeners.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				onActivate();
			}
		}));
	}
}

/**
 * Helper to attach a `ChipOSChatSessionsSidebar` to a host element via DI.
 * Used by the chipos chat-view contribution after locating the slot
 * exposed by ChatViewPane.chiposSessionsSidebarSlot.
 */
export function attachChipOSChatSessionsSidebar(
	accessor: ServicesAccessor,
	host: HTMLElement,
): ChipOSChatSessionsSidebar {
	const instantiationService = accessor.get(IInstantiationService);
	return instantiationService.createInstance(ChipOSChatSessionsSidebar, host);
}
