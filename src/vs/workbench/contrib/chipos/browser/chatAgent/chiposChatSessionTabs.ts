/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentSession } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';

/**
 * ChipOS Chat Session Tabs — horizontal tab strip rendered at the top
 * of the chat panel (Cursor-style), one tab per recently-active chat
 * session plus a trailing `+` to start a new chat and a sidebar-toggle
 * button to open the framework's sessions sidebar.
 *
 * Owner: `ChipOSChatSessionTabsContribution` creates one of these per
 * `.chipos-session-tabs-slot` DOM element and feeds it the current
 * openTabs URIs + activeUri. Calling `render()` re-renders.
 *
 * Layout (always-visible, even when no tabs):
 *   [tab1] [tab2] [tab3]   [+]  [|||]
 *                            ^    ^
 *                  new chat —     `--- sessions sidebar toggle
 *
 * Click semantics:
 *   - Tab body → openSession() → switch to that chat
 *   - Tab × → emit close intent; service trims from storage and
 *     advances active to neighbor
 *   - + → workbench.action.chat.newChat
 *   - |||  → chipos.toggleChatSessionsSidebar
 */
export interface IChipOSChatTabsCallbacks {
	readonly onOpenTab: (sessionResource: URI) => void;
	readonly onCloseTab: (sessionResource: URI) => void;
	readonly onNewTab: () => void;
	readonly onToggleSessions: () => void;
	/** Reorder open tabs: move `from` to land at the position of `to`. */
	readonly onReorderTabs: (from: URI, to: URI) => void;
}

const DRAG_MIME = 'application/x-chipos-chat-session-tab-uri';

export class ChipOSChatSessionTabs extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _tabsContainer: HTMLElement;
	private readonly _rowListeners = this._register(new DisposableStore());

	constructor(
		host: HTMLElement,
		private readonly _callbacks: IChipOSChatTabsCallbacks,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
		@IChatService private readonly _chatService: IChatService,
		@IHoverService private readonly _hoverService: IHoverService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._domNode = host;
		this._domNode.classList.add('chipos-session-tabs');

		this._tabsContainer = dom.append(this._domNode, dom.$('.chipos-session-tabs-row'));

		// Trailing actions cluster — sits to the right of the scrollable
		// tabs row. Order matters: `+` first, sessions toggle last (mirrors
		// Cursor and matches the user's "tabs then |||" request).
		const actionsCluster = dom.append(this._domNode, dom.$('.chipos-session-tabs-actions'));

		const newBtn = dom.append(actionsCluster, dom.$('a.chipos-session-tabs-action.chipos-session-tabs-new.codicon.codicon-add'));
		newBtn.setAttribute('role', 'button');
		newBtn.setAttribute('aria-label', localize('chipos.sessionTabs.new', 'New chat'));
		newBtn.title = localize('chipos.sessionTabs.new', 'New chat');
		this._register(dom.addDisposableListener(newBtn, dom.EventType.CLICK, () => {
			this._callbacks.onNewTab();
		}));

		const toggleBtn = dom.append(actionsCluster, dom.$('a.chipos-session-tabs-action.chipos-session-tabs-toggle.codicon.codicon-layout-sidebar-right-off'));
		toggleBtn.setAttribute('role', 'button');
		toggleBtn.setAttribute('aria-label', localize('chipos.sessionTabs.toggleSidebar', "Toggle Chat Sessions Sidebar"));
		toggleBtn.title = localize('chipos.sessionTabs.toggleSidebar', "Toggle Chat Sessions Sidebar");
		this._register(dom.addDisposableListener(toggleBtn, dom.EventType.CLICK, () => {
			this._callbacks.onToggleSessions();
		}));
	}

	override dispose(): void {
		super.dispose();
		this._domNode.classList.remove('chipos-session-tabs');
		dom.clearNode(this._domNode);
	}

	/**
	 * Re-render the tab list. `openTabs` is the persisted list of session
	 * URIs (in display order); `activeUri` is the currently focused chat
	 * session (may be undefined if no session is loaded).
	 *
	 * Empty state keeps the row visible (so + / sessions-toggle stay
	 * reachable). The `chipos-session-tabs-empty` class lets the CSS
	 * trim padding / hide the tabs scrollbar when there's nothing to
	 * scroll, but the action cluster stays put.
	 */
	render(openTabs: readonly URI[], activeUri: URI | undefined): void {
		this._rowListeners.clear();
		dom.clearNode(this._tabsContainer);

		this._domNode.classList.toggle('chipos-session-tabs-empty', openTabs.length === 0);
		if (openTabs.length === 0) {
			return;
		}

		// Snapshot sessions once so we can look up labels/icons in O(1) per
		// tab without re-walking the framework's model array.
		const sessionsByResource = new Map<string, IAgentSession>();
		for (const s of this._agentSessionsService.model.sessions) {
			sessionsByResource.set(s.resource.toString(), s);
		}

		for (const uri of openTabs) {
			const session = sessionsByResource.get(uri.toString());
			const isActive = !!activeUri && isEqual(activeUri, uri);
			if (session) {
				this._renderTab(session, isActive);
			} else {
				// Session not yet (or no longer) in IAgentSessionsService.model
				// — could be a fresh chipos local chat that hasn't propagated
				// to the agent-sessions provider model yet. Render a fallback
				// with the URI's basename so the tab still shows up.
				this._renderFallbackTab(uri, isActive);
			}
		}
	}

	/**
	 * Resolve a human-readable label for a session URI when it's not in
	 * `IAgentSessionsService.model`. Order:
	 *   1. `IChatService.getSessionTitle(uri)` — covers both active and
	 *      persisted sessions, returns the model's customTitle or the
	 *      first request message text.
	 *   2. The localized "New Chat" string — never the raw URI segment,
	 *      so a session that hasn't had a first message yet still gets a
	 *      friendly label instead of a base64 UUID.
	 */
	private _labelForUri(uri: URI): string {
		const title = this._chatService.getSessionTitle(uri);
		if (title && title.trim()) {
			// Sanity check: reject titles that are just the URI's last
			// path segment — for chipos local sessions this is a base64
			// UUID that bleeds through if some upstream code defaulted
			// title to the URI segment.
			const segments = uri.path.split('/').filter(Boolean);
			const lastSeg = segments[segments.length - 1];
			if (!lastSeg || !title.includes(lastSeg.slice(0, 16))) {
				return title.trim();
			}
		}
		return localize('chipos.sessionTabs.untitled', "New Chat");
	}

	private _renderFallbackTab(uri: URI, isActive: boolean): void {
		const tab = dom.append(this._tabsContainer, dom.$('.chipos-session-tab'));
		tab.classList.toggle('chipos-session-tab-active', isActive);
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(isActive));
		tab.setAttribute('tabindex', '0');
		const label = this._labelForUri(uri);
		// VS Code-styled hover (faster + theme-consistent vs native `title` tooltip)
		this._rowListeners.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), tab, label));

		const iconEl = dom.append(tab, dom.$('span.chipos-session-tab-icon.codicon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.commentDiscussion));

		const labelEl = dom.append(tab, dom.$('span.chipos-session-tab-label'));
		labelEl.textContent = label;

		const closeBtn = dom.append(tab, dom.$('span.chipos-session-tab-close.codicon.codicon-close'));
		closeBtn.setAttribute('role', 'button');
		this._rowListeners.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), closeBtn, localize('chipos.sessionTabs.close', 'Close tab')));

		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.CLICK, (e: MouseEvent) => {
			if (e.target === closeBtn || closeBtn.contains(e.target as Node)) {
				return;
			}
			this._callbacks.onOpenTab(uri);
		}));
		this._rowListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			this._callbacks.onCloseTab(uri);
		}));
		this._wireTabDragDrop(tab, uri);
	}

	private _renderTab(session: IAgentSession, isActive: boolean): void {
		const tab = dom.append(this._tabsContainer, dom.$('.chipos-session-tab'));
		tab.classList.toggle('chipos-session-tab-active', isActive);
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(isActive));
		tab.setAttribute('tabindex', '0');
		// VS Code-styled hover (faster + theme-consistent vs native `title` tooltip)
		this._rowListeners.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), tab, session.label));

		const icon = dom.append(tab, dom.$('span.chipos-session-tab-icon.codicon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(session.icon ?? Codicon.commentDiscussion));

		const label = dom.append(tab, dom.$('span.chipos-session-tab-label'));
		label.textContent = session.label;

		const closeBtn = dom.append(tab, dom.$('span.chipos-session-tab-close.codicon.codicon-close'));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', localize('chipos.sessionTabs.close', 'Close tab'));
		this._rowListeners.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), closeBtn, localize('chipos.sessionTabs.close', 'Close tab')));

		// Click body → open; click × → close (stopPropagation so close doesn't
		// also trigger an open). Same logic on KEY_DOWN for keyboard parity.
		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.CLICK, (e: MouseEvent) => {
			if (e.target === closeBtn || closeBtn.contains(e.target as Node)) {
				return;
			}
			this._callbacks.onOpenTab(session.resource);
		}));
		this._rowListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			this._callbacks.onCloseTab(session.resource);
		}));
		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._callbacks.onOpenTab(session.resource);
			}
		}));

		// Best-effort: scroll the active tab into view so users don't lose
		// the current session under overflow.
		if (isActive) {
			queueMicrotask(() => {
				try { tab.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch { /* noop */ }
			});
		}
		void this._logService; // reserved for future telemetry hooks
		this._wireTabDragDrop(tab, session.resource);
	}

	/**
	 * Wire HTML5 drag-and-drop on a tab so users can reorder. Source tabs
	 * carry their URI in a chipos-specific MIME so we don't conflict with
	 * the framework's editor-tab DnD on other surfaces. Drop target reorders
	 * via the `onReorderTabs` callback.
	 */
	private _wireTabDragDrop(tab: HTMLElement, tabUri: URI): void {
		tab.draggable = true;

		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.DRAG_START, (e: DragEvent) => {
			if (!e.dataTransfer) {
				return;
			}
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData(DRAG_MIME, tabUri.toString());
			tab.classList.add('chipos-session-tab-dragging');
		}));
		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.DRAG_END, () => {
			tab.classList.remove('chipos-session-tab-dragging');
		}));

		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.DRAG_OVER, (e: DragEvent) => {
			if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes(DRAG_MIME)) {
				return; // not a chipos tab drag
			}
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			tab.classList.add('chipos-session-tab-drop-target');
		}));
		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.DRAG_LEAVE, () => {
			tab.classList.remove('chipos-session-tab-drop-target');
		}));
		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.DROP, (e: DragEvent) => {
			tab.classList.remove('chipos-session-tab-drop-target');
			if (!e.dataTransfer) {
				return;
			}
			const sourceStr = e.dataTransfer.getData(DRAG_MIME);
			if (!sourceStr) {
				return;
			}
			e.preventDefault();
			const sourceUri = URI.parse(sourceStr);
			if (isEqual(sourceUri, tabUri)) {
				return; // dropped on itself — no-op
			}
			this._callbacks.onReorderTabs(sourceUri, tabUri);
		}));
	}
}

/**
 * Helper to materialize a ChipOSChatSessionTabs via DI given the host
 * element + callbacks. Lets the tabs service stay in service-layer code
 * without importing the heavy DOM widget.
 */
export function createChipOSChatSessionTabs(
	instantiationService: IInstantiationService,
	host: HTMLElement,
	callbacks: IChipOSChatTabsCallbacks,
): ChipOSChatSessionTabs {
	return instantiationService.createInstance(ChipOSChatSessionTabs, host, callbacks);
}
