/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChipOSChatSessionsSidebar } from './chiposChatSessionsSidebar.js';

const SIDEBAR_OPEN_STORAGE_KEY = 'chipos.chat.sessionsSidebar.open';
const CHAT_SESSIONS_SIDEBAR_OPEN = new RawContextKey<boolean>('chiposChatSessionsSidebarOpen', false);

/**
 * ChipOS Sessions Sidebar service — owns the lifecycle of
 * `ChipOSChatSessionsSidebar` instances and provides a single toggle
 * entry point for the title-bar action.
 *
 * Why a service (vs. a workbench contribution): the toggle action needs
 * a stable handle to flip the state and we want to support lazy first
 * paint (no sidebar instantiation until the user first toggles it on).
 * Registering as a singleton (InstantiationType.Eager) ensures the
 * service subscribes to `IChatWidgetService.onDidAddWidget` from
 * workbench startup so it can latch onto every chat view that renders.
 */
export const IChipOSChatSessionsSidebarService = createDecorator<IChipOSChatSessionsSidebarService>('chiposChatSessionsSidebarService');

export interface IChipOSChatSessionsSidebarService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeOpenState: Event<boolean>;
	readonly isOpen: boolean;
	toggle(): void;
}

export class ChipOSChatSessionsSidebarService extends Disposable implements IChipOSChatSessionsSidebarService {
	declare readonly _serviceBrand: undefined;

	// Keyed by host element (not chat widget) — toggle() finds all slots
	// by DOM query so it doesn't depend on the widget→host map being
	// populated in the right order. The earlier widget-keyed map missed
	// hosts in races where the chat view re-rendered after toggle.
	private readonly _sidebars = this._register(new DisposableMap<HTMLElement, ChipOSChatSessionsSidebar>());
	private readonly _onDidChangeOpenState = this._register(new Emitter<boolean>());
	readonly onDidChangeOpenState = this._onDidChangeOpenState.event;
	private readonly _openContextKey: IContextKey<boolean>;

	constructor(
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IStorageService private readonly _storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._openContextKey = CHAT_SESSIONS_SIDEBAR_OPEN.bindTo(contextKeyService);
		this._openContextKey.set(this.isOpen);
		// React to new widgets so we apply the initial visibility (default
		// hidden) and attach a sidebar if the user already had it open.
		this._register(this._chatWidgetService.onDidAddWidget(() => this._applyAll()));
		// Also apply once at startup in case the view already rendered.
		queueMicrotask(() => this._applyAll());
	}

	get isOpen(): boolean {
		return this._storageService.getBoolean(SIDEBAR_OPEN_STORAGE_KEY, StorageScope.PROFILE, false);
	}

	toggle(): void {
		const next = !this.isOpen;
		this._storageService.store(SIDEBAR_OPEN_STORAGE_KEY, next, StorageScope.PROFILE, StorageTarget.USER);
		this._openContextKey.set(next);
		this._onDidChangeOpenState.fire(next);
		this._applyAll();
	}

	/**
	 * Discover every `.chipos-sessions-sidebar` slot currently in the DOM
	 * (one per chat panel view, plus future Quick Chat etc.) and apply
	 * the current visibility. Direct DOM query keeps us decoupled from
	 * the chat widget service's add/remove timing.
	 */
	private _applyAll(): void {
		const slots = document.querySelectorAll<HTMLElement>('.chipos-sessions-sidebar');
		slots.forEach(slot => this._applyVisibility(slot));
	}

	private _applyVisibility(host: HTMLElement): void {
		const open = this.isOpen;
		host.style.display = open ? 'flex' : 'none';
		if (open && !this._sidebars.get(host)) {
			const sidebar = this._instantiationService.createInstance(ChipOSChatSessionsSidebar, host);
			this._sidebars.set(host, sidebar);
		}
	}
}

registerSingleton(IChipOSChatSessionsSidebarService, ChipOSChatSessionsSidebarService, InstantiationType.Eager);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'chipos.toggleChatSessionsSidebar',
			title: localize2('chipos.toggleChatSessionsSidebar', 'Toggle ChipOS Chat Sessions Sidebar'),
			icon: Codicon.history,
			menu: [{
				id: MenuId.ChatViewSessionTitleToolbar,
				group: 'navigation',
				order: -100, // far left of the actions toolbar
				when: ContextKeyExpr.true(),
			}],
			toggled: {
				condition: CHAT_SESSIONS_SIDEBAR_OPEN,
				icon: Codicon.history,
				tooltip: localize('chipos.toggleChatSessionsSidebar.tooltip.on', 'Hide chat sessions'),
			},
			tooltip: localize('chipos.toggleChatSessionsSidebar.tooltip', 'Show chat sessions'),
			f1: true,
			category: localize2('chipos', 'ChipOS'),
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IChipOSChatSessionsSidebarService).toggle();
	}
});
