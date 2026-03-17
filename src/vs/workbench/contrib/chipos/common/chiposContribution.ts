/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize } from '../../../../nls.js';
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
import { Codicon } from '../../../../base/common/codicons.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISidecarManagerService, SidecarState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { SidecarManagerBrowser } from '../../../../workbench/contrib/chipos/browser/sidecarManagerBrowser.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { GettingStartedInput } from '../../../../workbench/contrib/welcomeGettingStarted/browser/gettingStartedInput.js';
import { IChatAgentService } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { CHAT_CONFIG_MENU_ID } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatViewId } from '../../../../workbench/contrib/chat/browser/chat.js';
import { nullExtensionDescription } from '../../../../workbench/services/extensions/common/extensions.js';
import { ChipOSChatAgent } from '../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';
import { StatusBarHandler } from '../../../../workbench/contrib/chipos/browser/migration/statusBarHandler.js';
import { ConnectionState } from '../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { IStatusbarService } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { TreeViewPane, CustomTreeView } from '../../../../workbench/browser/parts/views/treeView.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { SkillTreeViewDataProvider } from '../../../../workbench/contrib/chipos/browser/migration/skillTreeHandler.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ChipOSSettingsEditor } from '../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditor.js';
import { ChipOSSettingsEditorInput, ChipOSSettingsTab } from '../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditorInput.js';

import { registerChipOSQuickToggles } from '../../../../workbench/contrib/chipos/browser/settings/chiposQuickToggles.js';

import '../../../../workbench/contrib/chipos/common/chiposConfiguration.js';
import '../../../../workbench/contrib/chipos/browser/settings/modelDiscoveryService.js';
import '../../../../workbench/contrib/chipos/browser/sessions/sessionStorageService.js';

// ── Chat Quick Toggles Registration ────────────────────────────────────────
registerChipOSQuickToggles();

// ── Service Registration ────────────────────────────────────────────────────
registerSingleton(ISidecarManagerService, SidecarManagerBrowser, InstantiationType.Delayed);

// ── ChipOS Settings Editor Registration ─────────────────────────────────────
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ChipOSSettingsEditor,
		ChipOSSettingsEditor.ID,
		localize('chiposSettingsEditor', 'ChipOS Settings')
	),
	[new SyncDescriptor(ChipOSSettingsEditorInput)]
);

// ── SkillTree View Registration ────────────────────────────────────────────

const SKILL_TREE_VIEW_ID = 'chipos.skillTree';
const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

const chiposViewContainer = viewContainersRegistry.registerViewContainer(
	{
		id: 'chipos.tools',
		title: { value: localize('chiposTools', 'ChipOS Tools'), original: 'ChipOS Tools' },
		icon: Codicon.beaker,
		order: 10,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['chipos.tools', { mergeViewWithContainerWhenSingleView: true }]),
		storageId: 'chipos.tools.state',
		hideIfEmpty: true,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: false }
);

viewsRegistry.registerViews([{
	id: SKILL_TREE_VIEW_ID,
	name: { value: localize('chiposSkillTree', 'Skill Tree'), original: 'Skill Tree' },
	ctorDescriptor: new SyncDescriptor(TreeViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	collapsed: true,
	order: 1,
	hideByDefault: false,
}], chiposViewContainer);

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
	AcceptAllDiffs = 'chipos.acceptAllDiffs',
	RejectAllDiffs = 'chipos.rejectAllDiffs',
	OpenGitDiff = 'chipos.openGitDiff',
	UndoAllFileChanges = 'chipos.undoAllFileChanges',
	ClearFileChanges = 'chipos.clearFileChanges',
	SaveContent = 'chipos.saveContent',
}

// ── Commands ───────────────────────────────────────────────────────────────────

CommandsRegistry.registerCommand(ChipOSCommandId.OpenChat, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.open');
});

CommandsRegistry.registerCommand(ChipOSCommandId.StopTask, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.cancel');
});

CommandsRegistry.registerCommand(ChipOSCommandId.NewSession, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.newChat');
});

CommandsRegistry.registerCommand(ChipOSCommandId.ClearHistory, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.clearHistory');
});

CommandsRegistry.registerCommand(ChipOSCommandId.CloseAllSessions, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.clearHistory');
});

CommandsRegistry.registerCommand('chipos.pickSession', async accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	const { AgentSessionsPicker } = await import('../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsPicker.js');
	const picker = instantiationService.createInstance(AgentSessionsPicker, undefined, undefined);
	await picker.pickAgentSession();
});

CommandsRegistry.registerCommand(ChipOSCommandId.OpenSettings, (accessor, tab?: ChipOSSettingsTab) => {
	const editorService = accessor.get(IEditorService);
	const input = accessor.get(IInstantiationService).createInstance(ChipOSSettingsEditorInput);
	editorService.openEditor(input, tab ? { initialTab: tab } as IEditorOptions : undefined);
});

CommandsRegistry.registerCommand(ChipOSCommandId.AddToChat, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.attachSelection');
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

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.OpenChat,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.StopTask,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Period,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.OpenSettings,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.AddToChat,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
	when: ContextKeyExpr.has('editorTextFocus'),
});

KeybindingsRegistry.registerKeybindingRule({
	id: 'chipos.pickSession',
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyH,
});

// ── Menu Contributions ─────────────────────────────────────────────────────────

MenuRegistry.appendMenuItems([
	{
		id: MenuId.EditorContext,
		item: {
			command: { id: ChipOSCommandId.AddToChat, title: localize('chipos.addToChat', 'ChipOS: Add to Chat'), icon: Codicon.commentDiscussion },
			when: ContextKeyExpr.has('editorTextFocus'),
			group: 'chipos',
			order: 1,
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.OpenSettings, title: localize('chipos.openSettings.title', 'ChipOS: Open Settings'), icon: Codicon.gear },
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.AcceptAllDiffs, title: localize('chipos.acceptAllDiffs', 'ChipOS: Accept All Diffs') },
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.RejectAllDiffs, title: localize('chipos.rejectAllDiffs', 'ChipOS: Reject All Diffs') },
		},
	},
	{
		id: CHAT_CONFIG_MENU_ID,
		item: {
			command: { id: ChipOSCommandId.OpenSettings, title: localize('chipos.settings.menuItem', 'ChipOS Settings'), icon: Codicon.gear },
			when: ContextKeyExpr.equals('view', ChatViewId),
			group: '3_chipos',
			order: 1,
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.UndoAllFileChanges, title: localize('chipos.undoAllFileChanges', 'ChipOS: Undo All File Changes') },
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.ClearFileChanges, title: localize('chipos.clearFileChanges', 'ChipOS: Clear File Changes') },
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: 'chipos.pickSession', title: localize('chipos.pickSession', 'ChipOS: Switch Chat Session'), icon: Codicon.history },
		},
	},
	// ── Chat View Title Toolbar (Cursor-style header actions) ──────────────
	{
		id: MenuId.ChatViewSessionTitleToolbar,
		item: {
			command: { id: ChipOSCommandId.NewSession, title: localize('chipos.newChat', 'New Chat'), icon: Codicon.add },
			group: 'navigation',
			order: 1,
		},
	},
	{
		id: MenuId.ChatViewSessionTitleToolbar,
		item: {
			command: { id: ChipOSCommandId.OpenSettings, title: localize('chipos.titleSettings', 'Settings'), icon: Codicon.gear },
			group: 'navigation',
			order: 10,
		},
	},
	{
		id: MenuId.ChatViewSessionTitleToolbar,
		item: {
			command: { id: ChipOSCommandId.Disconnect, title: localize('chipos.titleDisconnect', 'Disconnect Backend'), icon: Codicon.debugDisconnect },
			group: 'overflow',
			order: 1,
		},
	},
	{
		id: MenuId.ChatViewSessionTitleToolbar,
		item: {
			command: { id: ChipOSCommandId.RestartSidecar, title: localize('chipos.titleRestart', 'Restart Backend'), icon: Codicon.debugRestart },
			group: 'overflow',
			order: 2,
		},
	},
	{
		id: MenuId.ChatViewSessionTitleToolbar,
		item: {
			command: { id: ChipOSCommandId.ClearHistory, title: localize('chipos.titleClear', 'Clear Chat History'), icon: Codicon.clearAll },
			group: 'overflow',
			order: 3,
		},
	},
	{
		id: MenuId.ChatViewSessionTitleToolbar,
		item: {
			command: { id: 'aiCustomization.openManagementEditor', title: localize('chipos.titleCustomizations', 'AI Customizations'), icon: Codicon.settingsGear },
			group: 'overflow',
			order: 4,
		},
	},
	// ── Preferences Menu (File > Preferences > ChipOS Settings) ──────────
	{
		id: MenuId.MenubarPreferencesMenu,
		item: {
			command: { id: ChipOSCommandId.OpenSettings, title: localize('chipos.prefMenu', 'ChipOS Settings'), icon: Codicon.gear },
			group: '2_configuration',
			order: 5,
		},
	},
]);

// ── Workbench Contribution ─────────────────────────────────────────────────────

const CHIPOS_AGENT_ID = 'chipos.chat';

class ChipOSContribution extends Disposable {

	static readonly ID = 'workbench.contrib.chipos';

	private _statusBarHandler: StatusBarHandler | undefined;

	constructor(
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly _editorService: IEditorService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IStatusbarService _statusbarService: IStatusbarService,
		@IViewsService _viewsService: IViewsService,
	) {
		super();

		this._lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._initialize();
		});
	}

	private _initialize(): void {
		this._logService.info('[ChipOS] Contribution initialized');

		this._statusBarHandler = this._register(
			this._instantiationService.createInstance(StatusBarHandler)
		);

		this._applyEmptyWindowLayout();

		this._register(this._contextService.onDidChangeWorkbenchState(() => {
			this._applyEmptyWindowLayout();
		}));

		this._register(this._sidecarManager.onDidChangeState(state => {
			this._logService.info('[ChipOS] Sidecar state changed:', state);

			if (this._statusBarHandler) {
				const connectionState = this._mapSidecarToConnectionState(state);
				this._statusBarHandler.updateConnectionState(connectionState);
			}

			if (state === SidecarState.Error) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: 'ChipOS: Sidecar backend failed to start. Check output panel for details.',
				});
			}
		}));

		const autoStart = this._configurationService.getValue<boolean>('chipos.sidecar.autoStart');
		const manualUrl = this._configurationService.getValue<string>('chipos.sidecar.manualUrl');
		const backendUrl = this._configurationService.getValue<string>('chipos.backendUrl');

		if (manualUrl) {
			this._logService.info('[ChipOS] Using manual backend URL:', manualUrl);
			this._sidecarManager.setManualUrl(manualUrl);
			this._sidecarManager.spawn();
		} else if (backendUrl && backendUrl !== 'ws://127.0.0.1:8000/ws/agent') {
			this._logService.info('[ChipOS] Using configured backend URL:', backendUrl);
			this._sidecarManager.setManualUrl(backendUrl);
			this._sidecarManager.spawn();
		} else if (autoStart) {
			this._logService.info('[ChipOS] Auto-starting Sidecar backend');
			this._sidecarManager.spawn();
		} else {
			this._logService.info('[ChipOS] Sidecar auto-start disabled. Configure chipos.sidecar.manualUrl or chipos.backendUrl, or enable chipos.sidecar.autoStart.');
		}

		this._registerChatAgent();
	}

	private _mapSidecarToConnectionState(state: SidecarState): ConnectionState {
		switch (state) {
			case SidecarState.Connected: return ConnectionState.Connected;
			case SidecarState.Spawning: return ConnectionState.Connecting;
			case SidecarState.HealthChecking: return ConnectionState.Connecting;
			case SidecarState.Error: return ConnectionState.Error;
			case SidecarState.Disconnected: return ConnectionState.Disconnected;
			case SidecarState.NotStarted: return ConnectionState.Disconnected;
			default: return ConnectionState.Disconnected;
		}
	}

	private _registerChatAgent(): void {
		this._logService.info('[ChipOS] Registering native chat agent');

		this._register(this._chatAgentService.registerAgent(CHIPOS_AGENT_ID, {
			id: CHIPOS_AGENT_ID,
			name: 'ChipOS',
			fullName: 'ChipOS AI Assistant',
			description: 'ChipOS AI-powered coding assistant for EDA development',
			isDefault: true,
			isCore: false,
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent, ChatModeKind.Spec],
			slashCommands: [],
			disambiguation: [],
			locations: [ChatAgentLocation.Chat],
			metadata: {
				sampleRequest: 'Help me design a 32-bit AXI4 bus interface with configurable data width',
				themeIcon: Codicon.chatSparkle,
			},
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: 'ChipOS',
			extensionPublisherId: nullExtensionDescription.publisher,
		}));

		const agentImpl = this._register(
			this._instantiationService.createInstance(ChipOSChatAgent)
		);
		this._register(this._chatAgentService.registerAgentImplementation(CHIPOS_AGENT_ID, agentImpl));

		this._registerInlineDiffCommands(agentImpl);
		this._registerFileChangeCommands(agentImpl);
		this._registerSkillTreeView(agentImpl);

		agentImpl.editorEffects.onDidChangeFileChanges(files => {
			if (this._statusBarHandler) {
				this._statusBarHandler.updateFileChangeCount(files.length);
			}
		});

		this._logService.info('[ChipOS] Native chat agent registered successfully');
	}

	private _registerSkillTreeView(agent: ChipOSChatAgent): void {
		const treeView = this._instantiationService.createInstance(
			CustomTreeView, SKILL_TREE_VIEW_ID, localize('chiposSkillTree', 'Skill Tree'), 'chipos'
		);
		this._register(treeView);

		const dataProvider = new SkillTreeViewDataProvider(agent.skillTreeHandler);
		treeView.dataProvider = dataProvider;

		agent.skillTreeHandler.onDidChangeTreeData(() => {
			treeView.refresh();
		});

		this._logService.info('[ChipOS] SkillTree view registered');
	}

	private _registerInlineDiffCommands(agent: ChipOSChatAgent): void {
		this._register(CommandsRegistry.registerCommand(ChipOSCommandId.AcceptAllDiffs, () => {
			agent.acceptAllDiffs();
			this._logService.info('[ChipOS] Accept all diffs');
		}));

		this._register(CommandsRegistry.registerCommand(ChipOSCommandId.RejectAllDiffs, () => {
			agent.rejectAllDiffs();
			this._logService.info('[ChipOS] Reject all diffs');
		}));
	}

	private _registerFileChangeCommands(agent: ChipOSChatAgent): void {
		const effects = agent.editorEffects;

		this._register(CommandsRegistry.registerCommand(ChipOSCommandId.OpenGitDiff, (_accessor, filePath?: string) => {
			if (filePath) {
				effects.openGitDiff(filePath);
			}
		}));

		this._register(CommandsRegistry.registerCommand(ChipOSCommandId.UndoAllFileChanges, async () => {
			const count = effects.fileChangeCount;
			if (!count) {
				this._notificationService.info('ChipOS: No file changes to undo.');
				return;
			}
			const { reverted, errors } = await effects.undoAllFileChanges();
			if (errors.length) {
				this._notificationService.error(`ChipOS: Undo failed – ${errors.join(', ')}`);
			} else {
				this._notificationService.info(`ChipOS: Reverted ${reverted} file(s).`);
			}
		}));

		this._register(CommandsRegistry.registerCommand(ChipOSCommandId.ClearFileChanges, () => {
			effects.clearFileChanges();
			this._logService.info('[ChipOS] File changes cleared');
		}));

		this._register(CommandsRegistry.registerCommand(ChipOSCommandId.SaveContent, async (_accessor, content?: string, suggestedName?: string) => {
			if (!content) { return; }
			const folders = this._contextService.getWorkspace().folders;
			if (!folders.length) { return; }
			const defaultName = suggestedName || 'output.md';
			const defaultUri = URI.joinPath(folders[0].uri, defaultName);
			try {
				await this._editorService.openEditor({
					resource: defaultUri,
					contents: content,
					options: { pinned: false },
				});
				this._notificationService.info(`ChipOS: Content opened as ${defaultName}`);
			} catch (err) {
				this._notificationService.error(`ChipOS: Save failed – ${err instanceof Error ? err.message : String(err)}`);
			}
		}));
	}

	private _applyEmptyWindowLayout(): void {
		const isEmpty = this._contextService.getWorkbenchState() === WorkbenchState.EMPTY;
		if (isEmpty) {
			// Cursor-style: keep ActivityBar + AuxiliaryBar (Chat) visible even in empty window
			// Only hide the primary sidebar (Explorer) since there's no workspace to explore
			this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
			this._logService.info('[ChipOS] Empty workspace: hiding sidebar, keeping activitybar + chat visible');
		} else {
			this._layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
		}
		// Cursor-style: always close the Welcome/Getting Started editor
		// Chat panel replaces the Welcome editor as the primary onboarding surface
		this._closeWelcomeEditor();
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
