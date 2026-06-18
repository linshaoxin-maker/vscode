/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * "EDA Doctor" settings tab — Phase 6 (IDE-only EDA workbench), first slice.
 *
 * A one-click health-check surface for the EDA toolchain, and the home for
 * adding your own tools. Where {@link EdaToolsTab} is the dense
 * power-user table (strategy radios + per-tool source overrides + MCP
 * server management), this tab is the friendly, actionable triage view:
 *
 *   - 4 metric cards (Tools / Ready / Missing / Issues)
 *   - "Needs attention" — missing / not-on-PATH tools with a prominent
 *     Install button (+ Locate… for not-on-PATH)
 *   - "Ready" — resolved+working tools (Test) + user-added custom tools
 *     (custom badge + Edit / Remove)
 *   - "Connection issue" — MCP servers whose health probe failed
 *     (Logs / Reconnect)
 *
 * Data is a live read from the same {@link IWorkerToolManagerService} the
 * EDA Tools tab uses — `getEdaToolResolutions()` for the per-tool resolution
 * and `listMcpServers()` for MCP health. No new DI service. Custom tools are
 * stored under `chipos.eda.tools.<name>` (the same config the EDA Tools tab,
 * worker resolver and panel actions all read), so the two tabs stay in sync.
 */

import './edaToolsDoctorTab.css';

import * as dom from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import {
	EdaResolutionsResponse,
	EdaToolResolution,
	IWorkerToolManagerService,
	McpServerConfig,
	McpServerListResult,
} from '../../../../../../workbench/contrib/chipos/browser/workerToolManager.js';

/** Source of a tool row as surfaced via the source badge. */
type DoctorSourceBadge = 'managed' | 'local' | 'mcp' | 'custom';

/** The user-added (custom) tool config shape written under `chipos.eda.tools.<name>`. */
interface CustomToolEntry {
	source?: 'auto' | 'managed' | 'local' | 'mcp' | 'manual' | 'disabled';
	path?: string;
	mcpServer?: string;
}

export class EdaToolsDoctorTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	// Per-render listeners (Install / Test / Edit / Remove / Logs / Reconnect)
	// are re-created on every re-scan, so they live in a store that is cleared
	// at the top of each render — not on the class-level `_disposables`, which
	// would leak one listener set per re-scan until the tab closes.
	private readonly _rowDisposables = this._register(new DisposableStore());

	private _bodyEl: HTMLElement | undefined;
	private _rescanBtn: HTMLButtonElement | undefined;
	private _loading = false;

	constructor(
		private readonly _container: HTMLElement,
		@IWorkerToolManagerService private readonly _toolManager: IWorkerToolManagerService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@INotificationService private readonly _notif: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._render();
		// Re-render whenever the EDA settings change (so a custom tool added in
		// the EDA Tools tab, or an external settings.json edit, surfaces here).
		this._disposables.add(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.eda')) {
				this._refreshLiveData();
			}
		}));
	}

	// ── scaffold ─────────────────────────────────────────────────────────────

	private _render(): void {
		this._renderHeader();

		// Body holds the metric cards + the three grouped sections. It is
		// rebuilt on every re-scan, so all the live content lives here.
		this._bodyEl = dom.append(this._container, dom.$('.chipos-eda-doctor-body'));

		this._refreshLiveData();
	}

	private _renderHeader(): void {
		const header = dom.append(this._container, dom.$('.chipos-eda-doctor-header'));

		const titleWrap = dom.append(header, dom.$('.chipos-eda-doctor-titlewrap'));
		dom.append(titleWrap, dom.$('span.codicon.codicon-pulse.chipos-eda-doctor-title-icon'));
		const titleText = dom.append(titleWrap, dom.$('.chipos-eda-doctor-titletext'));
		dom.append(titleText, dom.$('.chipos-eda-doctor-title', undefined,
			localize('chipos.edaDoctor.title', 'EDA toolchain doctor')));
		dom.append(titleText, dom.$('.chipos-eda-doctor-subtitle', undefined,
			localize('chipos.edaDoctor.subtitle', 'One-click health check — and the home for adding your own tools')));

		const actions = dom.append(header, dom.$('.chipos-eda-doctor-headeractions'));

		const rescanBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-headerbtn')) as HTMLButtonElement;
		dom.append(rescanBtn, dom.$('span.codicon.codicon-refresh'));
		dom.append(rescanBtn, dom.$('span', undefined, localize('chipos.edaDoctor.rescan', 'Re-scan')));
		rescanBtn.title = localize('chipos.edaDoctor.rescan.tooltip',
			'Re-scan worker PATH + MCP server tools/list. Picks up newly-installed binaries without restarting the worker.');
		this._disposables.add(dom.addDisposableListener(rescanBtn, 'click', async () => {
			await this._commandService.executeCommand('chipos.eda.rescan');
			await this._refreshLiveData();
		}));
		this._rescanBtn = rescanBtn;

		const addBtn = dom.append(actions, dom.$('button.chipos-eda-doctor-addbtn')) as HTMLButtonElement;
		dom.append(addBtn, dom.$('span.codicon.codicon-add'));
		dom.append(addBtn, dom.$('span', undefined, localize('chipos.edaDoctor.addTool', 'Add tool')));
		addBtn.title = localize('chipos.edaDoctor.addTool.tooltip',
			'Register a custom EDA tool (managed, a local binary, or an MCP server).');
		this._disposables.add(dom.addDisposableListener(addBtn, 'click', () => this._addToolFlow()));
	}

	// ── data fetch ───────────────────────────────────────────────────────────

	private async _refreshLiveData(): Promise<void> {
		if (!this._bodyEl) { return; }
		this._loading = true;
		this._renderLoading();
		if (this._rescanBtn) { this._rescanBtn.disabled = true; }

		const strategy = this._configService.getValue<string>('chipos.eda.defaultStrategy') ?? 'auto';
		// Forward per-tool path overrides so the worker resolver honors
		// `chipos.eda.tools.<name>.path` (custom local tools), matching the EDA
		// Tools tab transport. Only forward when source explicitly opts into a
		// local path so source=auto stays "let strategy decide".
		const toolsSetting = this._configService.getValue<Record<string, CustomToolEntry>>('chipos.eda.tools') ?? {};
		const overrides: Record<string, string> = {};
		for (const [name, entry] of Object.entries(toolsSetting)) {
			if (entry && entry.path && (entry.source === 'local' || entry.source === 'manual')) {
				overrides[name] = entry.path;
			}
		}

		const [resOk, srvOk] = await Promise.allSettled([
			this._toolManager.getEdaToolResolutions(strategy, overrides),
			this._toolManager.listMcpServers(),
		]);

		this._loading = false;
		if (this._rescanBtn) { this._rescanBtn.disabled = false; }

		const resolutions = resOk.status === 'fulfilled' ? resOk.value : undefined;
		const servers = srvOk.status === 'fulfilled' ? srvOk.value : undefined;
		if (resOk.status === 'rejected') {
			this._log.warn('[EdaToolsDoctorTab] getEdaToolResolutions failed:', String(resOk.reason));
		}
		if (srvOk.status === 'rejected') {
			this._log.warn('[EdaToolsDoctorTab] listMcpServers failed:', String(srvOk.reason));
		}
		this._renderContent(resolutions, servers);
	}

	// ── render ───────────────────────────────────────────────────────────────

	private _renderLoading(): void {
		if (!this._bodyEl) { return; }
		dom.clearNode(this._bodyEl);
		this._rowDisposables.clear();
		const wrap = dom.append(this._bodyEl, dom.$('.chipos-eda-doctor-loading'));
		dom.append(wrap, dom.$('span.codicon.codicon-loading.codicon-modifier-spin'));
		dom.append(wrap, dom.$('span', undefined, localize('chipos.edaDoctor.scanning', 'Scanning toolchain…')));
	}

	private _renderContent(resolutions: EdaResolutionsResponse | undefined, servers: McpServerListResult | undefined): void {
		if (!this._bodyEl || this._loading) { return; }
		dom.clearNode(this._bodyEl);
		this._rowDisposables.clear();

		if (!resolutions && !servers) {
			this._renderEmpty(localize('chipos.edaDoctor.unreachable',
				'Could not reach the worker to scan the toolchain. Make sure a workspace is open, then re-scan.'));
			return;
		}

		const allTools = resolutions ? Object.values(resolutions.by_tool) : [];
		const customNames = new Set(Object.keys(this._getCustomTools()));

		// Partition the tools into the three actionable buckets.
		const needsAttention = allTools.filter(t => !t.ready);
		const ready = allTools.filter(t => t.ready);
		const failedServers = (servers?.servers ?? []).filter(s => this._isServerFailed(s));

		if (allTools.length === 0 && failedServers.length === 0) {
			this._renderEmpty(localize('chipos.edaDoctor.empty',
				'No EDA tools registered yet. Click "Add tool" to register your first one.'));
			return;
		}

		// ── Metric cards ──
		const issues = failedServers.length;
		this._renderMetricCards(allTools.length, ready.length, needsAttention.length, issues);

		// ── Section 1: Needs attention (amber, actionable first) ──
		if (needsAttention.length > 0) {
			const section = this._renderSectionHeader('warn',
				localize('chipos.edaDoctor.needsAttention', 'Needs attention'), needsAttention.length);
			for (const t of needsAttention) {
				this._renderToolRow(section, t, false);
			}
		}

		// ── Section 2: Ready (green) ──
		if (ready.length > 0) {
			const section = this._renderSectionHeader('ok',
				localize('chipos.edaDoctor.ready', 'Ready'), ready.length);
			for (const t of ready) {
				this._renderToolRow(section, t, customNames.has(t.tool_name));
			}
		}

		// ── Section 3: Connection issue (red) ──
		if (failedServers.length > 0) {
			const section = this._renderSectionHeader('err',
				localize('chipos.edaDoctor.connectionIssue', 'Connection issue'), failedServers.length);
			for (const s of failedServers) {
				this._renderServerRow(section, s);
			}
		}
	}

	private _renderEmpty(message: string): void {
		if (!this._bodyEl) { return; }
		const empty = dom.append(this._bodyEl, dom.$('.chipos-eda-doctor-emptystate'));
		dom.append(empty, dom.$('span.codicon.codicon-pulse.chipos-eda-doctor-emptyicon'));
		dom.append(empty, dom.$('span', undefined, message));
	}

	private _renderMetricCards(total: number, ready: number, missing: number, issues: number): void {
		if (!this._bodyEl) { return; }
		const row = dom.append(this._bodyEl, dom.$('.chipos-eda-doctor-metrics'));
		const card = (kind: string, count: number, label: string) => {
			const c = dom.append(row, dom.$(`.chipos-eda-doctor-metric.${kind}`));
			dom.append(c, dom.$('.chipos-eda-doctor-metric-count', undefined, String(count)));
			dom.append(c, dom.$('.chipos-eda-doctor-metric-label', undefined, label));
		};
		card('total', total, localize('chipos.edaDoctor.metric.tools', 'Tools'));
		card('ok', ready, localize('chipos.edaDoctor.metric.ready', 'Ready'));
		card('warn', missing, localize('chipos.edaDoctor.metric.missing', 'Missing'));
		card('err', issues, localize('chipos.edaDoctor.metric.issues', 'Issues'));
	}

	/**
	 * Render a grouped section card + its colored header (amber/green/red) and
	 * return the rows container the section's rows should be appended into.
	 */
	private _renderSectionHeader(tone: 'ok' | 'warn' | 'err', title: string, count: number): HTMLElement {
		if (!this._bodyEl) { return this._container; }
		const section = dom.append(this._bodyEl, dom.$(`.chipos-eda-doctor-section.${tone}`));
		const header = dom.append(section, dom.$('.chipos-eda-doctor-section-header'));
		dom.append(header, dom.$('.chipos-eda-doctor-section-title', undefined, title));
		dom.append(header, dom.$('.chipos-eda-doctor-section-count', undefined, `· ${count}`));
		return dom.append(section, dom.$('.chipos-eda-doctor-rows'));
	}

	// ── tool rows ──────────────────────────────────────────────────────────

	private _renderToolRow(parent: HTMLElement, r: EdaToolResolution, isCustom: boolean): void {
		const row = dom.append(parent, dom.$('.chipos-eda-doctor-row'));
		if (isCustom) { row.classList.add('custom'); }

		// Status icon — green check (ready) / amber alert (needs attention).
		const statusKind = r.ready ? 'ok' : 'warn';
		const statusIcon = r.ready ? 'codicon-pass-filled' : 'codicon-warning';
		const iconEl = dom.append(row, dom.$(`span.codicon.${statusIcon}.chipos-eda-doctor-row-icon.${statusKind}`));
		iconEl.title = r.ready
			? localize('chipos.edaDoctor.statusReady', 'Ready')
			: localize('chipos.edaDoctor.statusMissing', 'Missing');

		// Main column — name (+ "your tool" hint) + detail line.
		const main = dom.append(row, dom.$('.chipos-eda-doctor-row-main'));
		const nameLine = dom.append(main, dom.$('.chipos-eda-doctor-row-nameline'));
		dom.append(nameLine, dom.$('.chipos-eda-doctor-row-name', undefined, r.tool_name));
		if (isCustom) {
			dom.append(nameLine, dom.$('.chipos-eda-doctor-row-hint', undefined,
				localize('chipos.edaDoctor.yourTool', '— your tool')));
		}
		const detail = dom.append(main, dom.$('.chipos-eda-doctor-row-detail'));
		detail.textContent = this._formatToolDetail(r);
		detail.title = detail.textContent;

		// Source badge.
		this._renderSourceBadge(row, isCustom ? 'custom' : this._badgeForImpl(r.impl));

		// Right-aligned actions.
		const actions = dom.append(row, dom.$('.chipos-eda-doctor-row-actions'));
		if (isCustom) {
			this._renderEditButton(actions, r.tool_name);
			this._renderRemoveButton(actions, r.tool_name);
		} else if (r.ready) {
			this._renderTestButton(actions, r.tool_name);
		} else {
			if (this._isNotOnPath(r)) {
				this._renderLocateButton(actions, r.tool_name);
			}
			this._renderInstallButton(actions, r.tool_name);
		}
	}

	private _renderServerRow(parent: HTMLElement, srv: McpServerConfig): void {
		const row = dom.append(parent, dom.$('.chipos-eda-doctor-row'));
		const iconEl = dom.append(row, dom.$('span.codicon.codicon-debug-disconnect.chipos-eda-doctor-row-icon.err'));
		iconEl.title = localize('chipos.edaDoctor.statusDisconnected', 'Connection failed');

		const main = dom.append(row, dom.$('.chipos-eda-doctor-row-main'));
		const nameLine = dom.append(main, dom.$('.chipos-eda-doctor-row-nameline'));
		dom.append(nameLine, dom.$('.chipos-eda-doctor-row-name', undefined, srv.name));
		const detail = dom.append(main, dom.$('.chipos-eda-doctor-row-detail.err'));
		detail.textContent = this._formatServerError(srv);
		detail.title = detail.textContent;

		this._renderSourceBadge(row, 'mcp');

		const actions = dom.append(row, dom.$('.chipos-eda-doctor-row-actions'));
		const logsBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-rowbtn')) as HTMLButtonElement;
		dom.append(logsBtn, dom.$('span.codicon.codicon-output'));
		dom.append(logsBtn, dom.$('span', undefined, localize('chipos.edaDoctor.logs', 'Logs')));
		this._rowDisposables.add(dom.addDisposableListener(logsBtn, 'click', () => {
			// Surface the cached health error; the worker output channel holds
			// the full handshake log.
			this._notif.info(localize('chipos.edaDoctor.logs.info', '{0}: {1}', srv.name, this._formatServerError(srv)));
		}));

		const reconnectBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-rowbtn')) as HTMLButtonElement;
		dom.append(reconnectBtn, dom.$('span.codicon.codicon-refresh'));
		dom.append(reconnectBtn, dom.$('span', undefined, localize('chipos.edaDoctor.reconnect', 'Reconnect')));
		this._rowDisposables.add(dom.addDisposableListener(reconnectBtn, 'click', async () => {
			try {
				// An idempotent upsert re-spawns the server + re-runs the MCP
				// handshake; the health probe then re-evaluates on next scan.
				await this._toolManager.addMcpServer(srv);
			} catch (err) {
				this._notif.error(localize('chipos.edaDoctor.reconnect.fail', 'Reconnect failed: {0}', String(err)));
			}
			await this._commandService.executeCommand('chipos.eda.rescan');
			await this._refreshLiveData();
		}));
	}

	// ── per-row action buttons ───────────────────────────────────────────────

	private _renderInstallButton(parent: HTMLElement, toolName: string): void {
		const btn = dom.append(parent, dom.$('button.chipos-eda-doctor-installbtn')) as HTMLButtonElement;
		dom.append(btn, dom.$('span.codicon.codicon-cloud-download'));
		dom.append(btn, dom.$('span', undefined, localize('chipos.edaDoctor.install', 'Install')));
		this._rowDisposables.add(dom.addDisposableListener(btn, 'click', async () => {
			btn.disabled = true;
			try {
				const res = await this._toolManager.installTool(toolName, 'eda_pack');
				if (res.success) {
					this._notif.info(localize('chipos.edaDoctor.install.done', '{0} installed.', toolName));
				} else if (res.manual_required && res.vendor_url) {
					this._notif.warn(localize('chipos.edaDoctor.install.manual',
						'{0} needs a manual vendor install: {1}', toolName, res.vendor_url));
				} else {
					this._notif.warn(localize('chipos.edaDoctor.install.fail',
						'Could not install {0}: {1}', toolName, res.error ?? res.message ?? 'unknown'));
				}
			} catch (err) {
				this._notif.error(localize('chipos.edaDoctor.install.error', 'Install error: {0}', String(err)));
			}
			await this._commandService.executeCommand('chipos.eda.rescan');
			await this._refreshLiveData();
		}));
	}

	private _renderLocateButton(parent: HTMLElement, toolName: string): void {
		const btn = dom.append(parent, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-rowbtn')) as HTMLButtonElement;
		dom.append(btn, dom.$('span.codicon.codicon-search'));
		dom.append(btn, dom.$('span', undefined, localize('chipos.edaDoctor.locate', 'Locate…')));
		this._rowDisposables.add(dom.addDisposableListener(btn, 'click', async () => {
			const path = await this._quickInput.input({
				title: localize('chipos.edaDoctor.locate.title', 'Absolute path to the {0} binary', toolName),
				placeHolder: localize('chipos.edaDoctor.locate.placeholder', '/usr/local/bin/{0}', toolName),
				validateInput: async value => value && !value.startsWith('/')
					? localize('chipos.edaDoctor.locate.validate', 'Enter an absolute path (starting with /).')
					: undefined,
			});
			if (!path) { return; }
			await this._writeCustomTool(toolName, { source: 'local', path });
			this._notif.info(localize('chipos.edaDoctor.locate.done', '{0} set to local: {1}. Re-scanning…', toolName, path));
			await this._commandService.executeCommand('chipos.eda.rescan');
			await this._refreshLiveData();
		}));
	}

	private _renderTestButton(parent: HTMLElement, toolName: string): void {
		const btn = dom.append(parent, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-rowbtn')) as HTMLButtonElement;
		dom.append(btn, dom.$('span.codicon.codicon-play'));
		dom.append(btn, dom.$('span', undefined, localize('chipos.edaDoctor.test', 'Test')));
		this._rowDisposables.add(dom.addDisposableListener(btn, 'click', async () => {
			// Reuse the existing tool-test action (exec `<binary> --version` via
			// the worker), keyed by the same `impl-tool:<name>` handle the EDA
			// Tools tab + panel menu use.
			await this._commandService.executeCommand('chipos.eda.tool.test', { $treeItemHandle: `impl-tool:${toolName}` });
		}));
	}

	private _renderEditButton(parent: HTMLElement, toolName: string): void {
		const btn = dom.append(parent, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-rowbtn')) as HTMLButtonElement;
		dom.append(btn, dom.$('span.codicon.codicon-edit'));
		dom.append(btn, dom.$('span', undefined, localize('chipos.edaDoctor.edit', 'Edit')));
		this._rowDisposables.add(dom.addDisposableListener(btn, 'click', () => this._editCustomTool(toolName)));
	}

	private _renderRemoveButton(parent: HTMLElement, toolName: string): void {
		const btn = dom.append(parent, dom.$('button.chipos-btn-secondary.chipos-eda-doctor-rowbtn.danger')) as HTMLButtonElement;
		dom.append(btn, dom.$('span.codicon.codicon-trash'));
		dom.append(btn, dom.$('span', undefined, localize('chipos.edaDoctor.remove', 'Remove')));
		this._rowDisposables.add(dom.addDisposableListener(btn, 'click', () => this._removeCustomTool(toolName)));
	}

	private _renderSourceBadge(parent: HTMLElement, source: DoctorSourceBadge): void {
		const labels: Record<DoctorSourceBadge, string> = {
			managed: localize('chipos.edaDoctor.badge.managed', 'managed'),
			local: localize('chipos.edaDoctor.badge.local', 'local'),
			mcp: localize('chipos.edaDoctor.badge.mcp', 'mcp'),
			custom: localize('chipos.edaDoctor.badge.custom', 'custom'),
		};
		dom.append(parent, dom.$(`.chipos-eda-doctor-badge.${source}`, undefined, labels[source]));
	}

	// ── add / edit / remove custom tools ─────────────────────────────────────

	/**
	 * "Add tool" flow:
	 *   1. input tool name
	 *   2. pick source (managed / local / mcp)
	 *   3. if local: input absolute binary path
	 *      if mcp: add a new MCP server (existing command) or pick an existing one
	 *   → write `chipos.eda.tools.<name>` = { source, path?, mcpServer? } then re-scan.
	 */
	private async _addToolFlow(): Promise<void> {
		const name = await this._quickInput.input({
			title: localize('chipos.edaDoctor.add.nameTitle', 'Name of the EDA tool to add'),
			placeHolder: localize('chipos.edaDoctor.add.namePlaceholder', 'e.g. my_synthesizer'),
			validateInput: async value => {
				if (!value || !value.trim()) {
					return localize('chipos.edaDoctor.add.nameEmpty', 'Enter a tool name.');
				}
				if (this._getCustomTools()[value.trim()]) {
					return localize('chipos.edaDoctor.add.nameExists', '"{0}" is already registered.', value.trim());
				}
				return undefined;
			},
		});
		if (!name) { return; }
		const toolName = name.trim();

		const sourcePick = await this._quickInput.pick([
			{ label: 'managed', description: localize('chipos.edaDoctor.add.srcManaged', 'ChipOS-managed (oss-cad-suite)') },
			{ label: 'local', description: localize('chipos.edaDoctor.add.srcLocal', 'A binary already on this machine') },
			{ label: 'mcp', description: localize('chipos.edaDoctor.add.srcMcp', 'A remote MCP server') },
		], { title: localize('chipos.edaDoctor.add.srcTitle', 'Where does {0} come from?', toolName) });
		if (!sourcePick) { return; }
		const source = sourcePick.label as 'managed' | 'local' | 'mcp';

		const entry: CustomToolEntry = { source };
		if (source === 'local') {
			const path = await this._quickInput.input({
				title: localize('chipos.edaDoctor.add.pathTitle', 'Absolute path to the {0} binary', toolName),
				placeHolder: localize('chipos.edaDoctor.add.pathPlaceholder', '/usr/local/bin/{0}', toolName),
				validateInput: async value => value && !value.startsWith('/')
					? localize('chipos.edaDoctor.add.pathValidate', 'Enter an absolute path (starting with /).')
					: undefined,
			});
			if (!path) { return; }
			entry.path = path;
		} else if (source === 'mcp') {
			const server = await this._pickOrAddMcpServer();
			if (server === undefined) { return; }
			if (server) { entry.mcpServer = server; }
		}

		await this._writeCustomTool(toolName, entry);
		this._notif.info(localize('chipos.edaDoctor.add.done', 'Added "{0}". Re-scanning…', toolName));
		await this._commandService.executeCommand('chipos.eda.rescan');
		await this._refreshLiveData();
	}

	/**
	 * For the mcp source: let the user either add a brand-new MCP server (via
	 * the existing `chipos.workerTools.addMcpServer` command) or pick one that
	 * already exists. Returns the chosen server name, '' for "any server", or
	 * `undefined` if the user cancelled.
	 */
	private async _pickOrAddMcpServer(): Promise<string | undefined> {
		let servers: McpServerConfig[] = [];
		try {
			servers = (await this._toolManager.listMcpServers()).servers;
		} catch (err) {
			this._log.warn('[EdaToolsDoctorTab] listMcpServers (add flow) failed:', String(err));
		}
		const items: { label: string; id: string; description?: string }[] = [
			{ label: localize('chipos.edaDoctor.add.mcpNew', '$(add) Add a new MCP server…'), id: '__add__' },
			...servers.map(s => ({ label: s.name, id: s.name, description: s.transport ?? 'stdio' })),
		];
		const picked = await this._quickInput.pick(items, {
			title: localize('chipos.edaDoctor.add.mcpTitle', 'Which MCP server provides this tool?'),
		});
		if (!picked) { return undefined; }
		if (picked.id === '__add__') {
			await this._commandService.executeCommand('chipos.workerTools.addMcpServer');
			// The freshly-added server name isn't returned by the command, so
			// leave mcpServer unset → resolver matches across all servers.
			return '';
		}
		return picked.id;
	}

	private async _editCustomTool(toolName: string): Promise<void> {
		const existing = this._getCustomTools()[toolName] ?? {};
		const source = existing.source ?? 'local';
		if (source === 'local') {
			const path = await this._quickInput.input({
				title: localize('chipos.edaDoctor.edit.pathTitle', 'Absolute path to the {0} binary', toolName),
				value: existing.path ?? '',
				validateInput: async value => value && !value.startsWith('/')
					? localize('chipos.edaDoctor.edit.pathValidate', 'Enter an absolute path (starting with /).')
					: undefined,
			});
			if (!path) { return; }
			await this._writeCustomTool(toolName, { ...existing, source: 'local', path });
		} else if (source === 'mcp') {
			const server = await this._pickOrAddMcpServer();
			if (server === undefined) { return; }
			await this._writeCustomTool(toolName, { ...existing, source: 'mcp', mcpServer: server || undefined });
		} else {
			// managed (or auto): nothing path-shaped to edit — just confirm source.
			const sourcePick = await this._quickInput.pick([
				{ label: 'managed', description: localize('chipos.edaDoctor.add.srcManaged', 'ChipOS-managed (oss-cad-suite)') },
				{ label: 'local', description: localize('chipos.edaDoctor.add.srcLocal', 'A binary already on this machine') },
				{ label: 'mcp', description: localize('chipos.edaDoctor.add.srcMcp', 'A remote MCP server') },
			], { title: localize('chipos.edaDoctor.edit.srcTitle', 'Source for {0}', toolName) });
			if (!sourcePick) { return; }
			await this._writeCustomTool(toolName, { ...existing, source: sourcePick.label as CustomToolEntry['source'] });
		}
		this._notif.info(localize('chipos.edaDoctor.edit.done', 'Updated "{0}". Re-scanning…', toolName));
		await this._commandService.executeCommand('chipos.eda.rescan');
		await this._refreshLiveData();
	}

	private async _removeCustomTool(toolName: string): Promise<void> {
		const confirm = await this._quickInput.pick([
			{ label: localize('chipos.edaDoctor.remove.confirm', 'Remove "{0}"', toolName) },
			{ label: localize('chipos.edaDoctor.remove.cancel', 'Cancel') },
		], { title: localize('chipos.edaDoctor.remove.title', 'Remove the custom tool "{0}"?', toolName) });
		if (!confirm || confirm.label.includes('Cancel')) { return; }
		const current = this._getCustomTools();
		const next = { ...current };
		delete next[toolName];
		await this._configService.updateValue('chipos.eda.tools', next, ConfigurationTarget.APPLICATION);
		this._notif.info(localize('chipos.edaDoctor.remove.done', 'Removed "{0}". Re-scanning…', toolName));
		await this._commandService.executeCommand('chipos.eda.rescan');
		await this._refreshLiveData();
	}

	/** Merge an entry into `chipos.eda.tools.<name>` at APPLICATION scope. */
	private async _writeCustomTool(toolName: string, entry: CustomToolEntry): Promise<void> {
		const current = this._getCustomTools();
		const next = { ...current, [toolName]: { ...current[toolName], ...entry } };
		await this._configService.updateValue('chipos.eda.tools', next, ConfigurationTarget.APPLICATION);
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private _getCustomTools(): Record<string, CustomToolEntry> {
		const all = this._configService.getValue<Record<string, CustomToolEntry>>('chipos.eda.tools');
		return (all && typeof all === 'object') ? all : {};
	}

	private _badgeForImpl(impl: EdaToolResolution['impl']): DoctorSourceBadge {
		switch (impl) {
			case 'managed': return 'managed';
			case 'mcp': return 'mcp';
			case 'local-binary': return 'local';
			default: return 'managed';
		}
	}

	/**
	 * A "not on PATH" tool is one the user explicitly pointed at a local source
	 * but the worker still couldn't resolve — i.e. the binary path needs
	 * re-locating. Plain missing/managed tools get Install instead.
	 */
	private _isNotOnPath(r: EdaToolResolution): boolean {
		if (r.ready) { return false; }
		const override = this._getCustomTools()[r.tool_name];
		return override?.source === 'local' || override?.source === 'manual';
	}

	private _formatToolDetail(r: EdaToolResolution): string {
		const version = r.detail.version ? `${r.detail.version} · ` : '';
		switch (r.impl) {
			case 'managed':
				return version + (r.detail.path ?? localize('chipos.edaDoctor.detail.managedBundle', 'via oss-cad-suite'));
			case 'local-binary':
				return version + (r.detail.path ?? localize('chipos.edaDoctor.detail.localPath', 'via system PATH'));
			case 'mcp':
				return r.detail.server_name
					? localize('chipos.edaDoctor.detail.mcp', 'via {0}', r.detail.server_name)
					: localize('chipos.edaDoctor.detail.mcpAny', 'via MCP server');
			case 'missing':
				return r.detail.hint
					? r.detail.hint.slice(0, 90) + (r.detail.hint.length > 90 ? '…' : '')
					: localize('chipos.edaDoctor.detail.notFound', 'Not found — install or locate the binary.');
			default:
				return '';
		}
	}

	private _isServerFailed(srv: McpServerConfig): boolean {
		const status = srv.health?.status;
		return status === 'handshake_failed' || status === 'unreachable';
	}

	private _formatServerError(srv: McpServerConfig): string {
		const status = srv.health?.status;
		const base = status === 'unreachable'
			? localize('chipos.edaDoctor.server.unreachable', 'Unreachable')
			: localize('chipos.edaDoctor.server.handshake', 'Handshake failed');
		return srv.health?.error ? `${base} — ${srv.health.error}` : base;
	}
}
