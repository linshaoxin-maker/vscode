/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { openSession } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsOpener.js';
import { IAgentSessionsService } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { ChipOSChatSessionTabs, createChipOSChatSessionTabs } from './chiposChatSessionTabs.js';

const OPEN_TABS_STORAGE_KEY = 'chipos.chat.openSessionTabs';
const MAX_TABS = 8;

/**
 * ChipOS Chat Session Tabs service — owns persistence of the open-tabs
 * list and orchestrates rendering into every `.chipos-session-tabs-slot`
 * DOM element seeded by the chatViewPane patch.
 *
 * Why a service:
 *   - Multiple chat hosts (panel + future quick-chat / inline) can each
 *     have their own slot. A central service keeps state coherent.
 *   - Subscribes to `IChatWidgetService.onDidChangeFocusedSession` once
 *     and broadcasts re-render to every mounted tabs widget.
 *
 * Lifecycle:
 *   - Construct on app startup (`InstantiationType.Eager`).
 *   - On each `onDidAddWidget`, scan DOM for any slots not yet rendered
 *     and attach a tabs widget.
 *   - State (open tabs list) persists in `IStorageService` PROFILE
 *     scope, capped at MAX_TABS via LRU (most-recent-activated wins).
 */
export const IChipOSChatSessionTabsService = createDecorator<IChipOSChatSessionTabsService>('chiposChatSessionTabsService');

export interface IChipOSChatSessionTabsService {
	readonly _serviceBrand: undefined;
}

export class ChipOSChatSessionTabsService extends Disposable implements IChipOSChatSessionTabsService {
	declare readonly _serviceBrand: undefined;

	private readonly _tabs = this._register(new DisposableMap<HTMLElement, ChipOSChatSessionTabs>());
	private _openTabs: URI[] = [];
	private _activeUri: URI | undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
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
				return;
			}
			const session = widget.viewModel?.sessionResource;
			this._activeUri = session;
			if (session) {
				this._addTab(session);
			}
			this._renderAll();
		}));

		// Also re-render when the agent sessions model itself changes
		// (rename, delete, archive). Labels/icons might shift.
		this._register(this._agentSessionsService.model.onDidChangeSessions(() => this._renderAll()));
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
			}
		}
	}

	private _scanAndRender(): void {
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
						this._commandService.executeCommand('workbench.action.chat.newChat')
							.catch(err => this._logService.warn('[ChipOS Tabs] newChat command failed', err));
					},
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
		if (!session) {
			// Session no longer exists in history (deleted) — drop the tab.
			this._removeTab(uri);
			this._renderAll();
			return;
		}
		this._instantiationService.invokeFunction(openSession, session, {})
			.catch(err => this._logService.warn('[ChipOS Tabs] openSession failed', err));
	}
}

registerSingleton(IChipOSChatSessionTabsService, ChipOSChatSessionTabsService, InstantiationType.Eager);
