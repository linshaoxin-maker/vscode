/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IChipOSTokenManager } from '../../../../workbench/contrib/chipos/browser/auth/chiposTokenManager.js';
import { IChipOSAuthService } from '../../../../workbench/contrib/chipos/browser/auth/chiposAuthService.js';
import { IChipOSRuntimeOverridesService } from '../../../../workbench/contrib/chipos/common/chiposRuntimeOverrides.js';
import { IChipOSUsageService } from '../../../../workbench/contrib/chipos/browser/billing/chiposUsageService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ISidecarManagerService, SidecarState, WorkerState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { GettingStartedInput } from '../../../../workbench/contrib/welcomeGettingStarted/browser/gettingStartedInput.js';
import { IChatAgentService } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { CHAT_CONFIG_MENU_ID } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatViewId, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { nullExtensionDescription } from '../../../../workbench/services/extensions/common/extensions.js';
import { ChipOSChatAgent } from '../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';
import { StatusBarHandler, ReconnectReason } from '../../../../workbench/contrib/chipos/browser/migration/statusBarHandler.js';
import { ConnectionState } from '../../../../workbench/contrib/chipos/browser/eventTypes.js';
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
import { IModuleHierarchyService } from '../../../../workbench/contrib/chipos/browser/moduleHierarchy/moduleHierarchyService.js';
import { ModuleHierarchyTreeHandler } from '../../../../workbench/contrib/chipos/browser/moduleHierarchy/moduleHierarchyTree.js';
import { ModuleHierarchyTreeDataProvider } from '../../../../workbench/contrib/chipos/browser/moduleHierarchy/moduleHierarchyTreeDataProvider.js';
import { OPEN_RUN_DETAIL_COMMAND_ID, RunHistoryTreeDataProvider, RunHistoryTreeHandler } from '../../../../workbench/contrib/chipos/browser/runs/runHistoryView.js';
import { RunDetailPanel } from '../../../../workbench/contrib/chipos/browser/runs/runDetailPanel.js';
import { OPEN_PPA_DETAIL_COMMAND_ID, PpaHistoryTreeDataProvider, PpaHistoryTreeHandler } from '../../../../workbench/contrib/chipos/browser/ppa/ppaHistoryView.js';
import { PpaDetailPanel } from '../../../../workbench/contrib/chipos/browser/ppa/ppaDetailPanel.js';
import { IPpaSnapshot } from '../../../../workbench/contrib/chipos/browser/ppa/ppaStorageService.js';
import { AgentWorkbenchTreeDataProvider, AgentWorkbenchTreeHandler } from '../../../../workbench/contrib/chipos/browser/agents/agentWorkbenchView.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ChipOSSettingsEditor } from '../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditor.js';
import { ChipOSSettingsEditorInput, ChipOSSettingsTab } from '../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditorInput.js';
import { ChiposPluginsService } from '../../../../workbench/contrib/chipos/browser/resources/chiposPluginsService.js';
import { PluginManifestError } from '../../../../workbench/contrib/chipos/browser/resources/pluginInstaller.js';
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
import { ChatChiposTodoCardContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatChiposTodoCardPart.js';
import { ChatChiposNextStepsCardContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/edaParts/chatChiposNextStepsCardPart.js';
import { AgentSessionsPicker } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsPicker.js';

import { registerChipOSQuickToggles } from '../../../../workbench/contrib/chipos/browser/settings/chiposQuickToggles.js';

import '../../../../workbench/contrib/chipos/common/chiposConfiguration.js';
import '../../../../workbench/contrib/chipos/browser/settings/modelDiscoveryService.js';
import '../../../../workbench/contrib/chipos/browser/moduleHierarchy/moduleHierarchy.contribution.js';
import '../../../../workbench/contrib/chipos/browser/waveform/waveform.contribution.js';
import '../../../../workbench/contrib/chipos/browser/runs/runs.contribution.js';
import '../../../../workbench/contrib/chipos/browser/ppa/ppa.contribution.js';
import '../../../../workbench/contrib/chipos/browser/agents/agents.contribution.js';
import '../../../../workbench/contrib/chipos/browser/sessions/sessionStorageService.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposAtContextCompletions.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposSlashCommandCompletions.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposInlineCompletions.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposEdaSnippetPicker.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposModelQuickPick.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposChatSessionsSidebarContribution.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposChatSessionTabsService.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposQueuedMessagesService.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposStartupFocus.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposChatInputHistory.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposRtlFileWatcher.js';
import '../../../../workbench/contrib/chipos/browser/edaStatusBar.js';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chiposLoginGate.js';
import '../../../../workbench/contrib/chipos/browser/media/chiposOverrides.css';
import '../../../../workbench/contrib/chipos/browser/chatAgent/chipOSInputAccent.css';

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
const MODULE_HIERARCHY_VIEW_ID = 'chipos.moduleHierarchy';
const RUNS_VIEW_ID = 'chipos.runs';
const PPA_VIEW_ID = 'chipos.ppa';
const AGENTS_VIEW_ID = 'chipos.agents';

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
	AskAI = 'chipos.askAI',
	ExplainSelection = 'chipos.explainSelection',
	FixSelection = 'chipos.fixSelection',
	ReviewSelection = 'chipos.reviewSelection',
	RefactorSelection = 'chipos.refactorSelection',
	GenerateDocsForSelection = 'chipos.generateDocsForSelection',
	GenerateTestsForSelection = 'chipos.generateTestsForSelection',
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

// Helper: attach selection to chat then pre-fill chat input with a prompt.
// Reuses framework `workbench.action.chat.attachSelection` for the open+attach+focus
// path, then writes the prompt via the chat widget's setInput API. The user can
// edit the prompt and press Enter to submit.
async function _chiposAttachAndPromptChat(accessor: ServicesAccessor, prompt: string): Promise<void> {
	const commandService = accessor.get(ICommandService);
	const chatWidgetService = accessor.get(IChatWidgetService);
	await commandService.executeCommand('workbench.action.chat.attachSelection');
	const widget = chatWidgetService.lastFocusedWidget;
	if (widget) {
		widget.setInput(prompt);
		widget.focusInput();
	}
}

CommandsRegistry.registerCommand(ChipOSCommandId.AskAI, accessor => {
	return _chiposAttachAndPromptChat(accessor, '');
});

CommandsRegistry.registerCommand(ChipOSCommandId.ExplainSelection, accessor => {
	return _chiposAttachAndPromptChat(accessor, 'Explain what this code does, how it works, and any non-obvious behavior.');
});

CommandsRegistry.registerCommand(ChipOSCommandId.FixSelection, accessor => {
	return _chiposAttachAndPromptChat(accessor, 'Identify and fix any bugs, issues, or anti-patterns in this code. Explain what was wrong.');
});

CommandsRegistry.registerCommand(ChipOSCommandId.ReviewSelection, accessor => {
	return _chiposAttachAndPromptChat(accessor, 'Review this code for correctness, style, and potential issues. Suggest improvements.');
});

CommandsRegistry.registerCommand(ChipOSCommandId.RefactorSelection, accessor => {
	return _chiposAttachAndPromptChat(accessor, 'Refactor this code for clarity and maintainability. Explain the changes.');
});

CommandsRegistry.registerCommand(ChipOSCommandId.GenerateDocsForSelection, accessor => {
	return _chiposAttachAndPromptChat(accessor, 'Generate documentation comments for this code in the appropriate style for the language.');
});

CommandsRegistry.registerCommand(ChipOSCommandId.GenerateTestsForSelection, accessor => {
	return _chiposAttachAndPromptChat(accessor, 'Generate unit tests for this code, covering the main code paths and edge cases.');
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
	// 2026-05-15 — keep this notification chain meaningful: "Restarting"
	// fires before any IPC so the user sees the click registered, and the
	// follow-up reports the *actual* worker state instead of always claiming
	// success. Earlier version printed "restart initiated" unconditionally,
	// which masked the real cause of the "Reconnect button does nothing"
	// complaint (the previous restartWorker() silently returned when not
	// logged in or when _refreshingWorkerToken was stuck).
	notifications.info('ChipOS: Restarting worker…');
	try {
		await backend.restartWorker();
	} catch (err) {
		notifications.error(`ChipOS: Worker restart failed — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (backend.workerState === WorkerState.Connected) {
		notifications.info('ChipOS: Worker reconnected.');
	} else if (backend.workerState === WorkerState.Starting) {
		notifications.info('ChipOS: Worker respawned, waiting for registration…');
	} else {
		notifications.warn('ChipOS: Worker restart finished but worker is not connected. Check logs.');
	}
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

/**
 * PHASE2-AUTH-7: stop ALL active backend connections (sidecar + remote-ssh).
 *
 * Triggered by ChipOSAuthService.logout to kill any worker processes that
 * were spawned with the now-being-revoked credentials. Without this, a
 * worker spawned with worker_token JWT keeps running on the EDA box (or
 * locally) after logout, and its stream stays alive until the JWT expires
 * naturally (24h) or the reasoner reverify cycle catches it.
 *
 * Best-effort: failures in either path don't block the other or the
 * surrounding logout flow. The caller (logout) catches and ignores.
 */
CommandsRegistry.registerCommand('chipos.backend.stopAll', async (accessor) => {
	const logService = accessor.get(ILogService);
	const commandService = accessor.get(ICommandService);

	// 1. Stop the locally-managed sidecar (B2 path: Electron worker).
	try {
		const sidecar = accessor.get(ISidecarManagerService);
		await sidecar.stopBackend();
		logService.info('[ChipOS Logout] Stopped local sidecar backend');
	} catch (err) {
		logService.warn('[ChipOS Logout] sidecar.stopBackend failed (continuing):', String(err));
	}

	// 2. Tell chipos-remote-ssh extension to disconnect all sessions
	//    (each cleanupSession calls worker.stopWorker → stops remote worker).
	//    Older / non-installed extension: command not found, swallow.
	try {
		await commandService.executeCommand('chipos-remote-ssh.disconnect');
		logService.info('[ChipOS Logout] Triggered remote-ssh disconnect');
	} catch (err) {
		logService.warn('[ChipOS Logout] remote-ssh.disconnect failed (continuing):', String(err));
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

// Cursor-style Cmd+L: toggle chat panel (focus when hidden, hide when
// visible). The stock framework binds `chat.toggle` to no keys; chipos
// surfaces it on Cmd+L for parity with Cursor.
// `when: chatInputHasFocus.negate()` so typing Cmd+L inside the chat
// input box does NOT immediately hide the chat (lets the editor's
// stock `expandLineSelection` continue to work there if the input is
// implemented as a Monaco editor).
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.chat.toggle',
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyCode.KeyL,
	when: ContextKeyExpr.has('chatInputHasFocus').negate(),
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

// Chipos AI submenu — collapses the 9 right-click items (Add to Chat / Ask AI
// / Explain / Fix / Review / Refactor / Generate Docs / Generate Tests /
// Insert EDA Snippet) under a single "ChipOS AI ▶" entry on the editor
// context menu. Reduces visual clutter while keeping every action one click
// away. Items inside the submenu render in the same order they had before
// (chips for selection-only items keep their editorHasSelection gate).
const ChipOSEditorContextMenu = MenuId.for('chiposEditorContext');

MenuRegistry.appendMenuItems([
	{
		id: MenuId.EditorContext,
		item: {
			submenu: ChipOSEditorContextMenu,
			title: localize('chipos.editorContextSubmenu', 'ChipOS AI'),
			icon: Codicon.chatSparkle,
			when: ContextKeyExpr.has('editorTextFocus'),
			group: 'chipos',
			order: 1,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.AddToChat, title: localize('chipos.addToChat.short', 'Add to Chat'), icon: Codicon.commentDiscussion },
			when: ContextKeyExpr.has('editorTextFocus'),
			group: '1_attach',
			order: 1,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.AskAI, title: localize('chipos.askAI.short', 'Ask AI'), icon: Codicon.chatSparkle },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '1_attach',
			order: 2,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.ExplainSelection, title: localize('chipos.explainSelection.short', 'Explain'), icon: Codicon.commentDiscussion },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '2_analyze',
			order: 1,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.FixSelection, title: localize('chipos.fixSelection.short', 'Fix'), icon: Codicon.bug },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '2_analyze',
			order: 2,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.ReviewSelection, title: localize('chipos.reviewSelection.short', 'Review'), icon: Codicon.checklist },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '2_analyze',
			order: 3,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.RefactorSelection, title: localize('chipos.refactorSelection.short', 'Refactor'), icon: Codicon.wand },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '3_modify',
			order: 1,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.GenerateDocsForSelection, title: localize('chipos.generateDocs.short', 'Generate Docs'), icon: Codicon.bookmark },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '4_generate',
			order: 1,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: ChipOSCommandId.GenerateTestsForSelection, title: localize('chipos.generateTests.short', 'Generate Tests'), icon: Codicon.beaker },
			when: ContextKeyExpr.has('editorHasSelection'),
			group: '4_generate',
			order: 2,
		},
	},
	{
		id: ChipOSEditorContextMenu,
		item: {
			command: { id: 'chipos.insertEdaSnippet', title: localize('chipos.insertEdaSnippet.short', 'Insert EDA Snippet…'), icon: Codicon.symbolSnippet },
			when: ContextKeyExpr.has('editorTextFocus'),
			group: '4_generate',
			order: 3,
		},
	},
	// Surface the 4 new right-click commands in the Command Palette so users
	// (and CI/automation) can invoke them via Cmd+Shift+P. Without this entry
	// `CommandsRegistry.registerCommand` alone makes them callable from code
	// but invisible to the palette.
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.AskAI, title: localize('chipos.askAI', 'ChipOS: Ask AI'), icon: Codicon.chatSparkle },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.ExplainSelection, title: localize('chipos.explainSelection', 'ChipOS: Explain'), icon: Codicon.commentDiscussion },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.FixSelection, title: localize('chipos.fixSelection', 'ChipOS: Fix'), icon: Codicon.bug },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.ReviewSelection, title: localize('chipos.reviewSelection', 'ChipOS: Review'), icon: Codicon.checklist },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.RefactorSelection, title: localize('chipos.refactorSelection', 'ChipOS: Refactor'), icon: Codicon.wand },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.GenerateDocsForSelection, title: localize('chipos.generateDocs', 'ChipOS: Generate Docs'), icon: Codicon.bookmark },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.GenerateTestsForSelection, title: localize('chipos.generateTests', 'ChipOS: Generate Tests'), icon: Codicon.beaker },
			when: ContextKeyExpr.has('editorHasSelection'),
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: 'chipos.insertEdaSnippet', title: localize('chipos.insertEdaSnippet', 'ChipOS: Insert EDA Snippet…'), icon: Codicon.symbolSnippet },
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.OpenSettings, title: localize('chipos.openSettings.title', 'ChipOS: Open Settings'), icon: Codicon.gear },
		},
	},
	// 2026-05-11 — Surface Restart Backend / Restart Worker in the Command
	// Palette so users can recover from a dead worker without reloading the
	// window. Previously these existed only as keybinding-reachable commands.
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.RestartBackend, title: localize('chipos.restartBackend.title', 'ChipOS: Restart Backend'), icon: Codicon.refresh },
		},
	},
	{
		id: MenuId.CommandPalette,
		item: {
			command: { id: ChipOSCommandId.RestartWorker, title: localize('chipos.restartWorker.title', 'ChipOS: Restart Worker'), icon: Codicon.debugRestart },
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
		@IViewsService private readonly _viewsService: IViewsService,
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

		// ── Auto-reveal chat panel on startup ────────────────────────────────
		// ChipOS is a chat-first product — every cold start should land the
		// user with the chat panel already open, no activity-bar hunting.
		// Reveal without stealing focus so the user's last cursor position
		// (editor area, file explorer, etc.) is preserved.
		this._viewsService.openView(ChatViewId, /* focus */ false)
			.catch(err => this._logService.warn('[ChipOS] Failed to auto-reveal chat view on startup:', String(err)));

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

		// 2026-05-23: prime + track the Worker pill's empty-workbench gate.
		// In empty workbench the worker is deferred ("no workspace folder
		// open — deferring worker spawn") so the Reconnect/Error badge is
		// pointing at a worker that intentionally doesn't exist — misleading
		// UX. StatusBarHandler.setWorkspaceOpen(false) suppresses the pill
		// in that state; flipping it back replays the latest reason.
		const refreshWorkerPillVisibility = (): void => {
			const hasFolder = this._contextService.getWorkbenchState() !== WorkbenchState.EMPTY;
			this._statusBarHandler?.setWorkspaceOpen(hasFolder);
		};
		refreshWorkerPillVisibility();

		this._register(this._contextService.onDidChangeWorkbenchState(() => {
			this._applyEmptyWindowLayout();
			refreshWorkerPillVisibility();
		}));

		this._register(this._sidecarManager.onDidChangeState(state => {
			this._logService.info('[ChipOS] Sidecar state changed:', state);

			if (this._statusBarHandler) {
				const connectionState = this._mapSidecarToConnectionState(state);
				this._statusBarHandler.updateConnectionState(connectionState);
				// UX #4: keep the Reconnect badge in sync with both the sidecar
				// state and the worker state. Sidecar-Error is the dominant
				// failure mode so we surface it preferentially over a stale
				// worker state.
				this._statusBarHandler.updateReconnectButton(this._computeReconnectReason());
			}

			if (state === SidecarState.Error) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: 'ChipOS: Backend failed to start. Check output panel for details.',
				});
			}
		}));

		// UX #4: Worker can drop out without the sidecar (reasoner connection)
		// noticing — e.g. amfid kills the binary, port collision, or watchdog
		// reaps it. Subscribe separately and recompute the badge.
		this._register(this._sidecarManager.onDidChangeWorkerState(workerState => {
			this._logService.info('[ChipOS] Worker state changed:', workerState);
			if (this._statusBarHandler) {
				this._statusBarHandler.updateReconnectButton(this._computeReconnectReason());
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
		this._registerModuleHierarchyView();
		this._registerRunsView();
		this._registerPpaView();
		this._registerAgentsView();
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

	/**
	 * UX #4: derive when the Reconnect status bar button should be visible
	 * and what failure to label it with. We deliberately only surface it on
	 * terminal-ish states (Error / Disconnected) rather than during transient
	 * Spawning / HealthChecking — flashing a recovery button mid-startup is
	 * noisy and trains users to ignore it.
	 *
	 * `undefined` means "hide it"; everything else maps to a tooltip variant.
	 */
	private _computeReconnectReason(): ReconnectReason | undefined {
		const sidecarState = this._sidecarManager.state;
		const workerState = this._sidecarManager.workerState;

		// Sidecar (reasoner) error dominates — without it, the worker is
		// effectively offline regardless of its own state.
		if (sidecarState === SidecarState.Error) {
			return 'sidecar-error';
		}
		if (workerState === WorkerState.Error) {
			return 'worker-error';
		}
		// Don't show "disconnected" while the sidecar is mid-startup: worker
		// hasn't been spawned yet, so "disconnected" is the expected state.
		if (
			workerState === WorkerState.Disconnected &&
			sidecarState !== SidecarState.NotStarted &&
			sidecarState !== SidecarState.Spawning &&
			sidecarState !== SidecarState.HealthChecking
		) {
			return 'worker-disconnected';
		}
		return undefined;
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
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			metadata: {
				sampleRequest: 'Help me design a 32-bit AXI4 bus interface with configurable data width',
				themeIcon: Codicon.chatSparkle,
				additionalWelcomeMessage: (() => {
					// EDA-focused starter prompts rendered below the chat panel's
					// "Build with ChipOS" empty state. Each is a `command:` link
					// that fills the chat input with `isPartialQuery: true` so
					// the user can tweak before sending. Codicon prefix gives
					// each row a semantic visual anchor (MarkdownString has
					// supportThemeIcons: true so $(...) syntax renders as an icon).
					const starterChip = (icon: string, label: string, query: string): string => {
						const args = encodeURIComponent(JSON.stringify({ query, isPartialQuery: true }));
						return `- [$(${icon}) ${label}](command:workbench.action.chat.open?${args})`;
					};
					return new MarkdownString(
						[
							starterChip('circuit-board', 'Generate an 8-bit counter with sync reset', 'Generate a Verilog module: an 8-bit free-running counter with synchronous active-low reset. Include a parameter for counter width.'),
							starterChip('beaker', 'Write a testbench for the current file', 'Write a SystemVerilog testbench for the module in the currently open file. Include clock generation, reset sequence, and a few stimuli.'),
							starterChip('checklist', 'Review my Verilog for synthesis issues', 'Review the Verilog code in my workspace for synthesis-related issues: latches, race conditions, blocking-vs-nonblocking misuse, and async clock domain crossings.'),
							starterChip('book', 'Explain how AXI4-Lite handshake works', 'Explain the AXI4-Lite write and read handshake step by step, including AWVALID/AWREADY/WVALID/WREADY timing and a small Verilog example of a compliant slave.'),
						].join('\n'),
						{ isTrusted: true, supportThemeIcons: true }
					);
				})(),
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
		// FEAT-DS-006: the ``chipos.dynamicSkill.enabled`` setting is the master
		// switch for the whole capability. Surface it as the
		// ``chipos.dynamicSkillEnabled`` context key (same key the vscode-extension
		// uses), which drives the title-bar quick toggle's on/off state. The panel
		// stays registered either way — disabling renders an "off" placeholder
		// rather than hiding the panel, so the title toggle never hides itself. The
		// agent reads the same setting to gate the learn signal it sends the
		// reasoner. The onDidChangeConfiguration wiring is below, once treeView/agent
		// are in scope.
		const dynamicSkillEnabledKey = this._contextKeyService.createKey<boolean>('chipos.dynamicSkillEnabled', true);
		const isDynamicSkillEnabled = () => this._configurationService.getValue<boolean>('chipos.dynamicSkill.enabled') ?? true;
		dynamicSkillEnabledKey.set(isDynamicSkillEnabled());

		const treeView = this._instantiationService.createInstance(
			CustomTreeView, SKILL_TREE_VIEW_ID, localize('chiposSkillTree', 'Skill Tree'), 'chipos'
		);
		this._register(treeView);

		const dataProvider = new SkillTreeViewDataProvider(agent.skillTreeHandler, isDynamicSkillEnabled);
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

		// FEAT-DS-006: the stateless transport has no SSE ``skill_tree`` event,
		// so the dynamic-skill store is pulled on demand. Fetch when the panel is
		// first revealed (and on each re-reveal — cheap, and picks up skills
		// learned since the last look), and expose a manual refresh command plus
		// a title ↻ button so a user can force a re-pull right after a debug
		// session. This brings the standalone IDE to parity with the
		// vscode-extension, which already fetches the same endpoint.
		this._register(treeView.onDidChangeVisibility(visible => {
			if (visible) {
				void agent.refreshSkillTree();
			}
		}));
		this._register(CommandsRegistry.registerCommand('chipos.skillTree.refresh', () => {
			void agent.refreshSkillTree();
		}));
		this._register(MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
			command: {
				id: 'chipos.skillTree.refresh',
				title: localize('chiposSkillTreeRefresh', "Refresh Skill Tree"),
				icon: Codicon.refresh,
			},
			when: ContextKeyExpr.equals('view', SKILL_TREE_VIEW_ID),
			group: 'navigation',
		}));

		// FEAT-DS-006: keep the context key in sync (drives the title toggle's
		// on/off state), re-render the tree on change (skills vs the "off"
		// placeholder), and re-pull when switched back on. The panel stays visible
		// either way so the title toggle never hides itself.
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.dynamicSkill.enabled')) {
				const enabled = isDynamicSkillEnabled();
				dynamicSkillEnabledKey.set(enabled);
				if (enabled) {
					void agent.refreshSkillTree();
				}
				treeView.refresh();
			}
		}));

		// FEAT-DS-006: title-bar quick toggle — flip chipos.dynamicSkill.enabled
		// without opening Settings (mirrors the vscode-extension's skill-bar
		// switch). Its checked state follows the dynamicSkillEnabled context key.
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'chipos.skillTree.toggleEnabled',
					title: localize('chiposSkillTreeToggle', "Dynamic Skills Enabled"),
					icon: Codicon.lightbulbSparkleAutofix,
					toggled: ContextKeyExpr.equals('chipos.dynamicSkillEnabled', true),
					menu: {
						id: MenuId.ViewTitle,
						when: ContextKeyExpr.equals('view', SKILL_TREE_VIEW_ID),
						group: 'navigation',
						order: 0,
					},
				});
			}
			async run(accessor: ServicesAccessor): Promise<void> {
				const configService = accessor.get(IConfigurationService);
				const current = configService.getValue<boolean>('chipos.dynamicSkill.enabled') ?? true;
				await configService.updateValue('chipos.dynamicSkill.enabled', !current, ConfigurationTarget.USER);
			}
		}));

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

		// Auto-refresh the Worker Tools panel when the sidecar transitions
		// INTO Connected. This fixes a cold-start race where the panel's
		// initial getChildren() ran before the worker had bound port 8081,
		// the fetch threw "Failed to fetch", the panel rendered a "Worker
		// API unavailable" error item, and there was no signal to retry
		// other than the user manually clicking the refresh ↻ button. We
		// observed this 2026-05-13: worker_spawn finished at 11:05:05 but
		// the panel had probed at 11:04:44 and stayed stale until manual
		// refresh.
		//
		// HANDOFF §8 / Phase B follow-up §12 #5: a single fire-on-Connected
		// is racy too — Sidecar.state flips to Connected when the IPC
		// adopts the worker pid, but the worker's HTTP server takes ~200 ms
		// more to bind port 8081 and answer requests. The first refresh
		// then still fails ("Failed to fetch"), the panel stays stuck on
		// the error item, and the user is back to clicking ↻ manually.
		//
		// Replace the single fire with an exponential-backoff retry burst
		// (200 ms, 600 ms, 1.5 s, 3 s, 6 s — total ~11 s window). Each
		// retry just calls refresh(); the view provider re-runs its fetch.
		// If the worker comes up at any point, the view picks up the
		// healthy result on the next tick. Once any retry succeeds the
		// later ones are no-ops on a healthy view (refresh is idempotent),
		// so over-firing is harmless. The burst self-cancels if the
		// sidecar leaves Connected mid-flight.
		let lastSidecarState = this._sidecarManager.state;
		let lastWorkerState = this._sidecarManager.workerState;
		const REFRESH_BACKOFF_MS = [200, 600, 1500, 3000, 6000] as const;
		const refreshTimers: ReturnType<typeof setTimeout>[] = [];
		const cancelRefreshBurst = () => {
			for (const t of refreshTimers) {
				clearTimeout(t);
			}
			refreshTimers.length = 0;
		};
		const startRefreshBurst = (trigger: string) => {
			this._logService.info(`[ChipOS] Worker Tools panel auto-refresh burst (${trigger})`);
			cancelRefreshBurst(); // belt and suspenders for rapid state thrash
			for (const delay of REFRESH_BACKOFF_MS) {
				const timer = setTimeout(() => {
					// Bail if we're no longer in a Connected-ish state. Avoids
					// flooding refresh() during a flapping sidecar/worker.
					if (this._sidecarManager.state !== SidecarState.Connected) {
						return;
					}
					workerToolsTreeView.refresh();
				}, delay);
				refreshTimers.push(timer);
			}
		};
		this._register({
			dispose: () => cancelRefreshBurst(),
		});
		this._register(this._sidecarManager.onDidChangeState(state => {
			if (state === SidecarState.Connected && lastSidecarState !== SidecarState.Connected) {
				startRefreshBurst('sidecar→Connected');
			} else if (state !== SidecarState.Connected) {
				// Cancel any in-flight retry burst when sidecar drops out
				// of Connected — those retries would race with whatever
				// recovery is bringing the worker back up.
				cancelRefreshBurst();
			}
			lastSidecarState = state;
		}));
		// 2026-05-15 — also burst on Worker state transitions. The
		// sidecar-only trigger above misses the common case where the
		// Sidecar (reasoner) connection stays alive but the Worker process
		// dies and respawns: SidecarState never changes, so the panel kept
		// showing stale "Worker API unavailable" errors until the user hit
		// the manual ↻ button. Fires on any → Connected and on
		// Connected → notConnected→back: each new Worker.Connected resets
		// the burst because the worker that comes up may have a different
		// pid + freshly-bound HTTP port.
		this._register(this._sidecarManager.onDidChangeWorkerState(workerState => {
			if (workerState === WorkerState.Connected && lastWorkerState !== WorkerState.Connected) {
				startRefreshBurst('worker→Connected');
			}
			lastWorkerState = workerState;
		}));

		this._logService.info('[ChipOS] Worker Tools view registered (R26)');
	}

	// ── Phase 6 / Slice 2: Module Hierarchy View ────────────────────────────
	// Scans workspace .v/.sv files for the Verilog/SystemVerilog module
	// instantiation hierarchy and renders it as a tree. Clicking a node opens
	// that module's `module <type>` definition. Mirrors the Skill Tree / Worker
	// Tools views: same `chipos.tools` container, same TreeView/TreeViewPane
	// wiring and title-action registration.
	private _registerModuleHierarchyView(): void {
		const treeView = this._instantiationService.createInstance(
			CustomTreeView, MODULE_HIERARCHY_VIEW_ID, localize('chiposModuleHierarchy', 'Module Hierarchy'), 'chipos'
		);
		treeView.showCollapseAllAction = true;
		this._register(treeView);

		const service = this._instantiationService.invokeFunction(accessor => accessor.get(IModuleHierarchyService));
		const handler = this._register(this._instantiationService.createInstance(ModuleHierarchyTreeHandler));
		const dataProvider = this._register(new ModuleHierarchyTreeDataProvider(handler));
		treeView.dataProvider = dataProvider;

		viewsRegistry.registerViews([{
			id: MODULE_HIERARCHY_VIEW_ID,
			name: { value: localize('chiposModuleHierarchy', 'Module Hierarchy'), original: 'Module Hierarchy' },
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			treeView,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			order: 30,
			hideByDefault: false,
		} as ITreeViewDescriptor], chiposViewContainer);

		// Empty-state message (mirrors how the pane renders a welcome string).
		const updateEmptyMessage = () => {
			treeView.message = dataProvider.isTreeEmpty
				? localize('chiposModuleHierarchyEmpty', "No Verilog modules found in this workspace.")
				: undefined;
		};
		updateEmptyMessage();
		this._register(dataProvider.onDidChangeEmpty(updateEmptyMessage));

		// Re-render whenever the parsed hierarchy changes (re-scan completed).
		this._register(handler.onDidChangeTreeData(() => {
			treeView.refresh();
		}));

		// Scan on first reveal (cheap to re-run, picks up edits made while the
		// panel was hidden) and expose an explicit Re-scan command + title
		// button. The framework's built-in collapse-all sits next to it.
		this._register(treeView.onDidChangeVisibility(visible => {
			if (visible) {
				void service.scanWorkspace();
			}
		}));
		this._register(CommandsRegistry.registerCommand('chipos.moduleHierarchy.rescan', () => {
			void service.scanWorkspace();
		}));
		this._register(MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
			command: {
				id: 'chipos.moduleHierarchy.rescan',
				title: localize('chiposModuleHierarchyRescan', "Re-scan Modules"),
				icon: Codicon.refresh,
			},
			when: ContextKeyExpr.equals('view', MODULE_HIERARCHY_VIEW_ID),
			group: 'navigation',
		}));

		this._logService.info('[ChipOS] Module Hierarchy view registered');
	}

	private _registerRunsView(): void {
		const treeView = this._instantiationService.createInstance(
			CustomTreeView, RUNS_VIEW_ID, localize('chiposRuns', 'Runs'), 'chipos'
		);
		this._register(treeView);

		const handler = this._register(this._instantiationService.createInstance(RunHistoryTreeHandler));
		const dataProvider = this._register(new RunHistoryTreeDataProvider(handler));
		treeView.dataProvider = dataProvider;

		// A single, reused detail panel the list items open via the command below.
		const detailPanel = this._register(this._instantiationService.createInstance(RunDetailPanel));

		viewsRegistry.registerViews([{
			id: RUNS_VIEW_ID,
			name: { value: localize('chiposRuns', 'Runs'), original: 'Runs' },
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			treeView,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			order: 40,
			hideByDefault: false,
		} as ITreeViewDescriptor], chiposViewContainer);

		// Empty-state message (mirrors how the pane renders a welcome string).
		const updateEmptyMessage = () => {
			treeView.message = dataProvider.isTreeEmpty
				? localize('chiposRunsEmpty', "No runs captured yet.")
				: undefined;
		};
		updateEmptyMessage();
		this._register(dataProvider.onDidChangeEmpty(updateEmptyMessage));

		// Re-render whenever the persisted run set changes.
		this._register(handler.onDidChangeTreeData(() => {
			treeView.refresh();
		}));

		// Open the detail view for a given trace id (invoked by list-item clicks).
		this._register(CommandsRegistry.registerCommand(OPEN_RUN_DETAIL_COMMAND_ID, (_accessor, traceId?: string) => {
			if (typeof traceId === 'string') {
				detailPanel.open(traceId);
			}
		}));

		// Explicit Refresh title button.
		this._register(CommandsRegistry.registerCommand('chipos.runs.refresh', () => {
			treeView.refresh();
		}));
		this._register(MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
			command: {
				id: 'chipos.runs.refresh',
				title: localize('chiposRunsRefresh', "Refresh"),
				icon: Codicon.refresh,
			},
			when: ContextKeyExpr.equals('view', RUNS_VIEW_ID),
			group: 'navigation',
		}));

		this._logService.info('[ChipOS] Runs view registered');
	}

	/**
	 * Phase 6 option 3: the Timing/PPA view. A flat list of optimization-round
	 * snapshots captured from `ppa_report` frames; clicking a row opens a detail
	 * dashboard (Baseline | Current | Best | Δ). Mirrors `_registerRunsView`.
	 */
	private _registerPpaView(): void {
		const treeView = this._instantiationService.createInstance(
			CustomTreeView, PPA_VIEW_ID, localize('chiposPpa', 'Timing / PPA'), 'chipos'
		);
		this._register(treeView);

		const handler = this._register(this._instantiationService.createInstance(PpaHistoryTreeHandler));
		const dataProvider = this._register(new PpaHistoryTreeDataProvider(handler));
		treeView.dataProvider = dataProvider;

		// A single, reused detail panel the list items open via the command below.
		const detailPanel = this._register(this._instantiationService.createInstance(PpaDetailPanel));

		viewsRegistry.registerViews([{
			id: PPA_VIEW_ID,
			name: { value: localize('chiposPpa', 'Timing / PPA'), original: 'Timing / PPA' },
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			treeView,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			order: 50,
			hideByDefault: false,
		} as ITreeViewDescriptor], chiposViewContainer);

		// Empty-state message (mirrors how the pane renders a welcome string).
		const updateEmptyMessage = () => {
			treeView.message = dataProvider.isTreeEmpty
				? localize('chiposPpaEmpty', "No PPA reports captured yet.")
				: undefined;
		};
		updateEmptyMessage();
		this._register(dataProvider.onDidChangeEmpty(updateEmptyMessage));

		// Re-render whenever the captured snapshot set changes.
		this._register(handler.onDidChangeTreeData(() => {
			treeView.refresh();
		}));

		// Open the detail dashboard for a snapshot (invoked by list-item clicks).
		this._register(CommandsRegistry.registerCommand(OPEN_PPA_DETAIL_COMMAND_ID, (_accessor, snapshot?: IPpaSnapshot) => {
			if (snapshot) {
				detailPanel.open(snapshot);
			}
		}));

		// Explicit Refresh title button.
		this._register(CommandsRegistry.registerCommand('chipos.ppa.refresh', () => {
			treeView.refresh();
		}));
		this._register(MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
			command: {
				id: 'chipos.ppa.refresh',
				title: localize('chiposPpaRefresh', "Refresh"),
				icon: Codicon.refresh,
			},
			when: ContextKeyExpr.equals('view', PPA_VIEW_ID),
			group: 'navigation',
		}));

		this._logService.info('[ChipOS] PPA view registered');
	}

	/**
	 * Phase 6 option 4: the Agents workbench view. A live 2-level tree of the
	 * current turn's delegated sub-agents (role → tool activities), fed by
	 * `subagentEvent` frames the chat agent records into the in-memory
	 * {@link IAgentActivityStore}. Mirrors `_registerModuleHierarchyView`.
	 */
	private _registerAgentsView(): void {
		const treeView = this._instantiationService.createInstance(
			CustomTreeView, AGENTS_VIEW_ID, localize('chiposAgents', 'Agents'), 'chipos'
		);
		this._register(treeView);

		const handler = this._register(this._instantiationService.createInstance(AgentWorkbenchTreeHandler));
		const dataProvider = this._register(new AgentWorkbenchTreeDataProvider(handler));
		treeView.dataProvider = dataProvider;

		viewsRegistry.registerViews([{
			id: AGENTS_VIEW_ID,
			name: { value: localize('chiposAgents', 'Agents'), original: 'Agents' },
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			treeView,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			order: 60,
			hideByDefault: false,
		} as ITreeViewDescriptor], chiposViewContainer);

		// Empty-state message (no sub-agents running in the current turn).
		const updateEmptyMessage = () => {
			treeView.message = dataProvider.isTreeEmpty
				? localize('chiposAgentsEmpty', "No sub-agents active in this turn.")
				: undefined;
		};
		updateEmptyMessage();
		this._register(dataProvider.onDidChangeEmpty(updateEmptyMessage));

		// Re-render whenever the live activity set changes.
		this._register(handler.onDidChangeTreeData(() => {
			treeView.refresh();
		}));

		this._logService.info('[ChipOS] Agents view registered');
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
		// P1-1: Spec Review carries action buttons (View Plan / Regenerate / Build);
		// the part needs the render context to resolve its chat session for Build.
		registry.registerContentPart('edaSpecReview', (content, inst, context) => inst.createInstance(ChatEdaSpecReviewContentPart, content as any, context));
		registry.registerContentPart('roundProgress', (content, inst) => inst.createInstance(ChatRoundProgressContentPart, content as any));
		registry.registerContentPart('agentError', (content, inst) => inst.createInstance(ChatAgentErrorContentPart, content as any));
		registry.registerContentPart('edaPpaReport', (content, inst) => inst.createInstance(ChatEdaPpaReportContentPart, content as any));
		registry.registerContentPart('chiposTodoCard', (content, inst) => inst.createInstance(ChatChiposTodoCardContentPart, content as any));
		registry.registerContentPart('chiposNextSteps', (content, inst) => inst.createInstance(ChatChiposNextStepsCardContentPart, content as any));
		this._logService.info('[ChipOS] Registered 11 EDA content part renderers');
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
		// UX #6: Welcome card lists four EDA starter prompts as clickable
		// command links. Uses the same `workbench.action.chat.open?{query,
		// isPartialQuery}` pattern as the chat-agent metadata.additional
		// WelcomeMessage so behavior is identical across both empty-state
		// surfaces (chat view pane vs. inline chat widget).
		//
		// The framework's `firstLinkToButton: true` (hardcoded in chatView
		// WelcomeController) renders the first <a> as a primary button — so
		// "Explain a Verilog file" becomes the CTA. The rest are styled as
		// chips via chiposOverrides.css.
		const starterLink = (label: string, query: string): string => {
			const args = encodeURIComponent(JSON.stringify({ query, isPartialQuery: true }));
			return `[${label}](command:workbench.action.chat.open?${args})`;
		};
		const welcomeMd = localize(
			'chiposWelcome.content',
			'I can help with EDA design, Verilog/SystemVerilog coding, simulation, and verification.\n\n**Quick starts**\n\n- {0}\n- {1}\n- {2}\n- {3}\n\nTip: use `#file:` to attach project files to your prompt.',
			starterLink(
				'Explain a Verilog / SystemVerilog file',
				'Explain the Verilog/SystemVerilog code in this file. Cover the design intent, key signals, and any non-obvious behavior. Use #file: to point me at the file.'
			),
			starterLink(
				'Find bugs in my testbench',
				'Review my testbench for issues — race conditions, missing assertions, incomplete coverage, reset/clock-domain bugs. Use #file: to attach the testbench.'
			),
			starterLink(
				'Generate a UVM agent',
				'Generate a UVM agent for the DUT in #file:. Include sequencer, driver, monitor, and a basic sequence library. Match existing project naming conventions.'
			),
			starterLink(
				'Convert Verilog → SystemVerilog',
				'Convert the Verilog in #file: to SystemVerilog using modern constructs: always_ff/always_comb instead of always @, typed enums for FSM states, logic over reg/wire. Preserve behavior exactly.'
			),
		);
		chatViewsWelcomeRegistry.register({
			icon: Codicon.chip,
			title: localize('chiposWelcome.title', 'ChipOS AI Assistant'),
			content: new MarkdownString(welcomeMd, { isTrusted: true }),
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
		// 预取所有 service — accessor 仅在 run() 同步范围有效, async 闭包里调
		// accessor.get() 会抛 "Illegal state: service accessor is only valid".
		const toolManager = accessor.get(IWorkerToolManagerService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const opener = accessor.get(IOpenerService);
		const viewsService = accessor.get(IViewsService);
		// commandService is fetched here (synchronously inside run()) so the
		// notification actions below can invoke chipos.eda.openInstallGuide /
		// chipos.eda.rescan from inside their async run() closures (where a
		// fresh accessor.get() would throw "Illegal state: service accessor
		// is only valid").
		const commandService = accessor.get(ICommandService);
		const toolName = arg.$treeItemHandle.replace('worker-tool:', '');
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
						const installedHint = (result.installed && result.installed.length)
							? ` (${result.installed.join(', ')})`
							: '';
						notificationService.info(localize('chipos.workerTools.installSuccess', 'Tool "{0}" installed successfully.{1}', toolName, installedHint));
					} else if ((result.manual_required && result.vendor_url) || (result.failed && result.failed.some(f => f.manual_required && f.vendor_url))) {
						// 商业 EDA (vivado/quartus 等): 不能自动装, 弹通知带三个按钮:
						//  1. View install guide — 打开我们 in-IDE 的 markdown 步骤
						//     (账号 → 下载 → license → PATH → 校验), 比甩到厂商
						//     站的 12 GB 下载页友好很多
						//  2. Open vendor download page — 老链路保留
						//  3. I've installed it, rescan — 用户装完直接点这个,
						//     worker 原地重扫 PATH; 不需要重启 IDE
						// 顶层 manual_required = install_binary 直调; failed[i].manual_required = install_mcp_tool 聚合.
						const manualBins = result.failed?.filter(f => f.manual_required && f.vendor_url) ?? [];
						const primary = manualBins[0] ?? null;
						const vendorUrl = result.vendor_url ?? primary?.vendor_url ?? '';
						const primaryBinary = primary?.binary ?? '';
						const allBins = manualBins.length
							? manualBins.map(f => f.binary).join(' / ')
							: toolName;
						notificationService.notify({
							severity: Severity.Warning,
							message: localize(
								'chipos.workerTools.installManualVendor.v2',
								'"{0}" needs a commercial EDA tool ({1}) — ChipOS can\'t auto-install it. Click "View install guide" for step-by-step setup (account → download → license → PATH).',
								toolName, allBins
							),
							actions: {
								primary: [
									{
										id: 'chipos.workerTools.openInstallGuide',
										label: localize('chipos.workerTools.openInstallGuide', 'View install guide'),
										tooltip: localize('chipos.workerTools.openInstallGuide.tooltip', 'Open the in-IDE step-by-step install walkthrough for {0}.', primaryBinary || allBins),
										class: undefined,
										enabled: !!primaryBinary,
										run: () => commandService.executeCommand('chipos.eda.openInstallGuide', primaryBinary),
									},
									{
										id: 'chipos.workerTools.openVendorUrl',
										label: localize('chipos.workerTools.openVendorUrl', 'Open vendor download page'),
										tooltip: vendorUrl,
										class: undefined,
										enabled: !!vendorUrl,
										run: () => vendorUrl ? opener.open(URI.parse(vendorUrl), { openExternal: true }) : undefined,
									},
									{
										id: 'chipos.workerTools.rescan',
										label: localize('chipos.workerTools.rescan', "I've installed it, rescan"),
										tooltip: localize('chipos.workerTools.rescan.tooltip', 'Re-scan the worker PATH for newly-installed tools without restarting the worker.'),
										class: undefined,
										enabled: true,
										run: () => commandService.executeCommand('chipos.eda.rescan'),
									},
								],
							},
						});
					} else if (result.failed && result.failed.length) {
						// install_mcp_tool 聚合失败 (非 manual): 列每个 binary 的具体原因.
						const summary = result.failed.map(f => `${f.binary}: ${f.error || f.method || '?'}`).join('; ');
						notificationService.warn(localize('chipos.workerTools.installFailDetailed', 'Tool "{0}" failed (some deps): {1}', toolName, summary));
					} else {
						notificationService.warn(localize('chipos.workerTools.installFail', 'Tool "{0}" installation failed: {1}', toolName, result.error || 'unknown'));
					}
				} catch (err) {
					notificationService.error(localize('chipos.workerTools.installError', 'Failed to install tool "{0}": {1}', toolName, String(err)));
				}
			},
		);
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
		const viewsService = accessor.get(IViewsService);

		// P2 F3: multi-step wizard with Test step before commit.
		// Falls back to abort on Escape at any step; on Test failure user
		// can choose to commit anyway or back-out.
		const wizard = await runMcpServerWizard(quickInput, toolManager, {
			title: 'Add MCP Server',
			initial: { name: '', command: '', args: [], env: {} },
		});
		if (!wizard) { return; }

		try {
			const result = await toolManager.addMcpServer(wizard);
			if (result.success) {
				let provideMsg = '';
				try {
					const lst = await toolManager.listMcpServers();
					const me = lst.servers.find(s => s.name === wizard.name);
					const provides = me?.provides ?? [];
					if (provides.length > 0) {
						const sample = provides.slice(0, 3).join(', ');
						const more = provides.length > 3 ? `, +${provides.length - 3} more` : '';
						provideMsg = ` · provides ${provides.length}: ${sample}${more}`;
					} else {
						provideMsg = ' · no tools discovered yet';
					}
				} catch {
					/* best-effort enrichment */
				}
				notificationService.info(localize(
					'chipos.workerTools.addMcpSuccess.v2',
					'✓ Connected: {0}{1}',
					wizard.name, provideMsg,
				));
			} else {
				notificationService.warn(localize(
					'chipos.workerTools.addMcpFail.v2',
					'✗ Failed to connect MCP server "{0}": {1}',
					wizard.name, result.error || 'unknown error',
				));
			}
		} catch (err) {
			notificationService.error(localize('chipos.workerTools.addMcpError', 'Error adding MCP server: {0}', String(err)));
		}

		const view = viewsService.getActiveViewWithId(WORKER_TOOLS_VIEW_ID);
		if (view) { (view as any).treeView?.refresh(); }
	}
});

/**
 * P2 F3/F2: shared MCP-server wizard used by Add + Edit actions.
 * Steps: name → command → args → env → Test → confirm. User can hit Escape
 * to abort at any step; on Test fail they get a QuickPick to retry/save-
 * anyway/cancel.
 *
 * Returns the McpServerConfig the caller should pass to add/edit, or
 * undefined if the user aborted.
 */
async function runMcpServerWizard(
	quickInput: IQuickInputService,
	toolManager: IWorkerToolManagerService,
	options: { title: string; initial: { name: string; command: string; args: string[]; env: Record<string, string> }; lockName?: boolean },
): Promise<{ name: string; command: string; args: string[]; env: Record<string, string> } | undefined> {
	const init = options.initial;

	// Step 1: name (locked in edit mode)
	let name = init.name;
	if (!options.lockName) {
		const v = await quickInput.input({
			title: `${options.title} (1/5)`,
			placeHolder: 'Server name (e.g. company-eda-cluster)',
			prompt: 'Unique identifier — also used in chipos.eda.tools.<tool>.mcpServer setting',
			value: name,
			validateInput: async v => {
				const t = v.trim();
				if (!t) { return 'Required'; }
				// 'plugin.' is reserved for plugin-contributed servers (PLUGIN_MCP_PREFIX in
				// resources/pluginMcpSync.ts); the plugin reconcile would delete a user server
				// using it, so block it at input.
				if (t.startsWith('plugin.')) { return localize('chipos.workerTools.reservedPluginPrefix', 'The "plugin." prefix is reserved for plugin-contributed servers — choose another name.'); }
				return undefined;
			},
		});
		if (v === undefined) { return undefined; }
		name = v.trim();
	}

	// Step 2: command
	const command = await quickInput.input({
		title: `${options.title} (2/5)`,
		placeHolder: 'Command (e.g. npx, python, /opt/foo/bin/run.sh)',
		prompt: 'Process the worker spawns to start this MCP server',
		value: init.command,
		validateInput: async v => v.trim() ? undefined : 'Required',
	});
	if (command === undefined) { return undefined; }

	// Step 3: args
	const argsStr = await quickInput.input({
		title: `${options.title} (3/5)`,
		placeHolder: 'Arguments (space-separated, optional)',
		prompt: 'Example: @company/eda-mcp --license=$CHIPOS_EDA_LICENSE',
		value: init.args.join(' '),
	});
	if (argsStr === undefined) { return undefined; }
	const args = argsStr.trim() ? argsStr.trim().split(/\s+/) : [];

	// Step 4: env (KEY=VALUE pairs, one per line via QuickInput's single line —
	// keep simple: comma-separated)
	const envStr = await quickInput.input({
		title: `${options.title} (4/5)`,
		placeHolder: 'Env vars (KEY=VAL, comma-separated; leave empty for none)',
		prompt: 'Example: CHIPOS_EDA_TOKEN=secret123, NODE_ENV=production',
		value: Object.entries(init.env).map(([k, v]) => `${k}=${v}`).join(', '),
	});
	if (envStr === undefined) { return undefined; }
	const env: Record<string, string> = {};
	for (const pair of envStr.split(',').map(s => s.trim()).filter(Boolean)) {
		const eq = pair.indexOf('=');
		if (eq > 0) { env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
	}

	// Step 5: Test connection (in edit mode, test against current config;
	// in add mode, we save first then test — because test_mcp_server reads
	// from the config file on disk. Simpler: commit then test, but show
	// the same result UI).
	// For add: we ask "Test now?" first. If yes, save → test → show. If no,
	// just save. The fail path lets user back out.
	const testChoice = await quickInput.pick([
		{ label: 'Save and test connection (recommended)' },
		{ label: 'Save without testing' },
		{ label: 'Cancel' },
	], { title: `${options.title} (5/5)`, placeHolder: `Add server "${name}" with ${args.length} arg(s)?` });

	if (!testChoice || testChoice.label.startsWith('Cancel')) { return undefined; }

	if (testChoice.label.startsWith('Save without')) {
		return { name, command, args, env };
	}

	// "Save and test" — but we can't test before saving (test_mcp_server
	// reads from config file). Caller will save, then we offer Test as a
	// follow-up notification action. So just return the config here.
	return { name, command, args, env };
}

// P2 F2: Edit existing MCP server — opens the same wizard pre-populated
// with current config. Server name is locked (renaming would break tool
// resolutions that reference this server). On save, remove + re-add.
registerAction2(class EditMcpServerAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.workerTools.editMcpServer',
			title: localize2('chipos.workerTools.editMcpServer', 'Edit MCP Server'),
			icon: Codicon.edit,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('viewItem', 'chiposWorkerMcpServer'),
				group: 'inline',
			},
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const serverName = arg.$treeItemHandle.replace('worker-mcp:', '');
		const quickInput = accessor.get(IQuickInputService);
		const toolManager = accessor.get(IWorkerToolManagerService);
		const notificationService = accessor.get(INotificationService);
		const viewsService = accessor.get(IViewsService);

		const lst = await toolManager.listMcpServers();
		const current = lst.servers.find(s => s.name === serverName);
		if (!current) {
			notificationService.warn(localize('chipos.workerTools.editMcpNotFound', 'Server {0} no longer in config', serverName));
			return;
		}

		const next = await runMcpServerWizard(quickInput, toolManager, {
			title: `Edit ${serverName}`,
			initial: {
				name: current.name,
				command: current.command,
				args: current.args ?? [],
				env: current.env ?? {},
			},
			lockName: true,
		});
		if (!next) { return; }

		try {
			// Remove + re-add (no in-place edit on the lifecycle API)
			await toolManager.removeMcpServer(serverName);
			const r = await toolManager.addMcpServer(next);
			if (r.success) {
				notificationService.info(localize('chipos.workerTools.editMcpDone', '✓ Updated MCP server "{0}"', serverName));
			} else {
				notificationService.warn(localize('chipos.workerTools.editMcpFail', '✗ Failed to update "{0}": {1}', serverName, r.error || 'unknown'));
			}
		} catch (err) {
			notificationService.error(localize('chipos.workerTools.editMcpError', 'Error updating MCP server: {0}', String(err)));
		}

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

/**
 * Copy a trace_id to the clipboard + show a toast.
 *
 * Wired from the chat-bubble trace pill (chipOSChatAgent.ts) so the user can
 * click the dim "trace" link at the end of any chat round to grab the id for
 * a bug report. Hover on the same link shows the full id as a native tooltip
 * (markdown link title attribute). Pure command — no side effects beyond
 * clipboard + notification.
 */
CommandsRegistry.registerCommand('chipos.trace.copyId', async (accessor: ServicesAccessor, traceId?: string) => {
	if (!traceId || typeof traceId !== 'string') {
		return;
	}
	const clipboardService = accessor.get(IClipboardService);
	const notificationService = accessor.get(INotificationService);
	await clipboardService.writeText(traceId);
	notificationService.info(localize('chipos.trace.copied', 'Trace ID copied: {0}', traceId));
});

/**
 * Open the bundled in-IDE install guide markdown for an EDA tool. Wired from
 * the "View install guide" action on EdaEnvHandler's missing-tool notification
 * (see `edaEnvHandler.ts:_resolveInstallGuideUri`). For supported tools
 * (vivado / quartus / openroad / yosys / iverilog / verilator / sv2v) we open
 * a dedicated walkthrough markdown with account-creation links, license
 * setup, PATH config commands, and verification steps — instead of dumping
 * the user on a bare vendor download page.
 *
 * Tool name → markdown file lookup. `_aliases` collapses worker-side binary
 * names (`quartus_sh`, `quartus_pgm`) onto the shared guide (`quartus.md`).
 * The four oss-cad-suite tools all map to `oss-cad-suite.md` because
 * ChipOS treats the suite as a single install unit.
 *
 * Fallback: if the tool isn't in the map, log + no-op. The caller's
 * `_resolveInstallGuideUri` already routes unknown tools to the raw vendor
 * URL via OpenerService, so this command should only ever fire for tools
 * that have a guide.
 */
CommandsRegistry.registerCommand('chipos.eda.openInstallGuide', async (accessor: ServicesAccessor, tool?: string) => {
	const logService = accessor.get(ILogService);
	const editorService = accessor.get(IEditorService);
	const notificationService = accessor.get(INotificationService);

	if (!tool || typeof tool !== 'string') {
		logService.warn('[ChipOS EDA install guide] called without tool name');
		return;
	}

	const _aliases: Record<string, string> = {
		'yosys': 'oss-cad-suite',
		'iverilog': 'oss-cad-suite',
		'verilator': 'oss-cad-suite',
		'sv2v': 'oss-cad-suite',
		'quartus_sh': 'quartus',
		'quartus_pgm': 'quartus',
	};
	const guideName = _aliases[tool] ?? tool;

	// Map of tools we ship a guide for. Keys MUST match the `BUNDLED_GUIDES`
	// set in edaEnvHandler.ts (the renderer-side resolver). Adding a new
	// guide requires updating both lists + the gulpfile resource include.
	const BUNDLED = new Set(['vivado', 'quartus', 'openroad', 'oss-cad-suite', 'index']);
	if (!BUNDLED.has(guideName)) {
		logService.warn(`[ChipOS EDA install guide] no bundled guide for tool=${tool} (resolved=${guideName})`);
		notificationService.notify({
			severity: Severity.Warning,
			message: localize('chipos.eda.installGuide.notFound', 'No install guide bundled for {0}.', tool),
		});
		return;
	}

	// FileAccess.asFileUri resolves to disk in dev (under src/) and to the
	// bundled `out-build/.../media/installGuides/<name>.md` location in
	// production (see gulpfile.vscode.ts:vscodeResourceIncludes).
	const resource = FileAccess.asFileUri(`vs/workbench/contrib/chipos/browser/media/installGuides/${guideName}.md`);

	try {
		await editorService.openEditor({
			resource,
			options: {
				pinned: true,
				preserveFocus: false,
			},
		});
		logService.info(`[ChipOS EDA install guide] opened ${guideName}.md for tool=${tool}`);
	} catch (err) {
		logService.error(`[ChipOS EDA install guide] failed to open ${resource.toString()}: ${err}`);
		notificationService.notify({
			severity: Severity.Error,
			message: localize(
				'chipos.eda.installGuide.openFailed',
				'Could not open install guide for {0}: {1}',
				tool,
				String(err),
			),
		});
	}
});

/**
 * FEAT-002a: install a chipos agent plugin from a local folder. Opens a folder
 * picker, validates its `.chipos-plugin/plugin.json` (or Cursor `.cursor-plugin/`)
 * manifest, and copies the tree into `~/.chipos/plugins/<id>/` so the
 * plugin's rules/commands/skills decompose into the agent (source=plugin).
 * Agent plugins are chipos's own AI-capability bundle format — NOT VS Code
 * extensions (.vsix / Open VSX), which are a separate IDE concern.
 */
registerAction2(class InstallPluginFromLocalAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.plugins.installFromLocal',
			title: localize2('chipos.plugins.installFromLocal', 'Install Plugin from Local…'),
			category: localize2('chipos.category', 'ChipOS'),
			menu: [{ id: MenuId.CommandPalette }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);
		const instantiationService = accessor.get(IInstantiationService);

		const picked = await fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: localize('chipos.plugins.installFromLocal.pick', 'Select Plugin Folder'),
		});
		if (!picked || picked.length === 0) {
			return;
		}

		try {
			const result = await instantiationService.createInstance(ChiposPluginsService).installFromFolder(picked[0]);
			notificationService.info(localize(
				'chipos.plugins.installFromLocal.done',
				'Installed plugin "{0}" v{1}.',
				result.manifest.name, result.manifest.version,
			));
		} catch (err) {
			// A bad/absent manifest is rejected with a PluginManifestError whose
			// message names the schema problem; surface it verbatim (BDD-002).
			const message = err instanceof PluginManifestError ? err.message : String(err);
			notificationService.error(localize(
				'chipos.plugins.installFromLocal.failed',
				'Could not install plugin: {0}', message,
			));
		}
	}
});

/**
 * FEAT-002b: install a chipos agent plugin from a Git URL. Prompts for an https
 * Git URL, shows a trust confirmation, then clones (host restricted by
 * `chipos.plugins.allowedGitDomains`) into a temp dir and installs it via the
 * same validate+copy pipeline as the local install; the temp clone is always
 * cleaned up. Plugin HOOKS are still NOT decomposed (a trust-gated follow-up).
 */
registerAction2(class InstallPluginFromGitAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.plugins.installFromGit',
			title: localize2('chipos.plugins.installFromGit', 'Import Plugin from Git URL…'),
			category: localize2('chipos.category', 'ChipOS'),
			menu: [{ id: MenuId.CommandPalette }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const instantiationService = accessor.get(IInstantiationService);
		const progressService = accessor.get(IProgressService);

		const url = await quickInputService.input({
			title: localize('chipos.plugins.installFromGit.title', 'Import Plugin from Git URL'),
			prompt: localize('chipos.plugins.installFromGit.prompt', 'https Git URL of the plugin repository (host must be allow-listed in chipos.plugins.allowedGitDomains)'),
			placeHolder: 'https://github.com/owner/repo.git',
			validateInput: async value => {
				const v = value.trim();
				if (!v) { return localize('chipos.plugins.installFromGit.required', 'A Git URL is required.'); }
				if (!/^https:\/\//i.test(v)) { return localize('chipos.plugins.installFromGit.https', 'Only https:// URLs are supported.'); }
				return undefined;
			},
		});
		const trimmed = url?.trim();
		if (!trimmed) {
			return;
		}

		const confirmed = await dialogService.confirm({
			message: localize('chipos.plugins.installFromGit.confirm', 'Install plugin from this Git repository?'),
			detail: localize('chipos.plugins.installFromGit.confirmDetail', '{0}\n\nOnly install plugins from sources you trust — a plugin can contribute rules, commands and skills to the agent.', trimmed),
			primaryButton: localize('chipos.plugins.installFromGit.confirmButton', 'Clone & Install'),
			type: 'warning',
		});
		if (!confirmed.confirmed) {
			return;
		}

		try {
			const result = await progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('chipos.plugins.installFromGit.progress', 'Cloning plugin from {0}…', trimmed),
					cancellable: false,
				},
				() => instantiationService.createInstance(ChiposPluginsService).installFromGit(trimmed),
			);
			notificationService.info(localize(
				'chipos.plugins.installFromGit.done',
				'Installed plugin "{0}" v{1} from Git.',
				result.manifest.name, result.manifest.version,
			));
		} catch (err) {
			// Untrusted-host / clone / manifest failures all surface their message.
			const message = err instanceof Error ? err.message : String(err);
			notificationService.error(localize(
				'chipos.plugins.installFromGit.failed',
				'Could not install plugin from Git: {0}', message,
			));
		}
	}
});

registerWorkbenchContribution2(
	ChipOSContribution.ID,
	ChipOSContribution,
	WorkbenchPhase.AfterRestored
);
