/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { localize, localize2 } from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vs/workbench/common/contributions';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { KeybindingsRegistry, KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { ILifecycleService, LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { MenuId, MenuRegistry } from 'vs/platform/actions/common/actions';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ViewPaneContainer } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from 'vs/workbench/common/views';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { Codicon } from 'vs/base/common/codicons';
import { registerIcon } from 'vs/platform/theme/common/iconRegistry';
import { ChatPanelViewPane } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatPanelViewPane';

// ── Icons ──────────────────────────────────────────────────────────────────────

const chiposViewIcon = registerIcon('chipos-view-icon', Codicon.chip, localize('chiposViewIcon', 'Icon for ChipOS sidebar'));

// ── View Container & Views ─────────────────────────────────────────────────────

const VIEW_CONTAINER_ID = 'chipos-chat';
const CHAT_VIEW_ID = 'chipos.chatView';

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewContainer = viewContainersRegistry.registerViewContainer(
	{
		id: VIEW_CONTAINER_ID,
		title: localize2('chipos', 'ChipOS'),
		icon: chiposViewIcon,
		order: 100,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: `${VIEW_CONTAINER_ID}.state`,
		hideIfEmpty: false,
	},
	ViewContainerLocation.Sidebar,
	{ isDefault: false }
);

viewsRegistry.registerViews(
	[
		{
			id: CHAT_VIEW_ID,
			name: localize2('chiposChatView', 'ChipOS Chat'),
			containerIcon: chiposViewIcon,
			canToggleVisibility: true,
			canMoveView: true,
			order: 0,
			ctorDescriptor: new SyncDescriptor(ChatPanelViewPane),
			when: ContextKeyExpr.true(),
		},
	],
	viewContainer
);

// ── Command IDs ────────────────────────────────────────────────────────────────

const enum ChipOSCommandId {
	OpenChat = 'chipos.openChat',
	StopTask = 'chipos.stopTask',
	NewSession = 'chipos.newSession',
	ClearHistory = 'chipos.clearHistory',
	CloseAllSessions = 'chipos.closeAllSessions',
	OpenSettings = 'chipos.openSettings',
	AddToChat = 'chipos.addToChat',
	Disconnect = 'chipos.disconnect',
}

// ── Commands ───────────────────────────────────────────────────────────────────

CommandsRegistry.registerCommand(ChipOSCommandId.OpenChat, accessor => {
	const viewsService = accessor.get('IViewsService' as any);
	viewsService?.openView(CHAT_VIEW_ID, true);
});

CommandsRegistry.registerCommand(ChipOSCommandId.StopTask, _accessor => {
	// Phase 2: wire to AgentEventEmitter.cancel()
});

CommandsRegistry.registerCommand(ChipOSCommandId.NewSession, _accessor => {
	// Phase 2: wire to ChatSessionManager.createSession()
});

CommandsRegistry.registerCommand(ChipOSCommandId.ClearHistory, _accessor => {
	// Phase 2: wire to ChatSessionManager.clearCurrent()
});

CommandsRegistry.registerCommand(ChipOSCommandId.CloseAllSessions, _accessor => {
	// Phase 2: wire to ChatSessionManager.closeAll()
});

CommandsRegistry.registerCommand(ChipOSCommandId.OpenSettings, accessor => {
	const commandService = accessor.get('ICommandService' as any);
	commandService?.executeCommand('workbench.action.openSettings', 'chipos');
});

CommandsRegistry.registerCommand(ChipOSCommandId.AddToChat, _accessor => {
	// Phase 2: read editor selection, inject into chat input
});

CommandsRegistry.registerCommand(ChipOSCommandId.Disconnect, _accessor => {
	// Phase 2: wire to WebSocket close
});

// ── Keybindings ────────────────────────────────────────────────────────────────

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.OpenChat,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyH,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.StopTask,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Period,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.AddToChat,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
	when: ContextKeyExpr.has('editorTextFocus'),
});

// ── Menu Contributions ─────────────────────────────────────────────────────────

MenuRegistry.appendMenuItems([
	{
		id: MenuId.ViewTitle,
		item: {
			command: { id: ChipOSCommandId.NewSession, title: localize('chipos.newSession', 'New Session'), icon: Codicon.add },
			when: ContextKeyExpr.equals('view', CHAT_VIEW_ID),
			group: 'navigation',
			order: 1,
		},
	},
	{
		id: MenuId.ViewTitle,
		item: {
			command: { id: ChipOSCommandId.OpenSettings, title: localize('chipos.openSettings', 'Settings'), icon: Codicon.gear },
			when: ContextKeyExpr.equals('view', CHAT_VIEW_ID),
			group: 'navigation',
			order: 2,
		},
	},
	{
		id: MenuId.ViewTitle,
		item: {
			command: { id: ChipOSCommandId.ClearHistory, title: localize('chipos.clearHistory', 'Clear History'), icon: Codicon.clearAll },
			when: ContextKeyExpr.equals('view', CHAT_VIEW_ID),
			group: '1_actions',
			order: 1,
		},
	},
	{
		id: MenuId.ViewTitle,
		item: {
			command: { id: ChipOSCommandId.CloseAllSessions, title: localize('chipos.closeAllSessions', 'Close All Sessions') },
			when: ContextKeyExpr.equals('view', CHAT_VIEW_ID),
			group: '1_actions',
			order: 2,
		},
	},
	{
		id: MenuId.ViewTitle,
		item: {
			command: { id: ChipOSCommandId.Disconnect, title: localize('chipos.disconnect', 'Disconnect') },
			when: ContextKeyExpr.equals('view', CHAT_VIEW_ID),
			group: '2_connection',
			order: 1,
		},
	},
	{
		id: MenuId.EditorContext,
		item: {
			command: { id: ChipOSCommandId.AddToChat, title: localize('chipos.addToChat', 'ChipOS: Add to Chat'), icon: Codicon.commentDiscussion },
			when: ContextKeyExpr.has('editorTextFocus'),
			group: 'chipos',
			order: 1,
		},
	},
]);

// ── Workbench Contribution ─────────────────────────────────────────────────────

class ChipOSContribution extends Disposable {

	static readonly ID = 'workbench.contrib.chipos';

	constructor(
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._initialize();
		});
	}

	private _initialize(): void {
		this._logService.info('[ChipOS] Contribution initialized');
	}
}

registerWorkbenchContribution2(
	ChipOSContribution.ID,
	ChipOSContribution,
	WorkbenchPhase.AfterRestored
);
