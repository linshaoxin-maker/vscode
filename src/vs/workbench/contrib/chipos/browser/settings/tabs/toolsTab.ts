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
export class ToolsTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private _mcpListContainer: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IMcpService private readonly _mcpService: IMcpService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		// ── Header ──
		const headerDesc = dom.append(this._container, dom.$('.chipos-setting-description'));
		headerDesc.textContent = localize('chipos.tools.header',
			'Manage IDE-side MCP servers (run alongside the editor). Worker-side MCP servers — those launched by the Worker process for EDA tooling — are listed in the Worker Tools panel.');

		// ── Section: MCP Servers ──
		const mcpSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		const mcpHeader = dom.append(mcpSection, dom.$('.chipos-settings-section-header'));

		dom.append(mcpHeader, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.tools.mcpServers', 'IDE-side MCP Servers')));

		const addBtn = dom.append(mcpHeader, dom.$('button.chipos-btn-secondary'));
		addBtn.textContent = localize('chipos.tools.addServer', '+ Add Server');
		this._disposables.add(dom.addDisposableListener(addBtn, 'click', () => {
			this._commandService.executeCommand('workbench.mcp.addConfiguration');
		}));

		this._mcpListContainer = dom.append(mcpSection, dom.$('.chipos-mcp-server-list'));

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
		dom.append(configSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.tools.configFiles', 'Configuration Files')));

		const configDesc = dom.append(configSection, dom.$('.chipos-setting-description'));
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

		const dot = dom.append(row, dom.$('span.chipos-mcp-dot'));
		const connState = server.connectionState.get();
		const stateKind = connState?.state ?? McpConnectionState.Kind.Stopped;
		if (stateKind === McpConnectionState.Kind.Running) {
			dot.textContent = '● ';
			dot.classList.add('running');
		} else if (stateKind === McpConnectionState.Kind.Error) {
			dot.textContent = '● ';
			dot.classList.add('error');
		} else if (stateKind === McpConnectionState.Kind.Starting) {
			dot.textContent = '◌ ';
			dot.classList.add('starting');
		} else {
			dot.textContent = '○ ';
			dot.classList.add('stopped');
		}

		const name = dom.append(row, dom.$('span.chipos-mcp-server-name'));
		name.textContent = server.definition?.label || server.definition?.id || 'Unknown';

		const stateText = dom.append(row, dom.$('span.chipos-mcp-server-state'));
		stateText.textContent = McpConnectionState.toString(connState);

		const tools = server.tools.get();
		if (tools.length > 0) {
			const toolBadge = dom.append(row, dom.$('span.chipos-mcp-server-tools'));
			toolBadge.textContent = `${tools.length} tool${tools.length !== 1 ? 's' : ''}`;
		}

		const actionsBtn = dom.append(row, dom.$('button.chipos-mcp-server-actions'));
		actionsBtn.textContent = '⋯';
		actionsBtn.title = localize('chipos.tools.serverActions', 'Server actions');
		this._disposables.add(dom.addDisposableListener(actionsBtn, 'click', () => {
			this._commandService.executeCommand('workbench.mcp.listServer');
		}));
	}

	private _renderConfigLink(parent: HTMLElement, label: string, command: string): void {
		const row = dom.append(parent, dom.$('.chipos-config-link-row'));

		const labelEl = dom.append(row, dom.$('span.chipos-config-link-label'));
		labelEl.textContent = label;

		const openBtn = dom.append(row, dom.$('button.chipos-btn-secondary'));
		openBtn.textContent = localize('chipos.tools.open', 'Open');
		this._disposables.add(dom.addDisposableListener(openBtn, 'click', () => {
			this._commandService.executeCommand(command);
		}));
	}
}
