/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { IMcpService, McpConnectionState } from '../../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';

export class ToolsTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private _mcpListContainer: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IMcpService private readonly _mcpService: IMcpService,
		@ICommandService private readonly _commandService: ICommandService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		// ── Header ──
		const headerDesc = dom.append(this._container, dom.$('.chipos-setting-description'));
		headerDesc.style.marginBottom = '16px';
		headerDesc.textContent = localize('chipos.tools.header',
			'Manage MCP servers and view available tools. MCP servers provide additional capabilities to the AI agent.');

		// ── Section: MCP Servers ──
		const mcpSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		const mcpHeader = dom.append(mcpSection, dom.$('.chipos-settings-section-header'));
		mcpHeader.style.display = 'flex';
		mcpHeader.style.justifyContent = 'space-between';
		mcpHeader.style.alignItems = 'center';

		dom.append(mcpHeader, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.tools.mcpServers', 'MCP Servers')));

		const addBtn = dom.append(mcpHeader, dom.$('button.chipos-btn-secondary'));
		addBtn.textContent = localize('chipos.tools.addServer', '+ Add Server');
		addBtn.style.cursor = 'pointer';
		this._disposables.add(dom.addDisposableListener(addBtn, 'click', () => {
			this._commandService.executeCommand('workbench.mcp.addConfiguration');
		}));

		this._mcpListContainer = dom.append(mcpSection, dom.$('.chipos-mcp-server-list'));
		this._mcpListContainer.style.marginTop = '8px';

		// ── Reactive: watch servers + tools ──
		this._disposables.add(autorun(reader => {
			const servers = this._mcpService.servers.read(reader);
			// Read tools for each server to establish dependency tracking
			for (const server of servers) {
				server.tools.read(reader);
				server.connectionState.read(reader);
			}
			this._renderMcpList(servers);
		}));

		// ── Section: Configuration Files ──
		const configSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		configSection.style.marginTop = '24px';
		dom.append(configSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.tools.configFiles', 'Configuration Files')));

		const configDesc = dom.append(configSection, dom.$('.chipos-setting-description'));
		configDesc.style.marginBottom = '12px';
		configDesc.textContent = localize('chipos.tools.configDesc',
			'MCP servers are configured in mcp.json files. Global config applies to all projects, workspace config is project-specific.');

		this._renderConfigLink(configSection,
			localize('chipos.tools.globalConfig', 'Global: ~/.chipos/mcp.json'),
			'workbench.mcp.openUserMcpJson');

		this._renderConfigLink(configSection,
			localize('chipos.tools.workspaceConfig', 'Workspace: .chipos/mcp.json'),
			'workbench.mcp.openWorkspaceMcpJson');
	}

	private _renderMcpList(servers: readonly any[]): void {
		if (!this._mcpListContainer) { return; }
		dom.clearNode(this._mcpListContainer);

		if (servers.length === 0) {
			const empty = dom.append(this._mcpListContainer, dom.$('.chipos-mcp-empty'));
			empty.style.padding = '16px';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontStyle = 'italic';
			empty.textContent = localize('chipos.tools.noServers',
				'No MCP servers configured. Click "+ Add Server" to get started.');
			return;
		}

		for (const server of servers) {
			this._renderServerRow(this._mcpListContainer, server);
		}
	}

	private _renderServerRow(parent: HTMLElement, server: any): void {
		const row = dom.append(parent, dom.$('.chipos-mcp-server-row'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.padding = '8px 12px';
		row.style.borderRadius = '4px';
		row.style.marginBottom = '4px';
		row.style.background = 'var(--vscode-list-hoverBackground)';

		// Status dot
		const dot = dom.append(row, dom.$('span'));
		const connState = server.connectionState.get();
		const stateKind = connState?.state ?? McpConnectionState.Kind.Stopped;
		if (stateKind === McpConnectionState.Kind.Running) {
			dot.textContent = '● ';
			dot.style.color = 'var(--vscode-testing-iconPassed)';
		} else if (stateKind === McpConnectionState.Kind.Error) {
			dot.textContent = '● ';
			dot.style.color = 'var(--vscode-testing-iconFailed)';
		} else if (stateKind === McpConnectionState.Kind.Starting) {
			dot.textContent = '◌ ';
			dot.style.color = 'var(--vscode-charts-yellow)';
		} else {
			dot.textContent = '○ ';
			dot.style.color = 'var(--vscode-descriptionForeground)';
		}

		// Server name
		const name = dom.append(row, dom.$('span'));
		name.textContent = server.definition?.label || server.definition?.id || 'Unknown';
		name.style.fontWeight = '600';
		name.style.flex = '1';
		name.style.marginLeft = '4px';

		// State text
		const stateText = dom.append(row, dom.$('span'));
		stateText.style.color = 'var(--vscode-descriptionForeground)';
		stateText.style.fontSize = '12px';
		stateText.style.marginRight = '8px';
		const stateLabel = stateKind === McpConnectionState.Kind.Running ? 'Running'
			: stateKind === McpConnectionState.Kind.Starting ? 'Starting'
				: stateKind === McpConnectionState.Kind.Error ? 'Error'
					: 'Stopped';
		stateText.textContent = stateLabel;

		// Tool count
		const tools = server.tools.get();
		if (tools.length > 0) {
			const toolBadge = dom.append(row, dom.$('span'));
			toolBadge.style.color = 'var(--vscode-descriptionForeground)';
			toolBadge.style.fontSize = '12px';
			toolBadge.style.marginRight = '8px';
			toolBadge.textContent = `${tools.length} tool${tools.length !== 1 ? 's' : ''}`;
		}

		// Actions button
		const actionsBtn = dom.append(row, dom.$('button'));
		actionsBtn.textContent = '⋯';
		actionsBtn.title = localize('chipos.tools.serverActions', 'Server actions');
		actionsBtn.style.background = 'none';
		actionsBtn.style.border = 'none';
		actionsBtn.style.color = 'var(--vscode-foreground)';
		actionsBtn.style.cursor = 'pointer';
		actionsBtn.style.fontSize = '16px';
		actionsBtn.style.padding = '2px 6px';
		this._disposables.add(dom.addDisposableListener(actionsBtn, 'click', () => {
			this._commandService.executeCommand('workbench.mcp.listServer');
		}));
	}

	private _renderConfigLink(parent: HTMLElement, label: string, command: string): void {
		const row = dom.append(parent, dom.$('.chipos-config-link-row'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.padding = '6px 0';

		const labelEl = dom.append(row, dom.$('span'));
		labelEl.textContent = label;
		labelEl.style.flex = '1';
		labelEl.style.fontFamily = 'var(--vscode-editor-font-family)';
		labelEl.style.fontSize = '13px';

		const openBtn = dom.append(row, dom.$('button.chipos-btn-secondary'));
		openBtn.textContent = localize('chipos.tools.open', 'Open');
		openBtn.style.cursor = 'pointer';
		openBtn.style.marginLeft = '8px';
		this._disposables.add(dom.addDisposableListener(openBtn, 'click', () => {
			this._commandService.executeCommand(command);
		}));
	}
}
