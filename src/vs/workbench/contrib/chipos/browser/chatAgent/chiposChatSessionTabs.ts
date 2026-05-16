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
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentSession } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';

/**
 * ChipOS Chat Session Tabs — horizontal tab strip rendered at the top
 * of the chat panel (Cursor-style), one tab per recently-active chat
 * session plus a trailing "+" to start a new chat.
 *
 * Owner: `ChipOSChatSessionTabsService` constructs one of these per
 * `.chipos-session-tabs-slot` DOM element and feeds it the current
 * openTabs URIs + activeUri. Calling `update()` re-renders.
 *
 * Click semantics:
 *   - Tab body → openSession() → switch to that chat
 *   - Tab × → emit close intent; service trims from storage and
 *     advances active to neighbor
 *   - + → workbench.action.chat.newChat
 */
export interface IChipOSChatTabsCallbacks {
	readonly onOpenTab: (sessionResource: URI) => void;
	readonly onCloseTab: (sessionResource: URI) => void;
	readonly onNewTab: () => void;
}

export class ChipOSChatSessionTabs extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _tabsContainer: HTMLElement;
	private readonly _newBtn: HTMLElement;
	private readonly _rowListeners = this._register(new DisposableStore());

	constructor(
		host: HTMLElement,
		private readonly _callbacks: IChipOSChatTabsCallbacks,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._domNode = host;
		this._domNode.classList.add('chipos-session-tabs');

		this._tabsContainer = dom.append(this._domNode, dom.$('.chipos-session-tabs-row'));
		this._newBtn = dom.append(this._domNode, dom.$('a.chipos-session-tabs-new.codicon.codicon-add'));
		this._newBtn.setAttribute('role', 'button');
		this._newBtn.setAttribute('aria-label', localize('chipos.sessionTabs.new', 'New chat'));
		this._newBtn.title = localize('chipos.sessionTabs.new', 'New chat');
		this._register(dom.addDisposableListener(this._newBtn, dom.EventType.CLICK, () => {
			this._callbacks.onNewTab();
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
	 */
	render(openTabs: readonly URI[], activeUri: URI | undefined): void {
		this._rowListeners.clear();
		dom.clearNode(this._tabsContainer);

		// 0-tab state — collapse the strip so it doesn't eat vertical space.
		if (openTabs.length === 0) {
			this._domNode.classList.add('chipos-session-tabs-empty');
			return;
		}
		this._domNode.classList.remove('chipos-session-tabs-empty');

		// Snapshot sessions once so we can look up labels/icons in O(1) per
		// tab without re-walking the framework's model array.
		const sessionsByResource = new Map<string, IAgentSession>();
		for (const s of this._agentSessionsService.model.sessions) {
			sessionsByResource.set(s.resource.toString(), s);
		}

		for (const uri of openTabs) {
			const session = sessionsByResource.get(uri.toString());
			if (!session) {
				// Session removed from history (deleted/archived) — skip and
				// trust the service to garbage-collect from storage on its
				// next sync.
				continue;
			}
			this._renderTab(session, !!activeUri && isEqual(activeUri, session.resource));
		}
	}

	private _renderTab(session: IAgentSession, isActive: boolean): void {
		const tab = dom.append(this._tabsContainer, dom.$('.chipos-session-tab'));
		tab.classList.toggle('chipos-session-tab-active', isActive);
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(isActive));
		tab.setAttribute('tabindex', '0');
		tab.title = session.label;

		const icon = dom.append(tab, dom.$('span.chipos-session-tab-icon.codicon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(session.icon ?? Codicon.commentDiscussion));

		const label = dom.append(tab, dom.$('span.chipos-session-tab-label'));
		label.textContent = session.label;

		const closeBtn = dom.append(tab, dom.$('span.chipos-session-tab-close.codicon.codicon-close'));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', localize('chipos.sessionTabs.close', 'Close tab'));
		closeBtn.title = localize('chipos.sessionTabs.close', 'Close tab');

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
