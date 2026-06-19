/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * "MCP Servers" settings tab — Phase 6 (IDE-only EDA workbench), slice 4.
 *
 * A single-pane management view of every MCP server the agent can call:
 *   - IDE-side servers from {@link IMcpService} (run alongside the editor,
 *     configured in mcp.json) — health dot from each server's
 *     `connectionState` observable, tool count from `tools`.
 *   - worker-side servers from
 *     {@link IWorkerToolManagerService.listMcpServers} (project EDA MCP
 *     servers launched by the Worker process) — health dot from
 *     `health.status`, tool count from `provides`.
 *
 * IDE-side servers from IMcpService + worker-side from
 * IWorkerToolManagerService.listMcpServers — distinct from toolsTab's inline
 * MCP list. This tab is additive: toolsTab keeps its own embedded MCP list
 * (owned by another slice); this is the dedicated, merged management surface.
 *
 * Each row shows a health dot (running = filled green, stopped = hollow,
 * error = filled red), the server name, a meta line
 * (`transport · N tools · IDE`/`worker`), a status badge, and right-aligned
 * actions (Configure/Stop when running, Start when stopped, Logs/Retry on
 * error). Enabling an untrusted server first asks for confirmation via
 * {@link IDialogService.confirm} — "Trust <name>? It will expose N tools the
 * agent can call." — before it is started.
 *
 * No new transport: it reuses the exact services the EDA Doctor and Tools
 * tabs already use. `autorun(reader => …)` re-renders whenever the IDE-side
 * servers, their connection state, or their tool lists change; the worker-side
 * list is fetched on open and after every mutation.
 */

import './mcpServersTab.css';

import * as dom from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { autorun, IReader } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IMcpServer, IMcpService, McpConnectionState } from '../../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import {
	IWorkerToolManagerService,
	McpServerConfig,
	McpServerListResult,
} from '../../../../../../workbench/contrib/chipos/browser/workerToolManager.js';

/** A normalized health bucket shared by IDE-side + worker-side rows. */
type ServerHealth = 'running' | 'stopped' | 'error';

/** Where a server lives — drives the meta-line tag and the action set. */
type ServerSide = 'ide' | 'worker';

export class McpServersTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	// Per-render listeners (button clicks) are re-created on every re-render, so
	// they live in a store that is cleared at the top of each render — not on
	// the class-level `_disposables`, which would leak one listener set per
	// re-render until the tab closes.
	private readonly _rowDisposables = this._register(new DisposableStore());

	private _bodyEl: HTMLElement | undefined;
	private _addBtn: HTMLButtonElement | undefined;

	/** Cached worker-side list — refreshed on open + after every mutation. */
	private _workerServers: McpServerConfig[] = [];
	private _workerLoading = true;

	constructor(
		private readonly _container: HTMLElement,
		@IMcpService private readonly _mcpService: IMcpService,
		@IWorkerToolManagerService private readonly _toolManager: IWorkerToolManagerService,
		@ICommandService private readonly _commandService: ICommandService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notif: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._render();
	}

	// ── scaffold ─────────────────────────────────────────────────────────────

	private _render(): void {
		this._renderHeader();
		this._bodyEl = dom.append(this._container, dom.$('.chipos-mcp-tab-body'));

		// IDE-side servers are observable: re-render whenever the server set,
		// any connection state, or any tool list changes. Reading those inside
		// the autorun establishes the dependency. The worker-side list is folded
		// into the same render (it isn't observable, so it's fetched separately).
		this._disposables.add(autorun(reader => {
			const servers = this._mcpService.servers.read(reader);
			for (const server of servers) {
				server.connectionState.read(reader);
				server.tools.read(reader);
			}
			this._renderList(servers, reader);
		}));

		// Kick off the initial worker-side fetch (re-renders when it resolves).
		void this._refreshWorkerServers();
	}

	private _renderHeader(): void {
		const header = dom.append(this._container, dom.$('.chipos-mcp-tab-header'));

		const titleWrap = dom.append(header, dom.$('.chipos-mcp-tab-titlewrap'));
		dom.append(titleWrap, dom.$('span.codicon.codicon-plug.chipos-mcp-tab-title-icon'));
		const titleText = dom.append(titleWrap, dom.$('.chipos-mcp-tab-titletext'));
		dom.append(titleText, dom.$('.chipos-mcp-tab-title', undefined,
			localize('chipos.mcpServers.title', 'MCP servers')));
		dom.append(titleText, dom.$('.chipos-mcp-tab-subtitle', undefined,
			localize('chipos.mcpServers.subtitle', 'Tools the agent can call — yours (IDE) and the project\'s (worker)')));

		const actions = dom.append(header, dom.$('.chipos-mcp-tab-headeractions'));
		const addBtn = dom.append(actions, dom.$('button.chipos-mcp-tab-addbtn')) as HTMLButtonElement;
		dom.append(addBtn, dom.$('span.codicon.codicon-add'));
		dom.append(addBtn, dom.$('span', undefined, localize('chipos.mcpServers.add', 'Add server')));
		addBtn.title = localize('chipos.mcpServers.add.tooltip',
			'Add a new MCP server configuration (opens the mcp.json config flow).');
		this._disposables.add(dom.addDisposableListener(addBtn, 'click', () => {
			// Reuse the upstream MCP add-configuration flow (same command the
			// Tools tab uses). It writes an mcp.json entry the IDE then loads.
			this._commandService.executeCommand('workbench.mcp.addConfiguration');
		}));
		this._addBtn = addBtn;
	}

	// ── data fetch ───────────────────────────────────────────────────────────

	private async _refreshWorkerServers(): Promise<void> {
		this._workerLoading = true;
		if (this._addBtn) { this._addBtn.disabled = true; }
		let result: McpServerListResult | undefined;
		try {
			result = await this._toolManager.listMcpServers();
		} catch (err) {
			// No reachable worker (e.g. no workspace open) is expected — surface
			// nothing and just show the IDE-side rows.
			this._log.warn('[McpServersTab] listMcpServers failed:', String(err));
		}
		this._workerServers = result?.servers ?? [];
		this._workerLoading = false;
		if (this._addBtn) { this._addBtn.disabled = false; }
		// Re-render with the merged list. The IDE-side servers are read fresh
		// from the service (not via a reader) since this is outside the autorun.
		this._renderList(this._mcpService.servers.get());
	}

	// ── render ───────────────────────────────────────────────────────────────

	private _renderList(ideServers: readonly IMcpServer[], reader?: IReader): void {
		if (!this._bodyEl) { return; }
		dom.clearNode(this._bodyEl);
		this._rowDisposables.clear();

		const list = dom.append(this._bodyEl, dom.$('.chipos-mcp-tab-list'));

		let rowCount = 0;
		for (const server of ideServers) {
			this._renderIdeRow(list, server, reader);
			rowCount++;
		}
		for (const server of this._workerServers) {
			this._renderWorkerRow(list, server);
			rowCount++;
		}

		if (rowCount === 0) {
			dom.clearNode(this._bodyEl);
			this._renderEmpty();
		}
	}

	private _renderEmpty(): void {
		if (!this._bodyEl) { return; }
		const empty = dom.append(this._bodyEl, dom.$('.chipos-mcp-tab-empty'));
		dom.append(empty, dom.$('span.codicon.codicon-plug.chipos-mcp-tab-empty-icon'));
		if (this._workerLoading) {
			dom.append(empty, dom.$('span', undefined,
				localize('chipos.mcpServers.loading', 'Loading MCP servers…')));
			return;
		}
		dom.append(empty, dom.$('span', undefined,
			localize('chipos.mcpServers.empty', 'No MCP servers configured. Click Add server to connect one.')));
	}

	// ── IDE-side rows ──────────────────────────────────────────────────────

	private _renderIdeRow(parent: HTMLElement, server: IMcpServer, reader?: IReader): void {
		const state = reader ? server.connectionState.read(reader) : server.connectionState.get();
		const tools = reader ? server.tools.read(reader) : server.tools.get();
		const health = this._ideHealth(state.state);
		const name = server.definition.label || server.definition.id;

		const row = this._beginRow(parent, health, name, state.state === McpConnectionState.Kind.Starting);
		this._appendMeta(row, server.collection.label || 'stdio', tools.length, 'ide');
		this._appendBadge(row, health, McpConnectionState.toString(state));

		const actions = dom.append(row, dom.$('.chipos-mcp-tab-row-actions'));
		if (health === 'running') {
			this._actionButton(actions, 'codicon-gear', localize('chipos.mcpServers.configure', 'Configure'), () => {
				// Opens the per-server options quickpick (restart, show output,
				// uninstall, …) keyed by the server's definition id.
				this._commandService.executeCommand('workbench.mcp.serverOptions', server.definition.id);
			});
			this._actionButton(actions, 'codicon-debug-stop', localize('chipos.mcpServers.stop', 'Stop'), async () => {
				await server.stop();
			});
		} else if (health === 'error') {
			this._actionButton(actions, 'codicon-output', localize('chipos.mcpServers.logs', 'Logs'), () => {
				void server.showOutput();
			});
			this._actionButton(actions, 'codicon-refresh', localize('chipos.mcpServers.retry', 'Retry'), () => {
				void this._startIdeServer(server, tools.length, name);
			});
		} else {
			this._actionButton(actions, 'codicon-play', localize('chipos.mcpServers.start', 'Start'), () => {
				void this._startIdeServer(server, tools.length, name);
			});
		}
	}

	/**
	 * Trust-gate then start an IDE-side server. The gate is our own
	 * confirmation (not the native MCP trust prompt, which we suppress with
	 * `promptType: 'never'` so the user only sees one dialog); `autoTrustChanges`
	 * persists the trust so subsequent autostarts don't re-prompt.
	 */
	private async _startIdeServer(server: IMcpServer, toolCount: number, name: string): Promise<void> {
		const ok = await this._confirmTrust(name, toolCount);
		if (!ok) { return; }
		try {
			await server.start({ autoTrustChanges: true, promptType: 'never' });
		} catch (err) {
			this._notif.error(localize('chipos.mcpServers.start.fail', 'Could not start {0}: {1}', name, String(err)));
		}
	}

	// ── worker-side rows ───────────────────────────────────────────────────

	private _renderWorkerRow(parent: HTMLElement, server: McpServerConfig): void {
		const health = this._workerHealth(server);
		const row = this._beginRow(parent, health, server.name, false);
		const toolCount = server.provides?.length ?? server.health?.provides_count ?? 0;
		this._appendMeta(row, server.transport || 'stdio', toolCount, 'worker');
		this._appendBadge(row, health, this._workerStatusLabel(server));

		const actions = dom.append(row, dom.$('.chipos-mcp-tab-row-actions'));
		if (health === 'running') {
			this._actionButton(actions, 'codicon-gear', localize('chipos.mcpServers.configure', 'Configure'), () => {
				// Worker servers are configured in the worker mcp.json; the EDA
				// Tools tab owns the rich editor. Surface their config path here.
				this._notif.info(localize('chipos.mcpServers.worker.configure',
					'{0} is a worker MCP server — manage it from the EDA Tools tab.', server.name));
			});
			this._actionButton(actions, 'codicon-debug-stop', localize('chipos.mcpServers.stop', 'Stop'), () => {
				void this._setWorkerEnabled(server, false);
			});
		} else if (health === 'error') {
			this._actionButton(actions, 'codicon-output', localize('chipos.mcpServers.logs', 'Logs'), () => {
				// No streaming log channel for worker servers yet — surface the
				// cached health error (full handshake log is in the worker
				// output channel).
				this._notif.info(localize('chipos.mcpServers.worker.logs', '{0}: {1}',
					server.name, this._workerErrorText(server)));
			});
			this._actionButton(actions, 'codicon-refresh', localize('chipos.mcpServers.retry', 'Retry'), () => {
				void this._retryWorkerServer(server);
			});
		} else {
			this._actionButton(actions, 'codicon-play', localize('chipos.mcpServers.start', 'Start'), () => {
				void this._startWorkerServer(server);
			});
		}
	}

	/** Trust-gate then (re-)enable a disabled worker server. */
	private async _startWorkerServer(server: McpServerConfig): Promise<void> {
		const toolCount = server.provides?.length ?? server.health?.provides_count ?? 0;
		const ok = await this._confirmTrust(server.name, toolCount);
		if (!ok) { return; }
		await this._setWorkerEnabled(server, true);
	}

	/**
	 * Enable/disable a worker server via an idempotent upsert (the worker skips
	 * disabled servers at load time but keeps their config). Re-fetches the list
	 * afterwards so the row's health + actions update.
	 */
	private async _setWorkerEnabled(server: McpServerConfig, enabled: boolean): Promise<void> {
		try {
			await this._toolManager.addMcpServer({ ...server, enabled });
		} catch (err) {
			this._notif.error(localize('chipos.mcpServers.worker.toggleFail',
				'Could not {0} {1}: {2}',
				enabled
					? localize('chipos.mcpServers.verb.start', 'start')
					: localize('chipos.mcpServers.verb.stop', 'stop'),
				server.name, String(err)));
		}
		await this._refreshWorkerServers();
	}

	/** Re-run the MCP handshake for a failed worker server via idempotent upsert. */
	private async _retryWorkerServer(server: McpServerConfig): Promise<void> {
		try {
			await this._toolManager.addMcpServer({ ...server, enabled: true });
		} catch (err) {
			this._notif.error(localize('chipos.mcpServers.worker.retryFail',
				'Retry failed for {0}: {1}', server.name, String(err)));
		}
		await this._refreshWorkerServers();
	}

	// ── shared row builders ────────────────────────────────────────────────

	/** Build a row up to (but not including) the meta/badge/actions. */
	private _beginRow(parent: HTMLElement, health: ServerHealth, name: string, starting: boolean): HTMLElement {
		const row = dom.append(parent, dom.$(`.chipos-mcp-tab-row.${health}`));

		// Health dot — filled green (running), hollow tertiary (stopped),
		// filled red (error). A starting server shows a spinning dot.
		const dotIcon = starting
			? 'codicon-loading codicon-modifier-spin'
			: health === 'running'
				? 'codicon-circle-filled'
				: health === 'error'
					? 'codicon-circle-filled'
					: 'codicon-circle-large';
		const dot = dom.append(row, dom.$(`span.codicon.${dotIcon}.chipos-mcp-tab-dot.${health}`));
		dot.title = this._healthTitle(health);

		const main = dom.append(row, dom.$('.chipos-mcp-tab-row-main'));
		const nameLine = dom.append(main, dom.$('.chipos-mcp-tab-row-nameline'));
		dom.append(nameLine, dom.$('.chipos-mcp-tab-row-name', undefined, name));
		// Meta line is appended by the caller into `.row-main` via _appendMeta.
		return row;
	}

	private _appendMeta(row: HTMLElement, transport: string, toolCount: number, side: ServerSide): void {
		const main = row.querySelector('.chipos-mcp-tab-row-main');
		if (!(main instanceof HTMLElement)) { return; }
		const sideLabel = side === 'ide'
			? localize('chipos.mcpServers.side.ide', 'IDE')
			: localize('chipos.mcpServers.side.worker', 'worker');
		const toolsLabel = toolCount === 1
			? localize('chipos.mcpServers.tool.one', '1 tool')
			: localize('chipos.mcpServers.tool.many', '{0} tools', toolCount);
		const meta = dom.append(main, dom.$('.chipos-mcp-tab-row-meta'));
		meta.textContent = localize('chipos.mcpServers.metaLine', '{0} · {1} · {2}', transport, toolsLabel, sideLabel);
		meta.title = meta.textContent;
	}

	private _appendBadge(row: HTMLElement, health: ServerHealth, label: string): void {
		const badge = dom.append(row, dom.$(`.chipos-mcp-tab-badge.${health}`));
		badge.textContent = label;
		badge.title = label;
	}

	private _actionButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const btn = dom.append(parent, dom.$('button.chipos-btn-secondary.chipos-mcp-tab-rowbtn')) as HTMLButtonElement;
		dom.append(btn, dom.$(`span.codicon.${icon}`));
		dom.append(btn, dom.$('span', undefined, label));
		this._rowDisposables.add(dom.addDisposableListener(btn, 'click', onClick));
	}

	// ── trust gate ─────────────────────────────────────────────────────────

	/**
	 * Permission gate shown before enabling/trusting a server: a modal
	 * confirmation naming the server + the tool count it will expose. Returns
	 * true when the user confirms.
	 */
	private async _confirmTrust(name: string, toolCount: number): Promise<boolean> {
		const detail = toolCount === 1
			? localize('chipos.mcpServers.trust.detail.one', 'It will expose 1 tool the agent can call.')
			: localize('chipos.mcpServers.trust.detail.many', 'It will expose {0} tools the agent can call.', toolCount);
		const { confirmed } = await this._dialogService.confirm({
			message: localize('chipos.mcpServers.trust.message', 'Trust {0}?', name),
			detail,
			primaryButton: localize('chipos.mcpServers.trust.confirm', 'Trust & Start'),
		});
		return confirmed;
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private _ideHealth(kind: McpConnectionState.Kind): ServerHealth {
		switch (kind) {
			case McpConnectionState.Kind.Running:
			case McpConnectionState.Kind.Starting:
				return 'running';
			case McpConnectionState.Kind.Error:
				return 'error';
			default:
				return 'stopped';
		}
	}

	private _workerHealth(server: McpServerConfig): ServerHealth {
		if (server.enabled === false) { return 'stopped'; }
		const status = server.health?.status;
		switch (status) {
			case 'connected':
			case 'no_tools':
				return 'running';
			case 'handshake_failed':
			case 'unreachable':
				return 'error';
			default:
				// `unknown` / undefined — probe hasn't run yet. Treat as stopped
				// so the user gets a Start affordance rather than a false green.
				return 'stopped';
		}
	}

	private _workerStatusLabel(server: McpServerConfig): string {
		if (server.enabled === false) {
			return localize('chipos.mcpServers.worker.disabled', 'Disabled');
		}
		switch (server.health?.status) {
			case 'connected':
				return localize('chipos.mcpServers.worker.connected', 'Connected');
			case 'no_tools':
				return localize('chipos.mcpServers.worker.noTools', 'No tools');
			case 'handshake_failed':
				return localize('chipos.mcpServers.worker.handshake', 'Handshake failed');
			case 'unreachable':
				return localize('chipos.mcpServers.worker.unreachable', 'Unreachable');
			default:
				return localize('chipos.mcpServers.worker.unknown', 'Not checked');
		}
	}

	private _workerErrorText(server: McpServerConfig): string {
		const base = this._workerStatusLabel(server);
		return server.health?.error ? `${base} — ${server.health.error}` : base;
	}

	private _healthTitle(health: ServerHealth): string {
		switch (health) {
			case 'running':
				return localize('chipos.mcpServers.dot.running', 'Running');
			case 'error':
				return localize('chipos.mcpServers.dot.error', 'Error');
			default:
				return localize('chipos.mcpServers.dot.stopped', 'Stopped');
		}
	}
}
