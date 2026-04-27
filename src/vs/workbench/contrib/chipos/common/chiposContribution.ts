/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IChipOSTokenManager } from '../../../../workbench/contrib/chipos/browser/auth/chiposTokenManager.js';
import { IChipOSAuthService } from '../../../../workbench/contrib/chipos/browser/auth/chiposAuthService.js';
import { IChipOSRuntimeOverridesService } from '../../../../workbench/contrib/chipos/common/chiposRuntimeOverrides.js';
import { IChipOSUsageService } from '../../../../workbench/contrib/chipos/browser/billing/chiposUsageService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ISidecarManagerService, SidecarState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { GettingStartedInput } from '../../../../workbench/contrib/welcomeGettingStarted/browser/gettingStartedInput.js';
import { IChatAgentService } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { CHAT_CONFIG_MENU_ID } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatViewId, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { nullExtensionDescription } from '../../../../workbench/services/extensions/common/extensions.js';
import { ChipOSChatAgent } from '../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';
import { StatusBarHandler } from '../../../../workbench/contrib/chipos/browser/migration/statusBarHandler.js';
import { ConnectionState } from '../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { IStatusbarService } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IMcpService, McpConnectionState } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { autorun } from '../../../../base/common/observable.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ITreeViewDescriptor, TreeViewItemHandleArg, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { TreeViewPane, CustomTreeView, TreeView } from '../../../../workbench/browser/parts/views/treeView.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { SkillTreeViewDataProvider } from '../../../../workbench/contrib/chipos/browser/migration/skillTreeHandler.js';
import { IWorkerToolManagerService, WorkerToolsViewDataProvider } from '../../../../workbench/contrib/chipos/browser/workerToolManager.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ChipOSSettingsEditor } from '../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditor.js';
import { ChipOSSettingsEditorInput, ChipOSSettingsTab } from '../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditorInput.js';
import { IChatContentPartRegistry } from '../../../../workbench/contrib/chat/browser/chatContentPartRegistry.js';
import { chatViewsWelcomeRegistry } from '../../../../workbench/contrib/chat/browser/viewsWelcome/chatViewsWelcome.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { ChatEdaSimReportContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaSimReportPart.js';
import { ChatEdaCoverageReportContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaCoverageReportPart.js';
import { ChatEdaLintReportContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaLintReportPart.js';
import { ChatEdaParallelProgressContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaParallelProgressPart.js';
import { ChatEdaNegotiationViewContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaNegotiationViewPart.js';
import { ChatEdaSpecReviewContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaSpecReviewPart.js';
import { ChatRoundProgressContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatRoundProgressPart.js';
import { ChatAgentErrorContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatAgentErrorPart.js';
import { ChatEdaPpaReportContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatEdaPpaReportPart.js';
import { AgentSessionsPicker } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsPicker.js';

import { registerChipOSQuickToggles } from '../../../../workbench/contrib/chipos/browser/settings/chiposQuickToggles.js';

import '../../../../workbench/contrib/chipos/common/chiposConfiguration.js';
import '../../../../workbench/contrib/chipos/browser/settings/modelDiscoveryService.js';
import '../../../../workbench/contrib/chipos/browser/sessions/sessionStorageService.js';
import '../../../../workbench/contrib/chipos/browser/media/chiposOverrides.css';

// ── Chat Quick Toggles Registration ────────────────────────────────────────
registerChipOSQuickToggles();

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
const WORKER_TOOLS_VIEW_ID = 'chipos.workerTools';
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

// Note: Skill Tree and Worker Tools views are registered in _initialize()
// because they need IInstantiationService to create TreeView instances.

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
	RestartBackend = 'chipos.restartBackend',
	RestartWorker = 'chipos.restartWorker',
	AcceptAllDiffs = 'chipos.acceptAllDiffs',
	RejectAllDiffs = 'chipos.rejectAllDiffs',
	OpenGitDiff = 'chipos.openGitDiff',
	UndoAllFileChanges = 'chipos.undoAllFileChanges',
	ClearFileChanges = 'chipos.clearFileChanges',
	SaveContent = 'chipos.saveContent',
	MarkdownPreviewToSide = 'chipos.markdownPreviewToSide',
	MarkdownShowSource = 'chipos.markdownShowSource',
	Login = 'chipos.auth.login',
	Logout = 'chipos.auth.logout',
	LegacyLogin = 'chipos.login',
	LegacyLogout = 'chipos.logout',
	OpenUsageDashboard = 'chipos.dashboard.openUsage',
	OpenTeamDashboard = 'chipos.dashboard.openTeam',
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
	const picker = instantiationService.createInstance(AgentSessionsPicker, undefined, undefined);
	await picker.pickAgentSession();
});

CommandsRegistry.registerCommand(ChipOSCommandId.OpenSettings, (accessor, tab?: ChipOSSettingsTab) => {
	const editorService = accessor.get(IEditorService);
	const input = accessor.get(IInstantiationService).createInstance(ChipOSSettingsEditorInput);
	// Always pass initialTab so the editor resets to General (or the requested
	// tab) even when reopened — without this, openEditor on an already-open
	// instance would just focus it without changing tabs.
	const initialTab: ChipOSSettingsTab = tab ?? 'general';
	editorService.openEditor(input, { initialTab } as IEditorOptions);
});

CommandsRegistry.registerCommand(ChipOSCommandId.AddToChat, accessor => {
	const commandService = accessor.get(ICommandService);
	commandService.executeCommand('workbench.action.chat.attachSelection');
});

CommandsRegistry.registerCommand(ChipOSCommandId.Disconnect, async accessor => {
	const backend = accessor.get(ISidecarManagerService);
	await backend.stopBackend();
});

CommandsRegistry.registerCommand(ChipOSCommandId.RestartSidecar, async accessor => {
	// Deprecated alias — delegates to RestartBackend
	const backend = accessor.get(ISidecarManagerService);
	const notifications = accessor.get(INotificationService);
	notifications.info('ChipOS: Restarting backend…');
	await backend.stopBackend();
	await backend.startBackend();
});

CommandsRegistry.registerCommand(ChipOSCommandId.RestartBackend, async accessor => {
	const backend = accessor.get(ISidecarManagerService);
	const notifications = accessor.get(INotificationService);
	notifications.info('ChipOS: Restarting backend…');
	await backend.stopBackend();
	await backend.startBackend();
	if (backend.state === SidecarState.Connected) {
		notifications.info('ChipOS: Backend restarted successfully.');
	} else {
		notifications.error('ChipOS: Backend failed to restart.');
	}
});

CommandsRegistry.registerCommand(ChipOSCommandId.RestartWorker, async accessor => {
	const backend = accessor.get(ISidecarManagerService);
	const notifications = accessor.get(INotificationService);
	notifications.info('ChipOS: Restarting worker…');
	await backend.restartWorker();
	notifications.info('ChipOS: Worker restart initiated.');
});

// ── Phase 1 Unified Auth: Login / Logout commands ──

CommandsRegistry.registerCommand(ChipOSCommandId.Login, async accessor => {
	const authService = accessor.get(IChipOSAuthService);
	const notifications = accessor.get(INotificationService);
	try {
		await authService.login();
	} catch (err) {
		notifications.error(`ChipOS Login failed: ${err}`);
	}
});

CommandsRegistry.registerCommand(ChipOSCommandId.Logout, async accessor => {
	const authService = accessor.get(IChipOSAuthService);
	const notifications = accessor.get(INotificationService);
	await authService.logout();
	notifications.info('ChipOS: Logged out.');
});

/**
 * Phase 1.5 Worker JWT bridge for the chipos-remote-ssh extension.
 *
 * The extension lives in the UI extension host and cannot import the workbench
 * service directly. It invokes this command via `vscode.commands.executeCommand`
 * to mint a Worker JWT, then passes it as `CHIPOS_WORKER_TOKEN` env when
 * spawning the remote Worker.
 *
 * Returns undefined when the user is not logged in or the website rejects
 * the exchange; callers fall back to the legacy static apiKey path.
 */
CommandsRegistry.registerCommand('chipos.auth.getWorkerToken', async (accessor, workerId?: string) => {
	const authService = accessor.get(IChipOSAuthService);
	if (!authService.isLoggedIn()) {
		return undefined;
	}
	try {
		const result = await authService.getWorkerToken(workerId);
		return result;
	} catch {
		return undefined;
	}
});

/**
 * P2-14: runtime URL override bridge for chipos-remote-ssh.
 *
 * The extension calls these commands instead of writing to Global config —
 * see chiposRuntimeOverrides.ts header for the full rationale. Per-window
 * service means B1's Worker HTTP tunnel URL never leaks into B2.
 *
 * Both commands no-op cleanly when the service isn't available (older
 * workbench builds), so a mismatched ext+core combo just falls back to the
 * old configuration-based behavior rather than crashing.
 *
 * Accepted keys: `'workerHttpUrl'`. Older versions also accepted
 * `'reasoningUrl'`; that key is silently dropped here so an old
 * chipos-remote-ssh extension talking to a new workbench fails closed
 * (chat won't be misrouted through a stale tunnel URL) rather than
 * silently misbehaving.
 */
const RUNTIME_OVERRIDE_KEYS = new Set<string>(['workerHttpUrl']);

CommandsRegistry.registerCommand('chipos.runtime.setOverride', (accessor, key: string, value: string | undefined) => {
	if (!RUNTIME_OVERRIDE_KEYS.has(key)) {
		return; // unknown / deprecated key — ignore
	}
	try {
		const svc = accessor.get(IChipOSRuntimeOverridesService);
		svc.setOverride(key as 'workerHttpUrl', value);
	} catch {
		// Service not registered (very old workbench) — drop silently.
	}
});

CommandsRegistry.registerCommand('chipos.runtime.clearOverride', (accessor, key?: string) => {
	try {
		const svc = accessor.get(IChipOSRuntimeOverridesService);
		if (!key) {
			svc.clearAllOverrides();
		} else if (RUNTIME_OVERRIDE_KEYS.has(key)) {
			svc.clearOverride(key as 'workerHttpUrl');
		}
	} catch {
		// Service not registered.
	}
});

CommandsRegistry.registerCommand(ChipOSCommandId.LegacyLogin, accessor => {
	const commandService = accessor.get(ICommandService);
	return commandService.executeCommand(ChipOSCommandId.Login);
});

CommandsRegistry.registerCommand(ChipOSCommandId.LegacyLogout, accessor => {
	const commandService = accessor.get(ICommandService);
	return commandService.executeCommand(ChipOSCommandId.Logout);
});

// ── Phase 2 / 3: Open chipos website pages from the IDE ────────────────────────

function openChiposPage(accessor: ServicesAccessor, path: string): void {
	const tokenManager = accessor.get(IChipOSTokenManager);
	const opener = accessor.get(IOpenerService);
	const websiteUrl = tokenManager.resolveWebsiteUrl();
	if (!websiteUrl) {
		accessor.get(INotificationService).warn(
			'ChipOS: chipos.auth.websiteUrl is not configured — set it in Connection settings.',
		);
		return;
	}
	opener.open(URI.parse(`${websiteUrl.replace(/\/$/, '')}${path}`), { openExternal: true });
}

CommandsRegistry.registerCommand(ChipOSCommandId.OpenUsageDashboard, accessor => {
	openChiposPage(accessor, '/dashboard/usage');
});

CommandsRegistry.registerCommand(ChipOSCommandId.OpenTeamDashboard, accessor => {
	openChiposPage(accessor, '/dashboard/team');
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

// ── Additional Cursor-style keybindings ──
KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.NewSession,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.Disconnect,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.RestartSidecar,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.AcceptAllDiffs,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY,
	when: ContextKeyExpr.has('chatIsVisible'),
});

KeybindingsRegistry.registerKeybindingRule({
	id: ChipOSCommandId.RejectAllDiffs,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace,
	when: ContextKeyExpr.has('chatIsVisible'),
});

// ── Markdown Preview / Source Commands (delegate to built-in extension) ──────
CommandsRegistry.registerCommand(ChipOSCommandId.MarkdownPreviewToSide, accessor => {
	accessor.get(ICommandService).executeCommand('markdown.showPreviewToSide');
});

CommandsRegistry.registerCommand(ChipOSCommandId.MarkdownShowSource, accessor => {
	accessor.get(ICommandService).executeCommand('markdown.showSource');
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
	// ── Markdown Preview / Source buttons in Editor Title ──────────────────
	// DEBUG: when set to true() to always show — will restrict after confirming it works
	{
		id: MenuId.EditorTitle,
		item: {
			command: {
				id: ChipOSCommandId.MarkdownPreviewToSide,
				title: localize('chipos.markdownPreview', 'Open Preview to the Side'),
				icon: Codicon.openPreview,
			},
			when: ContextKeyExpr.true(),
			group: 'navigation',
			order: -100,
		},
	},
	{
		id: MenuId.EditorTitle,
		item: {
			command: {
				id: ChipOSCommandId.MarkdownShowSource,
				title: localize('chipos.markdownSource', 'Show Source'),
				icon: Codicon.goToFile,
			},
			when: ContextKeyExpr.or(
				ContextKeyExpr.equals('activeWebviewPanelId', 'markdown.preview'),
				ContextKeyExpr.equals('activeCustomEditorId', 'vscode.markdown.preview.editor'),
			),
			group: 'navigation',
			order: -100,
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
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IStatusbarService _statusbarService: IStatusbarService,
		@IViewsService _viewsService: IViewsService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IMcpService private readonly _mcpService: IMcpService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@IChipOSUsageService private readonly _usageService: IChipOSUsageService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();

		this._lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._initialize();
		});
	}

	private _initialize(): void {
		this._logService.info('[ChipOS] Contribution initialized');

		// ── Phase 1 Unified Auth: Initialize TokenManager ──
		this._tokenManager.initialize().then(() => {
			this._logService.info('[ChipOS] TokenManager initialized, logged in:', this._tokenManager.isLoggedIn());
		}).catch(err => {
			this._logService.error('[ChipOS] TokenManager initialization failed:', String(err));
		});

		// ── Phase 1 Unified Auth: Register URI handler for chipos://callback ──
		this._registerAuthUriHandler();

		// ── Bypass Copilot entitlement gates ──
		// ChipOS doesn't use GitHub Copilot auth. Set context keys so all
		// framework features (footer toolbar, model picker, etc.) are unlocked.
		this._contextKeyService.createKey('chatPlanPro', true);
		this._contextKeyService.createKey('chatSetupInstalled', true);
		this._contextKeyService.createKey('chatSetupRegistered', true);
		this._contextKeyService.createKey('chatSetupHidden', true);
		this._contextKeyService.createKey('chatEntitlementSignedOut', false);
		this._logService.info('[ChipOS] Entitlement context keys set (Pro bypass)');

		// ── Register ChipOS Welcome View ──
		this._registerWelcomeView();

		this._statusBarHandler = this._register(
			this._instantiationService.createInstance(StatusBarHandler)
		);

		// Phase 2 Usage status bar widget — start polling and forward results.
		const handler = this._statusBarHandler;
		this._register(this._usageService.onDidChangeUsage(display => {
			handler.updateUsage(display);
		}));
		this._usageService.start();

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
					message: 'ChipOS: Backend failed to start. Check output panel for details.',
				});
			}
		}));

		const backendMode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
		// developerBuild comes from product.json (build-time), not runtime user
		// settings — end-user release builds have it false/absent.
		const developerBuild = this._productService.chiposDefaults?.developerBuild === true;

		// v2: SidecarManager will resolve "auto" against the actual environment.
		this._logService.info(`[ChipOS] Starting backend, configured mode='${backendMode}' developerBuild=${developerBuild}`);
		this._sidecarManager.startBackend();

		this._registerChatAgent();
		this._registerEdaContentParts();
		this._registerWorkerToolsView();
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
			isCore: true,
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

		const syncActiveSessionProjection = () => {
			const sessionResource = this._chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource;
			agentImpl.editorEffects.setActiveSession(sessionResource);
		};

		this._register(this._chatWidgetService.onDidChangeFocusedSession(syncActiveSessionProjection));
		syncActiveSessionProjection();

		agentImpl.editorEffects.onDidChangeFileChanges(files => {
			if (this._statusBarHandler) {
				this._statusBarHandler.updateFileChangeCount(files.length);
			}
		});

		// ── R58: MCP Server 状态 → 状态栏 ──────────────────────────────────
		this._register(autorun(reader => {
			const servers = this._mcpService.servers.read(reader);
			let toolCount = 0;
			let hasError = false;
			for (const server of servers) {
				const tools = server.tools.read(reader);
				toolCount += tools.length;
				const state = server.connectionState.read(reader);
				if (state.state === McpConnectionState.Kind.Error) {
					hasError = true;
				}
			}
			if (this._statusBarHandler) {
				this._statusBarHandler.updateMcpStatus(servers.length, toolCount, hasError);
			}
		}));

		this._logService.info('[ChipOS] Native chat agent registered successfully');
	}

	private _registerSkillTreeView(agent: ChipOSChatAgent): void {
		const treeView = this._instantiationService.createInstance(
			CustomTreeView, SKILL_TREE_VIEW_ID, localize('chiposSkillTree', 'Skill Tree'), 'chipos'
		);
		this._register(treeView);

		const dataProvider = new SkillTreeViewDataProvider(agent.skillTreeHandler);
		treeView.dataProvider = dataProvider;

		// Register the view with treeView field so TreeViewPane can find it
		viewsRegistry.registerViews([{
			id: SKILL_TREE_VIEW_ID,
			name: { value: localize('chiposSkillTree', 'Skill Tree'), original: 'Skill Tree' },
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			treeView,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			order: 1,
			hideByDefault: false,
		} as ITreeViewDescriptor], chiposViewContainer);

		agent.skillTreeHandler.onDidChangeTreeData(() => {
			treeView.refresh();
		});

		this._logService.info('[ChipOS] SkillTree view registered');
	}

	// ── R26: Worker Tools View ──────────────────────────────────────────────
	private _registerWorkerToolsView(): void {
		const workerToolsTreeView = this._instantiationService.createInstance(
			TreeView, WORKER_TOOLS_VIEW_ID, localize('chiposWorkerTools', 'Worker Tools')
		);
		workerToolsTreeView.showRefreshAction = true;
		workerToolsTreeView.showCollapseAllAction = true;
		this._register(workerToolsTreeView);

		const workerToolsDataProvider = this._instantiationService.createInstance(WorkerToolsViewDataProvider);
		workerToolsTreeView.dataProvider = workerToolsDataProvider;

		viewsRegistry.registerViews([{
			id: WORKER_TOOLS_VIEW_ID,
			name: { value: localize('chiposWorkerTools', 'Worker Tools'), original: 'Worker Tools' },
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			treeView: workerToolsTreeView,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			when: ContextKeyExpr.true()!,
			order: 20,
		} as ITreeViewDescriptor], chiposViewContainer);

		this._logService.info('[ChipOS] Worker Tools view registered (R26)');
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

	private _registerEdaContentParts(): void {
		const registry = this._instantiationService.invokeFunction(accessor => accessor.get(IChatContentPartRegistry));
		registry.registerContentPart('edaSimReport', (content, inst) => inst.createInstance(ChatEdaSimReportContentPart, content as any));
		registry.registerContentPart('edaCoverageReport', (content, inst) => inst.createInstance(ChatEdaCoverageReportContentPart, content as any));
		registry.registerContentPart('edaLintReport', (content, inst) => inst.createInstance(ChatEdaLintReportContentPart, content as any));
		registry.registerContentPart('edaParallelProgress', (content, inst) => inst.createInstance(ChatEdaParallelProgressContentPart, content as any));
		registry.registerContentPart('edaNegotiationView', (content, inst) => inst.createInstance(ChatEdaNegotiationViewContentPart, content as any));
		registry.registerContentPart('edaSpecReview', (content, inst) => inst.createInstance(ChatEdaSpecReviewContentPart, content as any));
		registry.registerContentPart('roundProgress', (content, inst) => inst.createInstance(ChatRoundProgressContentPart, content as any));
		registry.registerContentPart('agentError', (content, inst) => inst.createInstance(ChatAgentErrorContentPart, content as any));
		registry.registerContentPart('edaPpaReport', (content, inst) => inst.createInstance(ChatEdaPpaReportContentPart, content as any));
		this._logService.info('[ChipOS] Registered 9 EDA content part renderers');
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
			// Cursor-style: hide sidebar (no workspace to explore), keep AuxiliaryBar (Chat) visible
			// Activity Bar is hidden by default (product.json configurationDefaults) — don't override
			this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			this._logService.info('[ChipOS] Empty workspace: hiding sidebar, keeping chat visible');
		} else {
			this._layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
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

	private _registerAuthUriHandler(): void {
		const urlService = this._instantiationService.invokeFunction(accessor => accessor.get(IURLService));
		const authService = this._instantiationService.invokeFunction(accessor => accessor.get(IChipOSAuthService));
		this._register(urlService.registerHandler({
			handleURL: async (uri: URI): Promise<boolean> => {
				// Handle chipos://callback?code=...
				if (uri.authority === 'callback' || uri.path === '/callback') {
					this._logService.info('[ChipOS Auth] URI handler received callback:', uri.toString());
					await authService.handleCallback(uri);
					return true;
				}
				return false;
			}
		}));
	}

	private _registerWelcomeView(): void {
		chatViewsWelcomeRegistry.register({
			icon: Codicon.chip,
			title: localize('chiposWelcome.title', 'ChipOS AI Assistant'),
			content: new MarkdownString(
				localize(
					'chiposWelcome.content',
					'I can help you with EDA design, Verilog/SystemVerilog coding, simulation, and verification.\n\nType a message below to get started, or use `#file:` to reference project files.'
				),
				{ isTrusted: true }
			),
			when: ContextKeyExpr.true()!,
		});
		this._logService.info('[ChipOS] Welcome view registered');
	}
}

// ── R26: Worker Tools 命令 ──────────────────────────────────────────────────

registerAction2(class RefreshWorkerToolsAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.refresh',
			title: localize2('chipos.workerTools.refresh', 'Refresh Worker Tools'),
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', WORKER_TOOLS_VIEW_ID),
				group: 'navigation',
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId(WORKER_TOOLS_VIEW_ID);
		if (view) {
			const treeView = (view as any).treeView;
			if (treeView) {
				treeView.refresh();
			}
		}
	}
});

registerAction2(class InstallWorkerToolAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.installTool',
			title: localize2('chipos.workerTools.installTool', 'Install Tool'),
			icon: Codicon.cloudDownload,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('viewItem', 'chiposWorkerToolInstallable'),
				group: 'inline',
			},
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const toolManager = accessor.get(IWorkerToolManagerService);
		const toolName = arg.$treeItemHandle.replace('worker-tool:', '');
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		await progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title: localize('chipos.workerTools.installing', 'Installing tool "{0}"...', toolName),
				cancellable: false,
			},
			async () => {
				try {
					const result = await toolManager.installTool(toolName);
					if (result.success) {
						notificationService.info(localize('chipos.workerTools.installSuccess', 'Tool "{0}" installed successfully.', toolName));
					} else {
						notificationService.warn(localize('chipos.workerTools.installFail', 'Tool "{0}" installation failed: {1}', toolName, result.error || 'unknown'));
					}
				} catch (err) {
					notificationService.error(localize('chipos.workerTools.installError', 'Failed to install tool "{0}": {1}', toolName, String(err)));
				}
			},
		);
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId(WORKER_TOOLS_VIEW_ID);
		if (view) {
			(view as any).treeView?.refresh();
		}
	}
});

registerAction2(class AddMcpServerAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.addMcpServer',
			title: localize2('chipos.workerTools.addMcpServer', 'Add MCP Server'),
			category: localize2('chipos.category', 'ChipOS'),
			icon: Codicon.add,
			menu: [{
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('viewItem', 'chiposWorkerMcpRoot'),
				group: 'inline',
			}, {
				id: MenuId.CommandPalette,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const toolManager = accessor.get(IWorkerToolManagerService);
		const notificationService = accessor.get(INotificationService);

		const name = await quickInput.input({ title: 'Add MCP Server', placeHolder: 'Server name (e.g. verilator-mcp)', prompt: 'Enter the MCP server name' });
		if (!name) { return; }

		const command = await quickInput.input({ title: 'Add MCP Server', placeHolder: 'Command (e.g. npx)', prompt: 'Enter the command to start the MCP server' });
		if (!command) { return; }

		const argsStr = await quickInput.input({ title: 'Add MCP Server', placeHolder: 'Arguments (space-separated, optional)', prompt: 'Enter command arguments' });
		const args = argsStr ? argsStr.split(/\s+/) : [];

		try {
			const result = await toolManager.addMcpServer({ name, command, args, env: {} });
			if (result.success) {
				notificationService.info(localize('chipos.workerTools.addMcpSuccess', 'MCP server "{0}" added.', name));
			} else {
				notificationService.warn(localize('chipos.workerTools.addMcpFail', 'Failed to add MCP server: {0}', result.error || 'unknown'));
			}
		} catch (err) {
			notificationService.error(localize('chipos.workerTools.addMcpError', 'Error adding MCP server: {0}', String(err)));
		}

		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId(WORKER_TOOLS_VIEW_ID);
		if (view) { (view as any).treeView?.refresh(); }
	}
});

registerAction2(class RemoveMcpServerAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.removeMcpServer',
			title: localize2('chipos.workerTools.removeMcpServer', 'Remove MCP Server'),
			icon: Codicon.trash,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('viewItem', 'chiposWorkerMcpServer'),
				group: 'inline',
			},
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const serverName = arg.$treeItemHandle.replace('worker-mcp:', '');
		const dialogService = accessor.get(IDialogService);
		const toolManager = accessor.get(IWorkerToolManagerService);
		const notificationService = accessor.get(INotificationService);

		const confirmed = await dialogService.confirm({
			message: localize('chipos.workerTools.removeMcpConfirm', 'Remove MCP server "{0}"?', serverName),
		});
		if (!confirmed.confirmed) { return; }

		try {
			const result = await toolManager.removeMcpServer(serverName);
			if (result.success) {
				notificationService.info(localize('chipos.workerTools.removeMcpSuccess', 'MCP server "{0}" removed.', serverName));
			} else {
				notificationService.warn(localize('chipos.workerTools.removeMcpFail', 'Failed to remove: {0}', result.error || 'unknown'));
			}
		} catch (err) {
			notificationService.error(localize('chipos.workerTools.removeMcpError', 'Error removing MCP server: {0}', String(err)));
		}

		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId(WORKER_TOOLS_VIEW_ID);
		if (view) { (view as any).treeView?.refresh(); }
	}
});

registerAction2(class OpenMcpConfigAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.openConfig',
			title: localize2('chipos.workerTools.openConfig', 'Open MCP Config File'),
		});
	}
	async run(accessor: ServicesAccessor, configPath: string): Promise<void> {
		if (!configPath) { return; }
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor({ resource: URI.file(configPath) });
	}
});

registerAction2(class OpenWorkerToolsPanelAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.openPanel',
			title: localize2('chipos.workerTools.openPanel', 'Open Worker Tools Panel'),
			icon: Codicon.tools,
			f1: true,
			category: localize2('chipos.category', 'ChipOS'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(WORKER_TOOLS_VIEW_ID, true);
	}
});

registerWorkbenchContribution2(
	ChipOSContribution.ID,
	ChipOSContribution,
	WorkbenchPhase.AfterRestored
);
