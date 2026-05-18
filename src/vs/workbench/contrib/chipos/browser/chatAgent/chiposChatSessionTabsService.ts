/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { openSession } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsOpener.js';
import { IAgentSessionsService } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChipOSChatSessionTabs, createChipOSChatSessionTabs } from './chiposChatSessionTabs.js';

const OPEN_TABS_STORAGE_KEY = 'chipos.chat.openSessionTabs';
const MAX_TABS = 8;

/**
 * ChipOS Chat Session Tabs contribution — owns persistence of the open-tabs
 * list and orchestrates rendering into every `.chipos-session-tabs-slot`
 * DOM element seeded by the chatViewPane patch.
 *
 * Why a contribution (not a singleton):
 *   - `registerWorkbenchContribution2(BlockRestore)` guarantees eager
 *     instantiation tied to the workbench lifecycle. Pure singletons
 *     marked Eager are sometimes lazy in practice and our DOM listeners
 *     never wire up.
 *
 * Why it tracks slots in a `DisposableMap<HTMLElement, …>`:
 *   - The chat view pane is disposable; closing/reopening the chat
 *     panel disposes the old `.chipos-session-tabs-slot` and creates a
 *     fresh one. The map's HTMLElement keys are stable per-mount, so
 *     when we rescan we automatically mount on the new slot and drop
 *     the (now-detached) previous mount.
 *
 * Why a MutationObserver as well as `onDidAddWidget`:
 *   - The chat view pane is sometimes torn down/rebuilt at non-widget
 *     events (layout orientation flip, panel close/reopen). Observing
 *     document mutations for `.chipos-session-tabs-slot` add/remove
 *     guarantees we react to lifecycle transitions the chat widget
 *     service doesn't announce.
 *
 * Lifecycle:
 *   - Construct on app startup (`WorkbenchPhase.BlockRestore`).
 *   - State (open tabs list) persists in `IStorageService` PROFILE
 *     scope, capped at `MAX_TABS` via LRU (most-recent-activated wins).
 */
export class ChipOSChatSessionTabsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.chatSessionTabs';

	private readonly _tabs = this._register(new DisposableMap<HTMLElement, ChipOSChatSessionTabs>());
	private _openTabs: URI[] = [];
	private _activeUri: URI | undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
		@IChatService private readonly _chatService: IChatService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._openTabs = this._loadOpenTabs();

		// Initial render attempt for any chat widget already rendered.
		queueMicrotask(() => this._scanAndRender());

		// React to subsequent chat widget additions (panel reopened, etc.)
		this._register(this._chatWidgetService.onDidAddWidget(() => this._scanAndRender()));

		// Active-session signal: every time the focused chat shifts to a
		// new sessionResource, promote it to head of the open-tabs list
		// (LRU semantics) so the tab strip mirrors "what the user is
		// actually working in".
		this._register(this._chatWidgetService.onDidChangeFocusedSession(() => {
			const widget = this._chatWidgetService.lastFocusedWidget;
			if (!widget || widget.location !== ChatAgentLocation.Chat) {
				this._scanAndRender();
				return;
			}
			const session = widget.viewModel?.sessionResource;
			this._activeUri = session;
			if (session) {
				this._addTab(session);
			}
			this._scanAndRender();
		}));

		// Also re-render when the agent sessions model itself changes
		// (rename, delete, archive). Labels/icons might shift.
		this._register(this._agentSessionsService.model.onDidChangeSessions(() => this._renderAll()));

		// Chat session titles are generated from the first user message —
		// re-render on submit so the tab label flips from "New Chat"
		// to the actual title without the user having to switch tabs.
		this._register(this._chatService.onDidSubmitRequest(() => this._renderAll()));
		this._register(this._chatService.onDidCreateModel(() => this._renderAll()));

		// MutationObserver: react to slot lifecycle transitions the
		// widget service doesn't announce. Coalesced via `queueMicrotask`
		// so a burst of unrelated DOM mutations only triggers one rescan.
		let scanScheduled = false;
		const observer = new MutationObserver(mutations => {
			let touchesSlot = false;
			outer: for (const m of mutations) {
				for (const n of [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)]) {
					if (!(n instanceof HTMLElement)) {
						continue;
					}
					if (n.classList?.contains('chipos-session-tabs-slot') ||
						n.querySelector?.('.chipos-session-tabs-slot')) {
						touchesSlot = true;
						break outer;
					}
				}
			}
			if (!touchesSlot || scanScheduled) {
				return;
			}
			scanScheduled = true;
			queueMicrotask(() => {
				scanScheduled = false;
				this._scanAndRender();
			});
		});
		observer.observe(document.body, { childList: true, subtree: true });
		this._register({ dispose: () => observer.disconnect() });
	}

	private _loadOpenTabs(): URI[] {
		try {
			const raw = this._storageService.get(OPEN_TABS_STORAGE_KEY, StorageScope.PROFILE);
			if (!raw) {
				return [];
			}
			const arr = JSON.parse(raw) as string[];
			return arr.map(s => URI.parse(s)).slice(0, MAX_TABS);
		} catch (err) {
			this._logService.warn('[ChipOS Tabs] failed to load open tabs', err);
			return [];
		}
	}

	private _saveOpenTabs(): void {
		try {
			const arr = this._openTabs.map(u => u.toString());
			this._storageService.store(OPEN_TABS_STORAGE_KEY, JSON.stringify(arr), StorageScope.PROFILE, StorageTarget.USER);
		} catch (err) {
			this._logService.warn('[ChipOS Tabs] failed to persist open tabs', err);
		}
	}

	private _addTab(uri: URI): void {
		// Existing entry → move to front (LRU). New entry → prepend.
		const filtered = this._openTabs.filter(u => !isEqual(u, uri));
		filtered.unshift(uri);
		// Trim to cap.
		this._openTabs = filtered.slice(0, MAX_TABS);
		this._saveOpenTabs();
	}

	/**
	 * Move tab `from` to land at the same position as `to`. Drag-and-drop
	 * reorder from the widget. If `to` was a higher index than `from`, the
	 * effective drop position shifts by 1 once `from` is removed — handle
	 * that here so the result matches the user's visual intent.
	 */
	private _reorderTab(from: URI, to: URI): void {
		const fromIdx = this._openTabs.findIndex(u => isEqual(u, from));
		const toIdx = this._openTabs.findIndex(u => isEqual(u, to));
		if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
			return;
		}
		const next = this._openTabs.slice();
		const [moved] = next.splice(fromIdx, 1);
		const insertAt = fromIdx < toIdx ? toIdx : toIdx; // splice already shifted indices after fromIdx
		next.splice(insertAt, 0, moved);
		this._openTabs = next;
		this._saveOpenTabs();
		this._renderAll();
	}

	private _removeTab(uri: URI): void {
		const before = this._openTabs.length;
		this._openTabs = this._openTabs.filter(u => !isEqual(u, uri));
		if (this._openTabs.length === before) {
			return;
		}
		this._saveOpenTabs();
		// If we just closed the active tab, switch to the new head (if any).
		if (this._activeUri && isEqual(this._activeUri, uri)) {
			const next = this._openTabs[0];
			if (next) {
				this._openSessionByUri(next);
			} else {
				this._activeUri = undefined;
				// Last tab closed — reset the chat widget so the user lands on
				// the welcome state instead of staring at the previous
				// (now-detached) session's transcript. Same `clear()` call as
				// the `+` new-chat handler, just without a follow-up open.
				const w = this._chatWidgetService.lastFocusedWidget
					?? this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)
						.find(x => x.viewModel)
					?? this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0];
				w?.clear().catch(err => this._logService.warn('[ChipOS Tabs] close-last clear failed', err));
			}
		}
	}

	private _scanAndRender(): void {
		// Prune slots no longer in document — happens when the chat panel
		// is closed/reopened and a new chat-controls-container replaces
		// the previous one.
		for (const [slot] of this._tabs) {
			if (!slot.isConnected) {
				this._tabs.deleteAndDispose(slot);
			}
		}

		const slots = document.querySelectorAll<HTMLElement>('.chipos-session-tabs-slot');
		for (const slot of Array.from(slots)) {
			if (!this._tabs.get(slot)) {
				const tabs = createChipOSChatSessionTabs(this._instantiationService, slot, {
					onOpenTab: (resource: URI) => this._openSessionByUri(resource),
					onCloseTab: (resource: URI) => {
						this._removeTab(resource);
						this._renderAll();
					},
					onNewTab: () => {
						// Don't dispatch `workbench.action.chat.newChat` here —
						// the framework's runNewChatAction can end up calling
						// `viewsService.openView(ChatViewId)`, which reveals
						// the chat view in EVERY location it's been registered
						// in (including the bottom panel area), producing a
						// "duplicate chat panel pops out below" bug.
						//
						// Instead, clear the currently-focused chat panel
						// widget in place — same effect (new untitled chat
						// session) without touching view-host placement.
						const w = this._chatWidgetService.lastFocusedWidget
							?? this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)
								.find(x => x.viewModel)
							?? this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0];
						if (!w) {
							this._logService.warn('[ChipOS Tabs] new-chat: no chat widget to reset');
							return;
						}
						w.clear().catch(err => this._logService.warn('[ChipOS Tabs] new-chat clear failed', err));
						w.focusInput();
					},
					onToggleSessions: () => {
						this._commandService.executeCommand('chipos.toggleChatSessionsSidebar')
							.catch(err => this._logService.warn('[ChipOS Tabs] toggleSessions command failed', err));
					},
					onReorderTabs: (from: URI, to: URI) => this._reorderTab(from, to),
				});
				this._tabs.set(slot, tabs);
			}
		}
		this._renderAll();
	}

	private _renderAll(): void {
		for (const [, tabs] of this._tabs) {
			tabs.render(this._openTabs, this._activeUri);
		}
	}

	private _openSessionByUri(uri: URI): void {
		const session = this._agentSessionsService.model.sessions.find(s => isEqual(s.resource, uri));
		if (session) {
			this._instantiationService.invokeFunction(openSession, session, {})
				.catch(err => this._logService.warn('[ChipOS Tabs] openSession failed', err));
			return;
		}
		// Session not in IAgentSessionsService model — could be a fresh
		// chipos local chat. Fall through to the framework's command to
		// open by sessionResource directly. If that also fails, only then
		// drop the tab.
		this._commandService.executeCommand('workbench.action.chat.open', {
			sessionResource: uri,
		}).catch(err => {
			this._logService.warn('[ChipOS Tabs] openSessionByUri fallback failed', err);
			this._removeTab(uri);
			this._renderAll();
		});
	}
}

registerWorkbenchContribution2(ChipOSChatSessionTabsContribution.ID, ChipOSChatSessionTabsContribution, WorkbenchPhase.BlockRestore);
