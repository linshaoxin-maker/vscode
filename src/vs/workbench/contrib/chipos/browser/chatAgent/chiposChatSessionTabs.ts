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

		// Only show a tab once its conversation has actually started — i.e.
		// the session has a real title (derived from the first submitted
		// message). A fresh untitled session shows NO tab, so startup / the
		// `+` button never leaves an empty "New Chat" placeholder tab. (Per
		// product intent: 只有对话开始了才有 tab 标签.)
		const visibleTabs = openTabs.filter(uri => this._hasRealTitle(uri));

		this._domNode.classList.toggle('chipos-session-tabs-empty', visibleTabs.length === 0);
		if (visibleTabs.length === 0) {
			return;
		}

		// Snapshot sessions once so we can look up labels/icons in O(1) per
		// tab without re-walking the framework's model array.
		const sessionsByResource = new Map<string, IAgentSession>();
		for (const s of this._agentSessionsService.model.sessions) {
			sessionsByResource.set(s.resource.toString(), s);
		}

		for (const uri of visibleTabs) {
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
	/**
	 * True when a session has a real, conversation-derived title (so it's
	 * earned a tab). Mirrors `_labelForUri`'s accept logic: a non-empty title
	 * that isn't just the URI's base64 segment. A fresh untitled session
	 * returns false → no tab until the user actually starts chatting.
	 */
	private _hasRealTitle(uri: URI): boolean {
		const title = this._chatService.getSessionTitle(uri);
		if (!title || !title.trim()) {
			return false;
		}
		const segments = uri.path.split('/').filter(Boolean);
		const lastSeg = segments[segments.length - 1];
		return !lastSeg || !title.includes(lastSeg.slice(0, 16));
	}

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
	 * Wire Cursor-style pointer-driven drag reorder. The source tab follows
	 * the cursor in real time (1:1, no transition); sibling tabs slide aside
	 * to make room with a CSS transform transition for smoothness. On
	 * release, the service's `onReorderTabs(from, to)` callback commits the
	 * new ordering and the rendered tab list snaps to the final positions.
	 *
	 * Why not HTML5 DnD: the native drag generates a translucent ghost
	 * snapshot that follows the cursor in addition to the in-place source
	 * tab, giving a "two of the same tab" appearance (see prior commit
	 * f0a8a1b5720 for the half-measure). Pointer events let us drive the
	 * tab's transform directly, matching the Cursor IDE's tab-drag feel.
	 *
	 * Click-vs-drag: we don't start the visual drag until the cursor has
	 * moved past a 5px threshold. Below that, pointerup is followed by the
	 * usual `click` event so single-click tab activation still works.
	 */
	private _wireTabDragDrop(tab: HTMLElement, tabUri: URI): void {
		tab.dataset.chiposTabUri = tabUri.toString();

		this._rowListeners.add(dom.addDisposableListener(tab, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return; // only primary button
			}
			// Don't intercept clicks on the × close button.
			const closeBtn = tab.querySelector('.chipos-session-tab-close');
			if (closeBtn && (closeBtn === e.target || closeBtn.contains(e.target as Node))) {
				return;
			}

			const DRAG_THRESHOLD = 5;
			const startX = e.clientX;
			const allTabs = Array.from(this._tabsContainer.querySelectorAll<HTMLElement>('.chipos-session-tab'));
			const sourceIndex = allTabs.indexOf(tab);
			if (sourceIndex < 0) {
				return;
			}
			const sourceRect = tab.getBoundingClientRect();
			// Slot width = tab width + flex gap. `gap` is on the parent row.
			const gap = parseFloat(getComputedStyle(this._tabsContainer).gap) || 0;
			const slotWidth = sourceRect.width + gap;

			let dragging = false;
			let currentTargetIndex = sourceIndex;
			let onPointerMove: ((ev: PointerEvent) => void) | null = null;
			let onPointerUp: ((ev: PointerEvent) => void) | null = null;

			const cleanup = () => {
				if (onPointerMove) {
					document.removeEventListener('pointermove', onPointerMove);
				}
				if (onPointerUp) {
					document.removeEventListener('pointerup', onPointerUp);
					document.removeEventListener('pointercancel', onPointerUp);
				}
				tab.classList.remove('chipos-session-tab-dragging');
				tab.style.transform = '';
				tab.style.transition = '';
				tab.style.zIndex = '';
				for (const sib of allTabs) {
					if (sib !== tab) {
						sib.style.transform = '';
					}
				}
			};

			onPointerMove = (ev: PointerEvent) => {
				const deltaX = ev.clientX - startX;

				if (!dragging) {
					if (Math.abs(deltaX) < DRAG_THRESHOLD) {
						return;
					}
					dragging = true;
					tab.classList.add('chipos-session-tab-dragging');
					tab.style.transition = 'none'; // source follows cursor 1:1
					tab.style.zIndex = '10';
				}

				// Source tab moves with the cursor.
				tab.style.transform = `translateX(${deltaX}px)`;

				// Map cursor X to an integer "target index" relative to source.
				// Each slot is `slotWidth` wide; crossing the midpoint of an
				// adjacent slot moves the target index by 1.
				const slotsCrossed = Math.round(deltaX / slotWidth);
				const newTargetIndex = Math.max(0, Math.min(allTabs.length - 1, sourceIndex + slotsCrossed));

				if (newTargetIndex !== currentTargetIndex) {
					currentTargetIndex = newTargetIndex;
					// Slide siblings: tabs between source and target shift the
					// opposite direction to "make room" for the source.
					for (let i = 0; i < allTabs.length; i++) {
						if (i === sourceIndex) {
							continue;
						}
						const sib = allTabs[i];
						let offset = 0;
						if (sourceIndex < currentTargetIndex && i > sourceIndex && i <= currentTargetIndex) {
							offset = -slotWidth;
						} else if (sourceIndex > currentTargetIndex && i >= currentTargetIndex && i < sourceIndex) {
							offset = slotWidth;
						}
						sib.style.transform = offset ? `translateX(${offset}px)` : '';
					}
				}
			};

			onPointerUp = () => {
				const didReorder = dragging && currentTargetIndex !== sourceIndex;
				const targetTab = allTabs[currentTargetIndex];
				const targetUri = targetTab?.dataset.chiposTabUri;
				cleanup();
				if (didReorder && targetUri) {
					this._callbacks.onReorderTabs(tabUri, URI.parse(targetUri));
				}
			};

			document.addEventListener('pointermove', onPointerMove);
			document.addEventListener('pointerup', onPointerUp);
			document.addEventListener('pointercancel', onPointerUp);
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
