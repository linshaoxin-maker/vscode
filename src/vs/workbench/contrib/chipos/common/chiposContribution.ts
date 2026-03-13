/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ChatPanelViewPane } from '../../../../workbench/contrib/chipos/browser/chatPanel/chatPanelViewPane.js';
import { ISidecarManagerService, SidecarState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { SidecarManagerBrowser } from '../../../../workbench/contrib/chipos/browser/sidecarManagerBrowser.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { GettingStartedInput } from '../../../../workbench/contrib/welcomeGettingStarted/browser/gettingStartedInput.js';

import '../../../../workbench/contrib/chipos/common/chiposConfiguration.js';

// ── Service Registration ────────────────────────────────────────────────────
// Uses browser-safe stub; node/ layer (child_process) cannot be loaded in renderer.

registerSingleton(ISidecarManagerService, SidecarManagerBrowser, InstantiationType.Delayed);

// ── Icons ──────────────────────────────────────────────────────────────────────

const chiposViewIcon = registerIcon('chipos-view-icon', Codicon.chatSparkle, localize('chiposViewIcon', 'Icon for ChipOS Chat'));

// ── View Container & Views ─────────────────────────────────────────────────────

const VIEW_CONTAINER_ID = 'chipos-chat';
const CHAT_VIEW_ID = 'chipos.chatView';

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewContainer = viewContainersRegistry.registerViewContainer(
	{
		id: VIEW_CONTAINER_ID,
		title: localize2('chipos', 'ChipOS Chat'),
		icon: chiposViewIcon,
		order: 0,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: `${VIEW_CONTAINER_ID}.state`,
		hideIfEmpty: false,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: true, doNotRegisterOpenCommand: true }
);

viewsRegistry.registerViews(
	[
		{
			id: CHAT_VIEW_ID,
			name: localize2('chiposChatView', 'Chat'),
			containerIcon: chiposViewIcon,
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
			ctorDescriptor: new SyncDescriptor(ChatPanelViewPane),
			openCommandActionDescriptor: {
				id: VIEW_CONTAINER_ID,
				title: localize2('chipos', 'ChipOS Chat'),
				mnemonicTitle: localize({ key: 'miToggleChipOSChat', comment: ['&& denotes a mnemonic'] }, '&&ChipOS Chat'),
				keybindings: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
					mac: {
						primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI
					}
				},
				order: 1
			},
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
	RestartSidecar = 'chipos.restartSidecar',
}

// ── Commands ───────────────────────────────────────────────────────────────────

CommandsRegistry.registerCommand(ChipOSCommandId.OpenChat, accessor => {
	const viewsService = accessor.get(IViewsService);
	viewsService.openView(CHAT_VIEW_ID, true);
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
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.openSettings', 'chipos');
});

CommandsRegistry.registerCommand(ChipOSCommandId.AddToChat, _accessor => {
	// Phase 2: read editor selection, inject into chat input
});

CommandsRegistry.registerCommand(ChipOSCommandId.Disconnect, accessor => {
	const sidecar = accessor.get(ISidecarManagerService);
	sidecar.kill();
});

CommandsRegistry.registerCommand(ChipOSCommandId.RestartSidecar, async accessor => {
	const sidecar = accessor.get(ISidecarManagerService);
	const notifications = accessor.get(INotificationService);
	await sidecar.kill();
	notifications.info('ChipOS: Restarting Sidecar backend…');
	await sidecar.spawn();
	if (sidecar.state === SidecarState.Connected) {
		notifications.info('ChipOS: Sidecar backend restarted successfully.');
	} else {
		notifications.error('ChipOS: Sidecar backend failed to restart.');
	}
});

// ── Keybindings ────────────────────────────────────────────────────────────────

// OpenChat keybinding is now registered via openCommandActionDescriptor (Cmd+Ctrl+I)

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
		id: MenuId.ViewTitle,
		item: {
			command: { id: ChipOSCommandId.RestartSidecar, title: localize('chipos.restartSidecar', 'Restart Backend') },
			when: ContextKeyExpr.equals('view', CHAT_VIEW_ID),
			group: '2_connection',
			order: 2,
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
		@IInstantiationService _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();

		this._lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._initialize();
		});
	}

	private _initialize(): void {
		this._logService.info('[ChipOS] Contribution initialized');

		this._applyEmptyWindowLayout();

		this._register(this._contextService.onDidChangeWorkbenchState(() => {
			this._applyEmptyWindowLayout();
		}));

		this._register(this._sidecarManager.onDidChangeState(state => {
			this._logService.info('[ChipOS] Sidecar state changed:', state);
			if (state === SidecarState.Error) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: 'ChipOS: Sidecar backend failed to start. Check output panel for details.',
				});
			}
		}));

		const autoStart = this._configurationService.getValue<boolean>('chipos.sidecar.autoStart');
		const manualUrl = this._configurationService.getValue<string>('chipos.sidecar.manualUrl');

		if (manualUrl) {
			this._logService.info('[ChipOS] Using manual backend URL:', manualUrl);
			this._sidecarManager.setManualUrl(manualUrl);
			this._sidecarManager.spawn();
		} else if (autoStart) {
			this._logService.info('[ChipOS] Auto-starting Sidecar backend');
			this._sidecarManager.spawn();
		} else {
			this._logService.info('[ChipOS] Sidecar auto-start disabled. Configure chipos.sidecar.manualUrl or enable chipos.sidecar.autoStart.');
		}
	}

	private _applyEmptyWindowLayout(): void {
		const isEmpty = this._contextService.getWorkbenchState() === WorkbenchState.EMPTY;
		if (isEmpty) {
			this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
			this._logService.info('[ChipOS] Empty workspace: hiding sidebar, activitybar, auxiliarybar');
		} else {
			this._layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
			this._closeWelcomeEditor();
		}
	}

	private _closeWelcomeEditor(): void {
		for (const editor of this._editorService.editors) {
			if (editor instanceof GettingStartedInput) {
				editor.dispose();
			}
		}
	}
}

registerWorkbenchContribution2(
	ChipOSContribution.ID,
	ChipOSContribution,
	WorkbenchPhase.AfterRestored
);
