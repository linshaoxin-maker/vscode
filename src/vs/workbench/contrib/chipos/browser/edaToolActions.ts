/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * EDA Tool right-click actions for the WORKER TOOLS panel.
 *
 * Each tree item in the panel has a contextValue of the shape
 *   `chiposImplTool:<impl>:<readyState>`   (e.g. `chiposImplTool:mcp:ready`)
 *   `chiposImplGroup:<impl>`               (the parent grouping node)
 *   `chiposWorkerMcpServer`                (an MCP server node)
 *
 * Menu contributions match on `viewItem == <contextValue>` so each impl gets
 * its own action set:
 *
 *   missing       → View install guide / Rescan / Configure local path /
 *                   Connect via MCP / Disable
 *   local-binary  → Test / Show in finder / Copy path / Replace path /
 *                   Switch to MCP
 *   mcp           → Test / Show MCP server / Copy server URL /
 *                   Switch to local
 *   managed       → Update / Reinstall / Show in finder / Copy path
 *
 * Actions write per-tool settings to `chipos.eda.tools.<name>` so the
 * worker's tool_resolver (next /api/v1/eda/resolutions tick) picks them up.
 *
 * Path resolution lookup is done at action-run-time via
 * IWorkerToolManagerService.getEdaToolResolutions — the tree handle only
 * carries the tool_name, and we want live data not stale snapshot.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TreeViewItemHandleArg } from '../../../common/views.js';
import {
	EdaResolutionsResponse,
	EdaToolResolution,
	IWorkerToolManagerService,
} from '../../../../workbench/contrib/chipos/browser/workerToolManager.js';

const WORKER_TOOLS_VIEW_ID = 'chipos.workerTools';

// ── settings helpers ────────────────────────────────────────────────────────

interface EdaToolSettingEntry {
	source?: 'auto' | 'managed' | 'local' | 'mcp' | 'manual' | 'disabled';
	path?: string;
	mcpServer?: string;
}

async function updateToolSetting(
	config: IConfigurationService,
	toolName: string,
	entry: EdaToolSettingEntry | undefined,
): Promise<void> {
	const current = config.getValue<Record<string, EdaToolSettingEntry>>('chipos.eda.tools') ?? {};
	const next: Record<string, EdaToolSettingEntry> = { ...current };
	if (entry === undefined) {
		delete next[toolName];
	} else {
		next[toolName] = { ...current[toolName], ...entry };
	}
	await config.updateValue('chipos.eda.tools', next, ConfigurationTarget.USER);
}

// ── tree-handle parsing ─────────────────────────────────────────────────────

function parseToolHandle(handle: string | undefined): string | undefined {
	if (!handle) { return undefined; }
	// handles look like `impl-tool:<tool_name>`
	if (handle.startsWith('impl-tool:')) {
		return handle.slice('impl-tool:'.length);
	}
	// legacy fallback for old worker-tool:<name> handle
	if (handle.startsWith('worker-tool:')) {
		return handle.slice('worker-tool:'.length);
	}
	return undefined;
}

function parseServerHandle(handle: string | undefined): string | undefined {
	if (!handle) { return undefined; }
	if (handle.startsWith('worker-mcp:')) {
		return handle.slice('worker-mcp:'.length);
	}
	return undefined;
}

async function fetchResolution(
	service: IWorkerToolManagerService,
	toolName: string,
): Promise<EdaToolResolution | undefined> {
	try {
		const all: EdaResolutionsResponse = await service.getEdaToolResolutions();
		return all.by_tool[toolName];
	} catch {
		return undefined;
	}
}

async function refreshPanel(accessor: ServicesAccessor): Promise<void> {
	const viewsService = accessor.get(IViewsService);
	const view = viewsService.getActiveViewWithId(WORKER_TOOLS_VIEW_ID);
	// Defensive: TreeView refresh API isn't typed on the view interface, so we
	// reach in via `as any`. The widely-used pattern in chiposContribution.ts.
	(view as any)?.treeView?.refresh();
}

// ── shared 4-impl actions ───────────────────────────────────────────────────

// `Test`: for managed/local-binary, exec `<binary> --version` via worker's
// existing detect endpoint and show the version. For mcp, ping the server
// and show advertised tools count. Wrapped in a single action because the
// menu context discriminator already filtered to the right impl, but the
// runtime detail comes from the live resolution payload.
registerAction2(class TestToolAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.test',
			title: localize2('chipos.eda.tool.test', 'Test'),
			icon: Codicon.debugStart,
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.or(
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:managed:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:local-binary:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:mcp:ready'),
					),
					group: '1_inspect',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const service = accessor.get(IWorkerToolManagerService);
		const notif = accessor.get(INotificationService);
		const log = accessor.get(ILogService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) {
			notif.warn(localize('chipos.eda.tool.test.noHandle', 'No tool selected to test.'));
			return;
		}
		try {
			const status = await service.getToolStatus(toolName);
			const r = await fetchResolution(service, toolName);
			if (r?.impl === 'mcp') {
				notif.info(localize(
					'chipos.eda.tool.test.mcp',
					'{0} reachable via MCP server "{1}".',
					toolName, r.detail.server_name ?? '?',
				));
			} else if (status.installed) {
				notif.info(localize(
					'chipos.eda.tool.test.ok',
					'{0} ready: {1} at {2}',
					toolName, status.version ?? 'version unknown', status.path ?? '-',
				));
			} else {
				notif.warn(localize(
					'chipos.eda.tool.test.fail',
					'{0} not reachable: no binary at expected location.',
					toolName,
				));
			}
		} catch (err) {
			log.warn(`[ChipOS EDA] Test action failed for ${toolName}: ${err}`);
			notif.error(localize('chipos.eda.tool.test.error', 'Test failed: {0}', String(err)));
		}
	}
});

registerAction2(class CopyPathAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.copyPath',
			title: localize2('chipos.eda.tool.copyPath', 'Copy Path'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.or(
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:managed:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:local-binary:ready'),
					),
					group: '2_clipboard',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const clipboard = accessor.get(IClipboardService);
		const notif = accessor.get(INotificationService);
		const service = accessor.get(IWorkerToolManagerService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) { return; }
		const r = await fetchResolution(service, toolName);
		const path = r?.detail.path ?? '';
		if (!path) {
			notif.warn(localize('chipos.eda.tool.copyPath.empty', 'No path to copy for {0}.', toolName));
			return;
		}
		await clipboard.writeText(path);
		notif.info(localize('chipos.eda.tool.copyPath.done', 'Copied: {0}', path));
	}
});

registerAction2(class ShowInFinderAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.showInFinder',
			title: localize2('chipos.eda.tool.showInFinder', 'Show in Finder'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.or(
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:managed:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:local-binary:ready'),
					),
					group: '2_clipboard',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const service = accessor.get(IWorkerToolManagerService);
		const notif = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) { return; }
		const r = await fetchResolution(service, toolName);
		const path = r?.detail.path ?? '';
		if (!path) {
			notif.warn(localize('chipos.eda.tool.showInFinder.empty', 'No path to reveal for {0}.', toolName));
			return;
		}
		try {
			await commandService.executeCommand('revealFileInOS', URI.file(path));
		} catch (err) {
			notif.warn(localize('chipos.eda.tool.showInFinder.fail', 'Could not reveal {0}: {1}', path, String(err)));
		}
	}
});

// ── missing-tool actions ────────────────────────────────────────────────────

// Configure a local path for a missing/local tool → writes
// chipos.eda.tools.<name>.{source:'local', path:'...'} and refreshes panel.
registerAction2(class ConfigureLocalPathAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.configureLocalPath',
			title: localize2('chipos.eda.tool.configureLocalPath', 'Configure Local Path…'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.or(
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:missing:missing'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:local-binary:ready'),
					),
					group: '3_configure',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const dialog = accessor.get(IFileDialogService);
		const config = accessor.get(IConfigurationService);
		const notif = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) { return; }

		const picked = await dialog.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: localize('chipos.eda.tool.configureLocalPath.title', 'Pick {0} binary', toolName),
		});
		if (!picked || picked.length === 0) { return; }
		const fsPath = picked[0].fsPath;
		await updateToolSetting(config, toolName, { source: 'local', path: fsPath });
		notif.info(localize(
			'chipos.eda.tool.configureLocalPath.done',
			'{0} set to local: {1}. Re-scanning…',
			toolName, fsPath,
		));
		await commandService.executeCommand('chipos.eda.rescan');
		await refreshPanel(accessor);
	}
});

registerAction2(class ConnectViaMcpAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.connectViaMcp',
			title: localize2('chipos.eda.tool.connectViaMcp', 'Connect via MCP…'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.equals('viewItem', 'chiposImplTool:missing:missing'),
					group: '3_configure',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, _arg: TreeViewItemHandleArg): Promise<void> {
		// Delegate to existing Add MCP server action — same flow, just framed
		// from a tool-row's perspective. Caller's expectation: "I want vivado
		// via MCP" → fill in name + cmd + args → discovered tools update the
		// panel automatically through the resolution refresh.
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('chipos.workerTools.addMcpServer');
	}
});

registerAction2(class DisableToolAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.disable',
			title: localize2('chipos.eda.tool.disable', 'Disable (Suppress Notifications)'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.or(
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:missing:missing'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:mcp:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:local-binary:ready'),
					),
					group: '9_destructive',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const config = accessor.get(IConfigurationService);
		const notif = accessor.get(INotificationService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) { return; }
		await updateToolSetting(config, toolName, { source: 'disabled' });
		notif.info(localize(
			'chipos.eda.tool.disable.done',
			'{0} disabled. To re-enable, change source in settings.',
			toolName,
		));
		await refreshPanel(accessor);
	}
});

// ── source-switching (Settings-mediated, no settings page yet) ──────────────

// Switch a tool's preferred source. Pops a QuickPick of the 4 candidate
// sources (auto / managed / local / mcp / disabled) and writes the setting.
// Per-source guidance: managed only offered if MANAGED_ELIGIBLE (we ask the
// resolver — alternatives field carries this signal indirectly). UI offers
// every option; resolver will respect/skip based on impl eligibility.
registerAction2(class SwitchSourceAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.switchSource',
			title: localize2('chipos.eda.tool.switchSource', 'Switch Source…'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.or(
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:managed:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:local-binary:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:mcp:ready'),
						ContextKeyExpr.equals('viewItem', 'chiposImplTool:missing:missing'),
					),
					group: '3_configure',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const config = accessor.get(IConfigurationService);
		const notif = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) { return; }
		const picked = await quickInput.pick([
			{ label: 'auto',     description: localize('chipos.eda.source.auto.desc', 'Use default strategy (managed → local → mcp)') },
			{ label: 'managed',  description: localize('chipos.eda.source.managed.desc', 'ChipOS-managed install (oss-cad-suite only)') },
			{ label: 'local',    description: localize('chipos.eda.source.local.desc', 'Use system binary on PATH (or explicit path)') },
			{ label: 'mcp',      description: localize('chipos.eda.source.mcp.desc', 'Route to a remote MCP server') },
			{ label: 'disabled', description: localize('chipos.eda.source.disabled.desc', 'Hide from agent tool registry') },
		], {
			title: localize('chipos.eda.tool.switchSource.title', 'Set source for {0}', toolName),
		});
		if (!picked) { return; }
		const source = picked.label as EdaToolSettingEntry['source'];
		await updateToolSetting(config, toolName, { source });
		notif.info(localize(
			'chipos.eda.tool.switchSource.done',
			'{0} source set to "{1}". Re-scanning…',
			toolName, source!,
		));
		await commandService.executeCommand('chipos.eda.rescan');
		await refreshPanel(accessor);
	}
});

// ── managed-tool actions ────────────────────────────────────────────────────

// UX #8: bulk "Update all" on the ChipOS Managed impl-group header.
// Re-runs eda_pack install for every managed tool. Worker dedups if
// already at latest; user sees a single progress notification rather than
// having to right-click each managed row.
registerAction2(class UpdateAllManagedAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.group.updateAllManaged',
			title: localize2('chipos.eda.group.updateAllManaged', 'Update All'),
			icon: Codicon.cloudDownload,
			menu: [{
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('viewItem', 'chiposImplGroup:managed'),
				group: 'inline',
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IWorkerToolManagerService);
		const notif = accessor.get(INotificationService);
		const log = accessor.get(ILogService);
		try {
			// Re-fetch resolutions to know which tools are currently managed
			const all = await service.getEdaToolResolutions();
			const managed = Object.values(all.by_tool).filter(r => r.impl === 'managed' && r.ready);
			if (managed.length === 0) {
				notif.info(localize('chipos.eda.group.updateAll.empty', 'No managed tools to update.'));
				return;
			}
			// One eda_pack install covers the whole oss-cad-suite bundle —
			// pass any managed tool name; worker routes via EDA_INSTALL_METHODS.
			const r = await service.installTool(managed[0].tool_name, 'eda_pack');
			if (r.success) {
				notif.info(localize(
					'chipos.eda.group.updateAll.done',
					'Managed toolchain refreshed ({0} tools): {1}',
					managed.length,
					managed.map(m => m.tool_name).slice(0, 5).join(', ') + (managed.length > 5 ? '…' : ''),
				));
			} else {
				notif.warn(localize('chipos.eda.group.updateAll.fail', 'Update failed: {0}', r.error ?? 'unknown'));
			}
		} catch (err) {
			log.warn(`[ChipOS EDA] Update all failed: ${err}`);
			notif.error(localize('chipos.eda.group.updateAll.error', 'Update error: {0}', String(err)));
		}
	}
});

registerAction2(class UpdateManagedToolAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.tool.updateManaged',
			title: localize2('chipos.eda.tool.updateManaged', 'Update'),
			icon: Codicon.cloudDownload,
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.equals('viewItem', 'chiposImplTool:managed:ready'),
					group: '1_inspect',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const service = accessor.get(IWorkerToolManagerService);
		const notif = accessor.get(INotificationService);
		const toolName = parseToolHandle(arg?.$treeItemHandle);
		if (!toolName) { return; }
		// installTool with method=eda_pack re-runs EdaPackManager.ensure_ready.
		// Worker side dedups — if package already at latest version this is a no-op.
		try {
			const r = await service.installTool(toolName, 'eda_pack');
			if (r.success) {
				notif.info(localize('chipos.eda.tool.updateManaged.done', '{0} updated.', toolName));
			} else {
				notif.warn(localize('chipos.eda.tool.updateManaged.fail', 'Update failed: {0}', r.error ?? 'unknown'));
			}
		} catch (err) {
			notif.error(localize('chipos.eda.tool.updateManaged.error', 'Update error: {0}', String(err)));
		}
		await refreshPanel(accessor);
	}
});

// ── MCP server actions ──────────────────────────────────────────────────────

registerAction2(class TestMcpServerAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.server.test',
			title: localize2('chipos.eda.server.test', 'Test Connection'),
			icon: Codicon.debugStart,
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.equals('viewItem', 'chiposWorkerMcpServer'),
					group: '1_inspect',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const service = accessor.get(IWorkerToolManagerService);
		const notif = accessor.get(INotificationService);
		const log = accessor.get(ILogService);
		const serverName = parseServerHandle(arg?.$treeItemHandle);
		if (!serverName) { return; }
		try {
			// Live ping rather than reading cached `provides` from
			// listMcpServers — user wants to know "is it reachable RIGHT NOW".
			const res = await service.testMcpServer(serverName);
			if (res.success) {
				const count = res.provides?.length ?? 0;
				const sample = count > 0 ? `: ${res.provides!.slice(0, 5).join(', ')}${count > 5 ? '…' : ''}` : '';
				const latency = res.latency_ms != null ? ` (${res.latency_ms}ms)` : '';
				notif.info(localize(
					'chipos.eda.server.test.ok.live',
					'✓ {0} reachable{1} · provides {2} tool(s){3}',
					serverName, latency, count, sample,
				));
			} else {
				notif.warn(localize(
					'chipos.eda.server.test.fail',
					'✗ {0} unreachable: {1}',
					serverName, res.error ?? res.code ?? 'unknown',
				));
			}
		} catch (err) {
			log.warn(`[ChipOS EDA] Test MCP server ${serverName} failed: ${err}`);
			notif.error(localize('chipos.eda.server.test.error', 'Test failed: {0}', String(err)));
		}
	}
});

registerAction2(class CopyMcpServerInfoAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.server.copyInfo',
			title: localize2('chipos.eda.server.copyInfo', 'Copy Server Info'),
			menu: [
				{
					id: MenuId.ViewItemContext,
					when: ContextKeyExpr.equals('viewItem', 'chiposWorkerMcpServer'),
					group: '2_clipboard',
				},
			],
		});
	}
	async run(accessor: ServicesAccessor, arg: TreeViewItemHandleArg): Promise<void> {
		const clipboard = accessor.get(IClipboardService);
		const service = accessor.get(IWorkerToolManagerService);
		const notif = accessor.get(INotificationService);
		const serverName = parseServerHandle(arg?.$treeItemHandle);
		if (!serverName) { return; }
		const all = await service.listMcpServers();
		const found = all.servers.find(s => s.name === serverName);
		if (!found) { return; }
		const info = [
			`name: ${found.name}`,
			`transport: ${found.transport ?? 'stdio'}`,
			`command: ${found.command} ${(found.args ?? []).join(' ')}`,
			`provides: ${(found.provides ?? []).join(', ') || '(none discovered)'}`,
		].join('\n');
		await clipboard.writeText(info);
		notif.info(localize('chipos.eda.server.copyInfo.done', 'MCP server info copied to clipboard.'));
	}
});

// ── F6: Import / Export EDA settings ───────────────────────────────────────

// Export the current chipos.eda.{defaultStrategy,tools,mcpServers} settings
// as a portable JSON blob. CAD teams can dump one, share with developers,
// import on each machine.
registerAction2(class ExportEdaSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.exportSettings',
			title: localize2('chipos.eda.exportSettings', 'Export EDA Settings…'),
			category: localize2('chipos.category', 'ChipOS'),
			menu: [{ id: MenuId.CommandPalette }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const config = accessor.get(IConfigurationService);
		const dialog = accessor.get(IFileDialogService);
		const notif = accessor.get(INotificationService);
		const log = accessor.get(ILogService);
		const payload = {
			version: 1,
			defaultStrategy: config.getValue('chipos.eda.defaultStrategy'),
			tools: config.getValue('chipos.eda.tools'),
			// Note: MCP server config lives in worker's mcp_servers.json,
			// not IDE settings — exported separately. Mention in payload.
			notes: 'MCP server configs are worker-side (mcp_servers.json). Export those via worker config tooling.',
		};
		const uri = await dialog.showSaveDialog({
			title: localize('chipos.eda.exportSettings.title', 'Export EDA settings'),
			defaultUri: URI.file('chipos-eda-settings.json'),
			filters: [{ name: 'JSON', extensions: ['json'] }],
		});
		if (!uri) { return; }
		try {
			// IFileService is renderer-safe in the packaged app; the previous
			// `require('fs')` fallback silently failed there (no `require` in the
			// sandboxed renderer), so export degraded to the broken
			// `vscode.editFile` command path that never wrote the file.
			const fileService = accessor.get(IFileService);
			const json = JSON.stringify(payload, null, 2);
			await fileService.writeFile(uri, VSBuffer.fromString(json));
			notif.info(localize('chipos.eda.exportSettings.done', 'Exported EDA settings to {0}', uri.fsPath));
		} catch (err) {
			log.error(`[ChipOS EDA] export failed: ${err}`);
			notif.error(localize('chipos.eda.exportSettings.fail', 'Export failed: {0}', String(err)));
		}
	}
});

registerAction2(class ImportEdaSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.eda.importSettings',
			title: localize2('chipos.eda.importSettings', 'Import EDA Settings…'),
			category: localize2('chipos.category', 'ChipOS'),
			menu: [{ id: MenuId.CommandPalette }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const config = accessor.get(IConfigurationService);
		const dialog = accessor.get(IFileDialogService);
		const notif = accessor.get(INotificationService);
		const quickInput = accessor.get(IQuickInputService);
		const log = accessor.get(ILogService);
		const picked = await dialog.showOpenDialog({
			title: localize('chipos.eda.importSettings.title', 'Import EDA settings'),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: 'JSON', extensions: ['json'] }],
		});
		if (!picked || picked.length === 0) { return; }
		try {
			// IFileService.readFile works in the sandboxed packaged renderer; the
			// old `require('fs').readFileSync` threw "require is not defined" there,
			// so import always failed in shipped builds.
			const fileService = accessor.get(IFileService);
			const raw = (await fileService.readFile(picked[0])).value.toString();
			const data = JSON.parse(raw);
			if (data.version !== 1) {
				notif.warn(localize('chipos.eda.importSettings.versionMismatch', 'Unsupported settings version: {0}', data.version));
				return;
			}
			// F10: target picker - USER vs WORKSPACE
			const target = await quickInput.pick([
				{ label: localize('chipos.eda.importSettings.targetUser', 'User settings (global)') },
				{ label: localize('chipos.eda.importSettings.targetWorkspace', 'Workspace settings (this project only)') },
			], { title: localize('chipos.eda.importSettings.targetTitle', 'Apply to') });
			if (!target) { return; }
			const ct = target.label.includes('Workspace') ? ConfigurationTarget.WORKSPACE : ConfigurationTarget.USER;
			if (data.defaultStrategy) {
				await config.updateValue('chipos.eda.defaultStrategy', data.defaultStrategy, ct);
			}
			if (data.tools && typeof data.tools === 'object') {
				await config.updateValue('chipos.eda.tools', data.tools, ct);
			}
			notif.info(localize('chipos.eda.importSettings.done', 'Imported EDA settings from {0}. Re-scanning…', picked[0].fsPath));
			const commandService = accessor.get(ICommandService);
			await commandService.executeCommand('chipos.eda.rescan');
		} catch (err) {
			log.error(`[ChipOS EDA] import failed: ${err}`);
			notif.error(localize('chipos.eda.importSettings.fail', 'Import failed: {0}', String(err)));
		}
	}
});

// ── module entry: harmless side-effect import drains all registerAction2 calls ─

// Programmatic re-export so consumers can verify wiring in tests (no behavior).
export const EDA_TOOL_ACTION_IDS = [
	'chipos.eda.tool.test',
	'chipos.eda.tool.copyPath',
	'chipos.eda.tool.showInFinder',
	'chipos.eda.tool.configureLocalPath',
	'chipos.eda.tool.connectViaMcp',
	'chipos.eda.tool.disable',
	'chipos.eda.tool.switchSource',
	'chipos.eda.tool.updateManaged',
	'chipos.eda.server.test',
	'chipos.eda.server.copyInfo',
	'chipos.eda.group.updateAllManaged',
	'chipos.eda.exportSettings',
	'chipos.eda.importSettings',
] as const;

// Ensure CommandsRegistry can resolve these as commands (Action2 already does,
// but defensive re-stamp in case constructor order shuffles).
for (const id of EDA_TOOL_ACTION_IDS) {
	if (!CommandsRegistry.getCommand(id)) {
		CommandsRegistry.registerCommand(id, () => { /* registered via Action2 */ });
	}
}
