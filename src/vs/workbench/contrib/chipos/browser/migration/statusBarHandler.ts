/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import { ConnectionState } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const CONNECTION_LABELS: Record<string, string> = {
	[ConnectionState.Connected]: '$(circle-filled) ChipOS: Connected',
	[ConnectionState.Disconnected]: '$(circle-outline) ChipOS: Disconnected',
	[ConnectionState.Connecting]: '$(loading~spin) ChipOS: Connecting',
	[ConnectionState.Reconnecting]: '$(loading~spin) ChipOS: Reconnecting',
	[ConnectionState.Error]: '$(error) ChipOS: Error',
};

const STATUSBAR_CONNECTION_ID = 'chipos.statusbar.connection';
const STATUSBAR_AGENT_ID = 'chipos.statusbar.agent';
const STATUSBAR_FILES_ID = 'chipos.statusbar.files';
const STATUSBAR_MCP_ID = 'chipos.statusbar.mcp';

export class StatusBarHandler extends Disposable {

	private _connectionEntry: IStatusbarEntryAccessor | undefined;
	private _agentEntry: IStatusbarEntryAccessor | undefined;
	private _filesEntry: IStatusbarEntryAccessor | undefined;
	private _mcpEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();
		this._initConnectionEntry();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	updateConnectionState(state: ConnectionState): void {
		const text = CONNECTION_LABELS[state] ?? `$(question) ChipOS: ${state}`;

		if (this._connectionEntry) {
			this._connectionEntry.update({
				name: 'ChipOS Connection',
				text,
				ariaLabel: text,
			});
		} else {
		this._connectionEntry = this._statusbarService.addEntry(
			{
				name: 'ChipOS Connection',
				text,
				ariaLabel: text,
			},
			STATUSBAR_CONNECTION_ID,
			StatusbarAlignment.LEFT,
			{ location: { id: 'status.editor.mode', priority: 100 }, alignment: StatusbarAlignment.LEFT, compact: true },
		);
			this._register(this._connectionEntry);
		}
	}

	updateAgentState(running: boolean, stage?: string): void {
		if (!running) {
			if (this._agentEntry) {
				this._agentEntry.dispose();
				this._agentEntry = undefined;
			}
			return;
		}

		const text = stage
			? `$(loading~spin) ${stage}`
			: '$(loading~spin) Agent running';

		if (this._agentEntry) {
			this._agentEntry.update({
				name: 'ChipOS Agent',
				text,
				ariaLabel: text,
			});
		} else {
		this._agentEntry = this._statusbarService.addEntry(
			{
				name: 'ChipOS Agent',
				text,
				ariaLabel: text,
			},
			STATUSBAR_AGENT_ID,
			StatusbarAlignment.LEFT,
			{ location: { id: STATUSBAR_CONNECTION_ID, priority: 101 }, alignment: StatusbarAlignment.LEFT, compact: true },
		);
			this._register(this._agentEntry);
		}
	}

	updateFileChangeCount(count: number): void {
		if (count === 0) {
			if (this._filesEntry) {
				this._filesEntry.dispose();
				this._filesEntry = undefined;
			}
			return;
		}

		const text = `$(file-text) ${count} file${count > 1 ? 's' : ''} changed`;

		if (this._filesEntry) {
			this._filesEntry.update({
				name: 'ChipOS Files',
				text,
				ariaLabel: text,
				command: 'chipos.clearFileChanges',
				tooltip: 'Click to clear file change tracking',
			});
		} else {
			this._filesEntry = this._statusbarService.addEntry(
				{
					name: 'ChipOS Files',
					text,
					ariaLabel: text,
					command: 'chipos.clearFileChanges',
					tooltip: 'Click to clear file change tracking',
				},
				STATUSBAR_FILES_ID,
				StatusbarAlignment.LEFT,
				{ location: { id: STATUSBAR_CONNECTION_ID, priority: 99 }, alignment: StatusbarAlignment.LEFT, compact: true },
			);
			this._register(this._filesEntry);
		}
	}

	// ── MCP Status ────────────────────────────────────────────────────────

	updateMcpStatus(serverCount: number, toolCount: number, hasError: boolean): void {
		const icon = hasError ? '$(warning)' : '$(tools)';
		let text: string;
		let tooltip: string;

		if (serverCount === 0) {
			text = `${icon} MCP`;
			tooltip = 'No MCP servers configured\nClick to add one';
		} else {
			text = `${icon} MCP: ${toolCount} tool${toolCount !== 1 ? 's' : ''}`;
			tooltip = `${serverCount} MCP server${serverCount !== 1 ? 's' : ''}, ${toolCount} tool${toolCount !== 1 ? 's' : ''}\nClick to manage`;
		}

		if (this._mcpEntry) {
			this._mcpEntry.update({
				name: 'ChipOS MCP',
				text,
				ariaLabel: text,
				command: 'workbench.mcp.listServer',
				tooltip,
			});
		} else {
			this._mcpEntry = this._statusbarService.addEntry(
				{
					name: 'ChipOS MCP',
					text,
					ariaLabel: text,
					command: 'workbench.mcp.listServer',
					tooltip,
				},
				STATUSBAR_MCP_ID,
				StatusbarAlignment.LEFT,
				{ location: { id: STATUSBAR_CONNECTION_ID, priority: 98 }, alignment: StatusbarAlignment.LEFT, compact: true },
			);
			this._register(this._mcpEntry);
		}
	}

	override dispose(): void {
		this._connectionEntry?.dispose();
		this._connectionEntry = undefined;
		this._agentEntry?.dispose();
		this._agentEntry = undefined;
		this._filesEntry?.dispose();
		this._filesEntry = undefined;
		this._mcpEntry?.dispose();
		this._mcpEntry = undefined;
		super.dispose();
	}

	// ── Private ────────────────────────────────────────────────────────────

	private _initConnectionEntry(): void {
		this.updateConnectionState(ConnectionState.Disconnected);
	}
}
