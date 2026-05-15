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
const STATUSBAR_USAGE_ID = 'chipos.statusbar.usage';
const STATUSBAR_RECONNECT_ID = 'chipos.statusbar.reconnect';

/**
 * Why the reconnect entry is visible. Each variant maps to a slightly
 * different label/tooltip so the user knows what specifically went wrong.
 */
export type ReconnectReason =
	| 'sidecar-error'    // reasoner connection died
	| 'worker-error'     // worker process errored
	| 'worker-disconnected' // worker fell off but didn't error
	| 'connected'        // worker is healthy — show "已连接" green pill, click = force restart
	| 'connecting';      // worker mid-startup — show "连接中" neutral pill


export interface IChipOSUsageDisplay {
	totalTokens: number;
	limitTokens: number | null;
	meteringEnabled: boolean;
}

export class StatusBarHandler extends Disposable {

	private _connectionEntry: IStatusbarEntryAccessor | undefined;
	private _agentEntry: IStatusbarEntryAccessor | undefined;
	private _filesEntry: IStatusbarEntryAccessor | undefined;
	private _mcpEntry: IStatusbarEntryAccessor | undefined;
	private _usageEntry: IStatusbarEntryAccessor | undefined;
	private _reconnectEntry: IStatusbarEntryAccessor | undefined;

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

	// ── Usage / quota ─────────────────────────────────────────────────────

	updateUsage(display: IChipOSUsageDisplay | null): void {
		// Hide entry when not logged in / metering off / no data yet.
		if (!display || !display.meteringEnabled) {
			if (this._usageEntry) {
				this._usageEntry.dispose();
				this._usageEntry = undefined;
			}
			return;
		}

		const used = formatTokens(display.totalTokens);
		const limit = display.limitTokens ? formatTokens(display.limitTokens) : null;
		const text = limit
			? `$(graph) ${used} / ${limit}`
			: `$(graph) ${used} tokens`;
		const tooltip = limit
			? `ChipOS usage this month: ${display.totalTokens.toLocaleString()} / ${display.limitTokens!.toLocaleString()} tokens\nClick to open dashboard`
			: `ChipOS usage this month: ${display.totalTokens.toLocaleString()} tokens\nClick to open dashboard`;

		const entry = {
			name: 'ChipOS Usage',
			text,
			ariaLabel: text,
			command: 'chipos.dashboard.openUsage',
			tooltip,
		};
		if (this._usageEntry) {
			this._usageEntry.update(entry);
		} else {
			this._usageEntry = this._statusbarService.addEntry(
				entry,
				STATUSBAR_USAGE_ID,
				StatusbarAlignment.LEFT,
				{ location: { id: STATUSBAR_CONNECTION_ID, priority: 97 }, alignment: StatusbarAlignment.LEFT, compact: true },
			);
			this._register(this._usageEntry);
		}
	}

	// ── Reconnect Worker (UX #4) ──────────────────────────────────────────
	//
	// Surfaces a one-click recovery path when the sidecar / worker drops out.
	// Stock VS Code only shows a generic "Disconnected" pill; users have had to
	// open the command palette and type out "ChipOS: Restart Worker" to recover.
	//
	// 2026-05-15 改: 不再 dispose entry (dispose 在某些 transition 序列里残留 stale).
	// 改成"始终在场"的状态指示器:
	//   - worker error/disconnected → 橙色 "Reconnect" 可点重启
	//   - worker connected           → 绿色 "$(check) Connected" 仍可点 = 主动 force restart
	//   - worker connecting/starting → 灰色 "$(loading~spin) Connecting" 不可点
	// 这样 update() 永远 work, 不依赖 dispose() 的 race-condition 状态.
	updateReconnectButton(reason: ReconnectReason | undefined): void {
		// undefined === connected (旧 API 调用方传 undefined 表示"连上了, 不用显示"). 现在保留按钮但显示 connected 态.
		const effective: ReconnectReason = reason ?? 'connected';

		let text: string;
		let tooltip: string;
		let useWarningColor = true;
		switch (effective) {
			case 'sidecar-error':
				text = '$(debug-restart) Reconnect';
				tooltip = 'ChipOS backend connection failed.\nClick to restart the worker (often clears the issue).';
				break;
			case 'worker-error':
				text = '$(debug-restart) Reconnect';
				tooltip = 'ChipOS worker errored out.\nClick to restart it.';
				break;
			case 'worker-disconnected':
				text = '$(debug-restart) Reconnect';
				tooltip = 'ChipOS worker is disconnected.\nClick to reconnect.';
				break;
			case 'connecting':
				text = '$(loading~spin) Connecting';
				tooltip = 'ChipOS worker is starting up...';
				useWarningColor = false;
				break;
			case 'connected':
				text = '$(check) Connected';
				tooltip = 'ChipOS worker connected.\nClick to force restart (rarely needed).';
				useWarningColor = false;
				break;
		}

		const entry: any = {
			name: 'ChipOS Reconnect',
			text,
			ariaLabel: useWarningColor ? 'Reconnect ChipOS worker' : 'ChipOS worker connected',
			command: 'chipos.restartWorker',
			tooltip,
		};
		if (useWarningColor) {
			// `warning` background draws the eye without screaming "error".
			entry.backgroundColor = { id: 'statusBarItem.warningBackground' };
			entry.color = { id: 'statusBarItem.warningForeground' };
		}
		// connected/connecting state: no warning bg → blends into status bar (绿色 codicon-check 自带)

		if (this._reconnectEntry) {
			this._reconnectEntry.update(entry);
		} else {
			this._reconnectEntry = this._statusbarService.addEntry(
				entry,
				STATUSBAR_RECONNECT_ID,
				StatusbarAlignment.LEFT,
				// Higher priority than the connection pill (100) so it appears
				// to its immediate right and is the first thing the eye lands on.
				{ location: { id: STATUSBAR_CONNECTION_ID, priority: 102 }, alignment: StatusbarAlignment.LEFT, compact: false },
			);
			this._register(this._reconnectEntry);
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
		this._usageEntry?.dispose();
		this._usageEntry = undefined;
		this._reconnectEntry?.dispose();
		this._reconnectEntry = undefined;
		super.dispose();
	}

	// ── Private ────────────────────────────────────────────────────────────

	private _initConnectionEntry(): void {
		this.updateConnectionState(ConnectionState.Disconnected);
	}
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(1)}k`;
	}
	return String(n);
}
