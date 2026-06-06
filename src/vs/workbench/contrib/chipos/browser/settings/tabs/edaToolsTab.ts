/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * "EDA Tools" settings tab.
 *
 * Three sections:
 *   1. Default strategy (chipos.eda.defaultStrategy) — single-radio
 *   2. Tools table — per-tool source / status / detail with inline editing
 *   3. MCP Servers table — name / transport / status / provides count
 *
 * This is the CAD-engineer-facing surface for what was previously hidden in
 * settings.json. Each row in the tools table is a live read from
 * /api/v1/eda/resolutions; each MCP row from /api/v1/mcp/servers (which now
 * includes auto-discovered `provides`).
 *
 * Edit affordances are wired via existing actions (chipos.eda.tool.* +
 * chipos.workerTools.*) so the right-click panel menu and this tab stay in
 * sync — no parallel state machines. "Refresh all" re-runs the worker
 * rescan command, which the panel's EdaEnvHandler subscriber also catches.
 */

import * as dom from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import {
	EdaResolutionsResponse,
	EdaToolResolution,
	IWorkerToolManagerService,
	McpServerConfig,
	McpServerListResult,
} from '../../../../../../workbench/contrib/chipos/browser/workerToolManager.js';

const STRATEGY_OPTIONS: { value: string; label: string; desc: string }[] = [
	{
		value: 'auto',
		label: localize('chipos.eda.strategy.auto.label', 'Auto'),
		desc: localize('chipos.eda.strategy.auto.desc.short', 'managed → local → mcp (recommended)'),
	},
	{
		value: 'managed-only',
		label: localize('chipos.eda.strategy.managedOnly.label', 'Managed only'),
		desc: localize('chipos.eda.strategy.managedOnly.desc.short', 'CI / deterministic versions'),
	},
	{
		value: 'local-only',
		label: localize('chipos.eda.strategy.localOnly.label', 'Local only'),
		desc: localize('chipos.eda.strategy.localOnly.desc.short', 'B-2: EDA pre-installed, no auto-download'),
	},
	{
		value: 'mcp-first',
		label: localize('chipos.eda.strategy.mcpFirst.label', 'MCP first'),
		desc: localize('chipos.eda.strategy.mcpFirst.desc.short', 'B-1: company MCP cluster as primary source'),
	},
];

export class EdaToolsTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	// Per-row listeners are re-created on every table re-render (a checkbox/filter
	// change rebuilds the whole body), so they must NOT go on the class-level
	// `_disposables` — that leaks one set of listeners per re-render until the tab
	// closes. These stores are cleared at the top of each table render instead.
	private readonly _toolRowDisposables = this._register(new DisposableStore());
	private readonly _serverRowDisposables = this._register(new DisposableStore());
	// The in-app menu popover: holds the open popover's element-removal +
	// listeners. Opening a new one (or disposing the tab) disposes the previous,
	// so menu opens don't leak item/dismiss listeners.
	private readonly _popover = this._register(new MutableDisposable<DisposableStore>());
	private _toolsTableBody: HTMLElement | undefined;
	private _serversTableBody: HTMLElement | undefined;
	// P2 UX: filter state for the tools table. `query` is a substring match
	// on tool_name; `implFilter` narrows to a specific impl (or 'all').
	// `sortBy` is the column key the user clicked. Re-render is cheap so we
	// don't keep DOM references to specific rows.
	private _filterQuery = '';
	private _implFilter: 'all' | 'ready' | 'missing' | 'managed' | 'mcp' | 'local-binary' = 'all';
	private _sortBy: 'name' | 'source' | 'status' = 'status';
	private _lastResolutions: EdaResolutionsResponse | undefined;
	// P1 F1: tools the user has multi-selected (checkboxes). Operations on
	// this set run via Bulk Actions toolbar.
	private _selectedTools = new Set<string>();

	constructor(
		private readonly _container: HTMLElement,
		@IWorkerToolManagerService private readonly _toolManager: IWorkerToolManagerService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@INotificationService private readonly _notif: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
	) {
		super();
		this._render();
		// Re-render whenever the EDA settings change (so external settings.json
		// edits, or actions firing updateValue from the panel, surface here).
		this._disposables.add(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chipos.eda')) {
				this._refreshLiveData();
			}
		}));
	}

	private _render(): void {
		// ── Header ──
		const headerDesc = dom.append(this._container, dom.$('.chipos-setting-description'));
		headerDesc.textContent = localize('chipos.edaTools.header',
			'EDA toolchain resolution — pick a default strategy, override per-tool source, and manage MCP servers that provide remote EDA tools.');

		// ── Section: Strategy ──
		this._renderStrategySection();

		// ── Section: Tools table ──
		this._renderToolsSection();

		// ── Section: MCP Servers table ──
		this._renderServersSection();

		// Initial fetch
		this._refreshLiveData();
	}

	// ── strategy radios ────────────────────────────────────────────────────

	private _renderStrategySection(): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.edaTools.strategyTitle', 'Default strategy')));

		const desc = dom.append(section, dom.$('.chipos-setting-description'));
		desc.textContent = localize('chipos.edaTools.strategyDesc',
			'How ChipOS picks an implementation for each EDA tool when no per-tool override is set.');

		const current = this._configService.getValue<string>('chipos.eda.defaultStrategy') ?? 'auto';
		const radioGroup = dom.append(section, dom.$('.chipos-radio-group'));
		for (const opt of STRATEGY_OPTIONS) {
			const row = dom.append(radioGroup, dom.$('label.chipos-radio-row'));
			const input = dom.append(row, dom.$('input')) as HTMLInputElement;
			input.type = 'radio';
			input.name = 'chipos-eda-strategy';
			input.value = opt.value;
			input.checked = current === opt.value;
			const labelSpan = dom.append(row, dom.$('span.chipos-radio-label'));
			labelSpan.textContent = opt.label;
			const descSpan = dom.append(row, dom.$('span.chipos-radio-desc'));
			descSpan.textContent = ` — ${opt.desc}`;
			this._disposables.add(dom.addDisposableListener(input, 'change', async () => {
				if (input.checked) {
					const previous = current;
					await this._switchStrategyWithPreviewAndUndo(opt.value, opt.label, previous);
				}
			}));
		}
	}

	/**
	 * F8 + UX #12: when user switches strategy:
	 *   1. Run a dry-run with new strategy → diff against current
	 *   2. Show preview "X tools change impl: ..." before committing if diff > 3
	 *   3. After commit, surface an "Undo" notification so accidental switch
	 *      is one click away.
	 */
	private async _switchStrategyWithPreviewAndUndo(nextStrategy: string, nextLabel: string, previousStrategy: string): Promise<void> {
		// Dry-run: compare current cached vs hypothetical strategy
		let changed: { tool: string; from: string; to: string }[] = [];
		try {
			const cur = this._lastResolutions ?? await this._toolManager.getEdaToolResolutions(previousStrategy);
			const next = await this._toolManager.getEdaToolResolutions(nextStrategy);
			for (const [name, nr] of Object.entries(next.by_tool)) {
				const cr = cur.by_tool[name];
				if (!cr) { continue; }
				if (cr.impl !== nr.impl) {
					changed.push({ tool: name, from: cr.impl, to: nr.impl });
				}
			}
		} catch (err) {
			this._log.warn('[EdaToolsTab] strategy preview failed:', String(err));
		}

		// If >3 tools change, ask for confirmation
		if (changed.length > 3) {
			const sample = changed.slice(0, 5)
				.map(c => `${c.tool} (${c.from}→${c.to})`)
				.join(', ');
			const proceed = await this._quickInput.pick([
				{ label: localize('chipos.edaTools.strategyPreview.confirm', 'Proceed') },
				{ label: localize('chipos.edaTools.strategyPreview.cancel', 'Cancel') },
			], {
				title: localize('chipos.edaTools.strategyPreview.title',
					'Switching to {0} will change {1} tool(s): {2}{3}',
					nextLabel, changed.length, sample,
					changed.length > 5 ? `, +${changed.length - 5} more` : '',
				),
			});
			if (!proceed || proceed.label.includes('Cancel')) {
				// Revert the radio to previous
				const prevRadio = this._container.querySelector<HTMLInputElement>(`input[value="${previousStrategy}"]`);
				if (prevRadio) { prevRadio.checked = true; }
				return;
			}
		}

		await this._configService.updateValue('chipos.eda.defaultStrategy', nextStrategy, ConfigurationTarget.USER);
		// UX #12: notification with Undo action — user can revert with one click
		// within the toast timeout (default ~6s).
		const undo = {
			id: 'chipos.edaTools.strategyUndo',
			label: localize('chipos.edaTools.strategyUndo', 'Undo'),
			tooltip: localize('chipos.edaTools.strategyUndo.tooltip', 'Revert to {0}', previousStrategy),
			class: undefined,
			enabled: true,
			run: async () => {
				await this._configService.updateValue('chipos.eda.defaultStrategy', previousStrategy, ConfigurationTarget.USER);
				const prevRadio = this._container.querySelector<HTMLInputElement>(`input[value="${previousStrategy}"]`);
				if (prevRadio) { prevRadio.checked = true; }
				await this._commandService.executeCommand('chipos.eda.rescan');
				await this._refreshLiveData();
				this._notif.info(localize('chipos.edaTools.strategyReverted',
					'Reverted EDA strategy to "{0}".', previousStrategy));
			},
			dispose: () => { /* no-op */ },
		};
		this._notif.notify({
			severity: 1,  // Info
			message: localize('chipos.edaTools.strategyChanged.v2',
				'Default EDA strategy set to "{0}". Re-scanning…', nextLabel),
			actions: { primary: [undo] },
		});
		await this._commandService.executeCommand('chipos.eda.rescan');
		await this._refreshLiveData();
	}

	// ── tools table ────────────────────────────────────────────────────────

	private _renderToolsSection(): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		const header = dom.append(section, dom.$('.chipos-settings-section-header'));
		dom.append(header, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.edaTools.toolsTitle', 'Tools')));

		const refreshBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		refreshBtn.textContent = localize('chipos.edaTools.refresh', '⟳ Refresh All');
		refreshBtn.title = localize('chipos.edaTools.refresh.tooltip',
			'Re-scan worker PATH + MCP server tools/list. Picks up newly-installed binaries without restarting the worker.');
		this._disposables.add(dom.addDisposableListener(refreshBtn, 'click', async () => {
			await this._commandService.executeCommand('chipos.eda.rescan');
			await this._refreshLiveData();
		}));

		// P2 UX: filter + search toolbar (always visible, no toggle needed —
		// 31 rows is enough to warrant always-on filtering).
		const toolbar = dom.append(section, dom.$('.chipos-eda-toolbar'));
		const searchInput = dom.append(toolbar, dom.$('input.chipos-eda-search')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = localize('chipos.edaTools.searchPlaceholder', 'Filter tools by name…');
		this._disposables.add(dom.addDisposableListener(searchInput, 'input', () => {
			this._filterQuery = searchInput.value.trim().toLowerCase();
			this._renderToolsTableFiltered();
		}));

		const implSelect = dom.append(toolbar, dom.$('select.chipos-eda-impl-filter')) as HTMLSelectElement;
		for (const opt of [
			{ value: 'all',          label: localize('chipos.edaTools.implFilter.all', 'All impls') },
			{ value: 'ready',        label: localize('chipos.edaTools.implFilter.ready', 'Ready only') },
			{ value: 'missing',      label: localize('chipos.edaTools.implFilter.missing', 'Missing only') },
			{ value: 'managed',      label: localize('chipos.edaTools.implFilter.managed', 'Managed') },
			{ value: 'mcp',          label: localize('chipos.edaTools.implFilter.mcp', 'MCP') },
			{ value: 'local-binary', label: localize('chipos.edaTools.implFilter.local', 'Local') },
		]) {
			const o = dom.append(implSelect, dom.$('option')) as HTMLOptionElement;
			o.value = opt.value;
			o.textContent = opt.label;
		}
		this._disposables.add(dom.addDisposableListener(implSelect, 'change', () => {
			this._implFilter = implSelect.value as typeof this._implFilter;
			this._renderToolsTableFiltered();
		}));

		// Spacer pushes the bulk-action button to the right edge so the
		// toolbar reads as: [search] [filter] ········· [Disable Selected]
		dom.append(toolbar, dom.$('.chipos-eda-toolbar-spacer'));

		// P1 F1: bulk actions toolbar (always rendered but disabled until ≥1 selected)
		const bulkBtn = dom.append(toolbar, dom.$('button.chipos-btn-secondary')) as HTMLButtonElement;
		bulkBtn.textContent = localize('chipos.edaTools.bulkDisable', 'Disable Selected');
		bulkBtn.disabled = true;
		bulkBtn.title = localize('chipos.edaTools.bulkDisable.tooltip',
			'Set source=disabled for all checked tools. They\'ll be hidden from the agent tool registry.');
		this._disposables.add(dom.addDisposableListener(bulkBtn, 'click', () => this._bulkDisableSelected()));
		this._bulkBtn = bulkBtn;

		const table = dom.append(section, dom.$('table.chipos-eda-tools-table'));
		const thead = dom.append(table, dom.$('thead'));
		const headRow = dom.append(thead, dom.$('tr'));
		// First column = bulk-select checkbox header
		const selectAllTh = dom.append(headRow, dom.$('th.chipos-eda-tool-select'));
		const selectAllBox = dom.append(selectAllTh, dom.$('input')) as HTMLInputElement;
		selectAllBox.type = 'checkbox';
		selectAllBox.title = localize('chipos.edaTools.selectAll', 'Select all (filtered)');
		this._disposables.add(dom.addDisposableListener(selectAllBox, 'change', () => {
			this._toggleSelectAll(selectAllBox.checked);
		}));
		// Sortable column headers
		for (const col of [
			{ key: 'name', label: 'Tool' } as const,
			{ key: 'source', label: 'Source' } as const,
			{ key: 'status', label: 'Status' } as const,
		]) {
			const th = dom.append(headRow, dom.$('th.chipos-eda-tool-sortable')) as HTMLTableCellElement;
			th.textContent = col.label;
			th.style.cursor = 'pointer';
			this._disposables.add(dom.addDisposableListener(th, 'click', () => {
				this._sortBy = col.key;
				this._renderToolsTableFiltered();
			}));
		}
		dom.append(headRow, dom.$('th', undefined, 'Detail'));
		dom.append(headRow, dom.$('th', undefined, ''));
		this._toolsTableBody = dom.append(table, dom.$('tbody'));

		// Footer line below the table: "31 tools · 19 ready · 5 missing"
		// or, when filter active, "Showing 7 of 31 (filter: equiv)".
		// Lives outside the .chipos-eda-tools-table card so it reads as a
		// caption, not a table row.
		this._toolsFooter = dom.append(section, dom.$('.chipos-eda-tools-footer'));
	}

	private _bulkBtn: HTMLButtonElement | undefined;
	private _toolsFooter: HTMLElement | undefined;

	private _renderToolsTableFiltered(): void {
		if (!this._lastResolutions) { return; }
		this._renderToolsTable(this._lastResolutions);
		this._updateBulkButtonOnly();
	}

	/**
	 * UX #B: refresh just the "Disable Selected (N)" button label, without
	 * tearing down + rebuilding the table rows. Called from per-row
	 * checkbox listeners so the user's scroll position survives toggling.
	 */
	private _updateBulkButtonOnly(): void {
		if (!this._bulkBtn) { return; }
		this._bulkBtn.disabled = this._selectedTools.size === 0;
		if (this._selectedTools.size > 0) {
			this._bulkBtn.textContent = localize('chipos.edaTools.bulkDisable.count', 'Disable Selected ({0})', this._selectedTools.size);
		} else {
			this._bulkBtn.textContent = localize('chipos.edaTools.bulkDisable', 'Disable Selected');
		}
	}

	private _toggleSelectAll(checked: boolean): void {
		if (!this._lastResolutions || !this._toolsTableBody) { return; }
		const visible = this._applyFilterAndSort(Object.values(this._lastResolutions.by_tool));
		if (checked) {
			for (const r of visible) { this._selectedTools.add(r.tool_name); }
		} else {
			for (const r of visible) { this._selectedTools.delete(r.tool_name); }
		}
		// UX #B: only mutate per-row checkbox state in DOM (no re-render).
		// Each tr's first <td> has the checkbox; toggle in place.
		const rows = this._toolsTableBody.querySelectorAll<HTMLTableRowElement>('tr.chipos-eda-tool-row');
		rows.forEach(tr => {
			const cb = tr.querySelector<HTMLInputElement>('td.chipos-eda-tool-select input[type="checkbox"]');
			if (cb) { cb.checked = checked; }
		});
		this._updateBulkButtonOnly();
	}

	private async _bulkDisableSelected(): Promise<void> {
		if (this._selectedTools.size === 0) { return; }
		const names = Array.from(this._selectedTools).sort();
		const current = this._configService.getValue<Record<string, any>>('chipos.eda.tools') ?? {};
		const next = { ...current };
		for (const n of names) {
			next[n] = { ...current[n], source: 'disabled' };
		}
		await this._configService.updateValue('chipos.eda.tools', next, ConfigurationTarget.USER);
		this._notif.info(localize(
			'chipos.edaTools.bulkDisable.done',
			'{0} tool(s) disabled: {1}{2}',
			names.length,
			names.slice(0, 5).join(', '),
			names.length > 5 ? `, +${names.length - 5} more` : '',
		));
		this._selectedTools.clear();
		await this._refreshLiveData();
	}

	private _applyFilterAndSort(rows: EdaToolResolution[]): EdaToolResolution[] {
		let filtered = rows;
		if (this._filterQuery) {
			filtered = filtered.filter(r => r.tool_name.toLowerCase().includes(this._filterQuery));
		}
		if (this._implFilter !== 'all') {
			if (this._implFilter === 'ready') {
				filtered = filtered.filter(r => r.ready);
			} else if (this._implFilter === 'missing') {
				filtered = filtered.filter(r => !r.ready);
			} else {
				filtered = filtered.filter(r => r.impl === this._implFilter);
			}
		}
		// Sort
		if (this._sortBy === 'name') {
			filtered.sort((a, b) => a.tool_name.localeCompare(b.tool_name));
		} else if (this._sortBy === 'source') {
			filtered.sort((a, b) => {
				const sa = this._getToolOverride(a.tool_name)?.source ?? 'auto';
				const sb = this._getToolOverride(b.tool_name)?.source ?? 'auto';
				return sa.localeCompare(sb) || a.tool_name.localeCompare(b.tool_name);
			});
		} else {
			// status: ready first, then missing, alphabetic within
			filtered.sort((a, b) => {
				if (a.ready !== b.ready) { return a.ready ? -1 : 1; }
				return a.tool_name.localeCompare(b.tool_name);
			});
		}
		return filtered;
	}

	private _renderToolsTable(payload: EdaResolutionsResponse): void {
		if (!this._toolsTableBody) { return; }
		this._lastResolutions = payload;

		// UX #B fix: preserve scrollTop across re-render. Without this, ticking
		// any checkbox triggers _renderToolsTableFiltered → clearNode →
		// rebuild, and the browser resets scroll to 0 because the row
		// elements identity changes. Capture before clear, restore after
		// next layout pass.
		const scrollEl = this._container.closest('.chipos-settings-content') as HTMLElement | null;
		const prevScrollTop = scrollEl?.scrollTop ?? 0;

		dom.clearNode(this._toolsTableBody);
		this._toolRowDisposables.clear(); // dispose the previous rows' listeners

		// Apply current filter + sort (P2 UX). Default sort = status puts
		// READY tools first (less anxiety-inducing than missing-first).
		const allRows = Object.values(payload.by_tool);
		const rows = this._applyFilterAndSort(allRows);

		if (rows.length === 0) {
			const empty = dom.append(this._toolsTableBody, dom.$('tr'));
			const cell = dom.append(empty, dom.$('td.chipos-eda-empty')) as HTMLTableCellElement;
			cell.colSpan = 6;
			cell.textContent = this._filterQuery || this._implFilter !== 'all'
				? localize('chipos.edaTools.noMatch', 'No tools match the current filter.')
				: localize('chipos.edaTools.empty', 'No EDA tools registered.');
			this._updateFooter(0, allRows);
			return;
		}

		for (const r of rows) {
			this._renderToolRow(this._toolsTableBody, r);
		}

		this._updateFooter(rows.length, allRows);

		// Restore scroll on next animation frame (after layout settles)
		if (scrollEl && prevScrollTop > 0) {
			requestAnimationFrame(() => {
				scrollEl.scrollTop = prevScrollTop;
			});
		}
	}

	/**
	 * Render the footer caption below the table. When no filter is active,
	 * shows the breakdown "31 tools · 19 ready · 5 missing · 2 disabled".
	 * When a filter is active, shows "Showing 7 of 31 tools" so users can
	 * tell at a glance how aggressive their current filter is.
	 */
	private _updateFooter(visibleCount: number, allRows: EdaToolResolution[]): void {
		if (!this._toolsFooter) { return; }
		const ready = allRows.filter(r => r.ready).length;
		const missing = allRows.filter(r => !r.ready && this._getToolOverride(r.tool_name)?.source !== 'disabled').length;
		const disabled = allRows.filter(r => this._getToolOverride(r.tool_name)?.source === 'disabled').length;
		const total = allRows.length;
		const filterActive = this._filterQuery !== '' || this._implFilter !== 'all';

		dom.clearNode(this._toolsFooter);
		if (filterActive) {
			dom.append(this._toolsFooter, dom.$('span', undefined,
				localize('chipos.edaTools.footer.filtered', 'Showing {0} of {1} tools', visibleCount, total)));
		} else {
			const parts: string[] = [
				localize('chipos.edaTools.footer.total', '{0} tools', total),
				localize('chipos.edaTools.footer.ready', '{0} ready', ready),
			];
			if (missing > 0) { parts.push(localize('chipos.edaTools.footer.missing', '{0} missing', missing)); }
			if (disabled > 0) { parts.push(localize('chipos.edaTools.footer.disabled', '{0} disabled', disabled)); }
			dom.append(this._toolsFooter, dom.$('span', undefined, parts.join(' · ')));
		}
	}

	private _renderToolRow(parent: HTMLElement, r: EdaToolResolution): void {
		const tr = dom.append(parent, dom.$('tr.chipos-eda-tool-row'));
		// P1 F1: per-row bulk-select checkbox. UX #B fix: DON'T re-render
		// table on checkbox toggle — just update selection set + refresh
		// the bulk button count. Scroll position stays intact.
		const selCell = dom.append(tr, dom.$('td.chipos-eda-tool-select'));
		const cb = dom.append(selCell, dom.$('input')) as HTMLInputElement;
		cb.type = 'checkbox';
		cb.checked = this._selectedTools.has(r.tool_name);
		this._toolRowDisposables.add(dom.addDisposableListener(cb, 'change', () => {
			if (cb.checked) { this._selectedTools.add(r.tool_name); }
			else { this._selectedTools.delete(r.tool_name); }
			this._updateBulkButtonOnly();
		}));
		dom.append(tr, dom.$('td.chipos-eda-tool-name', undefined, r.tool_name));

		// Source cell — shows the USER-SETTING value (auto / managed / local /
		// mcp / disabled), NOT the resolution impl. P1 Bug #2: previous
		// behavior showed "missing" here for unconfigured tools, making it
		// look like the user explicitly chose missing. Resolution impl is
		// surfaced via the STATUS column + DETAIL column instead.
		const sourceCell = dom.append(tr, dom.$('td.chipos-eda-tool-source'));
		const userOverride = this._getToolOverride(r.tool_name);
		const userSource = userOverride?.source ?? 'auto';
		const sourceBtn = dom.append(sourceCell, dom.$('button.chipos-btn-link'));
		sourceBtn.textContent = userSource;
		sourceBtn.title = localize('chipos.edaTools.editSource', 'Change source for {0} (currently: {1})', r.tool_name, userSource);
		this._toolRowDisposables.add(dom.addDisposableListener(sourceBtn, 'click', () => {
			this._openSourcePicker(r.tool_name);
		}));

		// Status cell — ✓ ready (impl) / ○ missing / — disabled.
		// Showing the resolved `impl` here (not in SOURCE) cleanly separates
		// "what user asked for" (SOURCE) from "what worker actually found"
		// (STATUS). P1 Bug #2.
		const statusCell = dom.append(tr, dom.$('td.chipos-eda-tool-status'));
		const dot = dom.append(statusCell, dom.$('span'));
		if (userOverride?.source === 'disabled') {
			dot.textContent = '— disabled';
			dot.classList.add('disabled');
		} else if (r.ready) {
			dot.textContent = `✓ ${r.impl}`;
			dot.classList.add('ready');
		} else {
			dot.textContent = '○ missing';
			dot.classList.add('missing');
		}

		// Detail cell — path / server / hint truncated
		const detailCell = dom.append(tr, dom.$('td.chipos-eda-tool-detail'));
		detailCell.textContent = this._formatDetail(r);
		detailCell.title = JSON.stringify(r.detail);  // hover for full

		// Action cell — kebab menu (Test / Configure / Disable)
		const actionCell = dom.append(tr, dom.$('td.chipos-eda-tool-actions'));
		const menuBtn = dom.append(actionCell, dom.$('button.chipos-btn-icon'));
		menuBtn.textContent = '⋯';
		menuBtn.title = localize('chipos.edaTools.toolActions', 'Tool actions');
		this._toolRowDisposables.add(dom.addDisposableListener(menuBtn, 'click', () => {
			this._openToolActionsMenu(r, menuBtn);
		}));
	}

	private _formatDetail(r: EdaToolResolution): string {
		switch (r.impl) {
			case 'managed':
				// Prefer the resolved binary path when the resolver provided one
				// (e.g. iverilog → .../oss-cad-suite/bin/iverilog). Composite/
				// dep-only managed tools (check_syntax, equiv_check, format, …)
				// have no direct binary, so fall back to a friendly label that
				// signals "this comes from the managed bundle" instead of
				// leaving the column blank and looking broken.
				return r.detail.path ?? localize('chipos.edaTools.detail.managedBundle', 'via oss-cad-suite');
			case 'local-binary':
				return r.detail.path ?? localize('chipos.edaTools.detail.localPath', 'via system PATH');
			case 'mcp':
				return r.detail.server_name
					? localize('chipos.edaTools.detail.mcp', 'via {0}', r.detail.server_name)
					: localize('chipos.edaTools.detail.mcpAny', 'via MCP server');
			case 'missing':
				return r.detail.hint ? r.detail.hint.slice(0, 80) + (r.detail.hint.length > 80 ? '…' : '') : '';
			default:
				return '';
		}
	}

	// ── action pickers ─────────────────────────────────────────────────────

	private async _openSourcePicker(toolName: string): Promise<void> {
		const picked = await this._quickInput.pick([
			{ label: 'auto',     description: localize('chipos.edaTools.src.auto', 'Use default strategy') },
			{ label: 'managed',  description: localize('chipos.edaTools.src.managed', 'ChipOS-managed (oss-cad-suite)') },
			{ label: 'local',    description: localize('chipos.edaTools.src.local', 'System PATH or explicit path') },
			{ label: 'mcp',      description: localize('chipos.edaTools.src.mcp', 'Remote MCP server') },
			{ label: 'disabled', description: localize('chipos.edaTools.src.disabled', 'Hide from agent') },
		], {
			title: localize('chipos.edaTools.src.title', 'Set source for {0}', toolName),
		});
		if (!picked) { return; }
		const current = this._configService.getValue<Record<string, any>>('chipos.eda.tools') ?? {};
		const next = { ...current, [toolName]: { ...current[toolName], source: picked.label } };
		await this._configService.updateValue('chipos.eda.tools', next, ConfigurationTarget.USER);
		await this._commandService.executeCommand('chipos.eda.rescan');
		await this._refreshLiveData();
	}

	/**
	 * UX #C: custom in-app popover for the kebab menu.
	 *
	 * Replaces `IContextMenuService.showContextMenu()` (which on macOS
	 * rendered with a system-NSMenu-like look that clashed with the rest
	 * of ChipOS Settings). This popover uses the same ChipOS design tokens
	 * as the surrounding tab (--chipos-surface-2, --chipos-border-soft,
	 * --chipos-radius-md) so it visually anchors as part of the page,
	 * not as a system menu.
	 */
	private _openToolActionsMenu(r: EdaToolResolution, anchor: HTMLElement): void {
		const handle = { $treeItemHandle: `impl-tool:${r.tool_name}` };
		const items: { label: string; danger?: boolean; run: () => Promise<void> }[] = [];
		const exec = async (cmdId: string, ...args: unknown[]) => {
			await this._commandService.executeCommand(cmdId, ...args);
			await this._refreshLiveData();
		};

		if (r.ready) {
			items.push({ label: localize('chipos.edaTools.action.test', 'Test'), run: () => exec('chipos.eda.tool.test', handle) });
			if (r.detail.path) {
				items.push({ label: localize('chipos.edaTools.action.copyPath', 'Copy Path'), run: () => exec('chipos.eda.tool.copyPath', handle) });
				items.push({ label: localize('chipos.edaTools.action.showFinder', 'Show in Finder'), run: () => exec('chipos.eda.tool.showInFinder', handle) });
				items.push({ label: localize('chipos.edaTools.action.viewGuideReady', 'View install guide'), run: () => exec('chipos.eda.openInstallGuide', r.tool_name) });
			}
		} else {
			items.push({ label: localize('chipos.edaTools.action.viewGuide', 'View install guide'), run: () => exec('chipos.eda.openInstallGuide', r.tool_name) });
			items.push({ label: localize('chipos.edaTools.action.configurePath', 'Configure local path…'), run: () => exec('chipos.eda.tool.configureLocalPath', handle) });
			items.push({ label: localize('chipos.edaTools.action.connectMcp', 'Connect via MCP…'), run: () => exec('chipos.eda.tool.connectViaMcp') });
		}
		items.push({ label: localize('chipos.edaTools.action.switchSource', 'Switch source…'), run: () => exec('chipos.eda.tool.switchSource', handle) });
		items.push({ label: localize('chipos.edaTools.action.disable', 'Disable'), danger: true, run: () => exec('chipos.eda.tool.disable', handle) });

		this._showInAppPopover(anchor, items);
	}

	/** UX #C: ChipOS-themed popover. Positioned below+right of anchor.
	 * Mounted inside `.monaco-workbench` (not body) because the VS Code
	 * theme tokens (--vscode-foreground / --vscode-editorWidget-background
	 * / etc) are scoped under .monaco-workbench. Mounting on body would
	 * inherit `color: black` and make text invisible on dark themes.
	 */
	private _showInAppPopover(anchor: HTMLElement, items: { label: string; danger?: boolean; run: () => Promise<void> }[]): void {
		// Remove any prior popover (only one open at a time)
		// Close any popover already open (disposes its listeners + removes it).
		this._popover.clear();

		const host = document.querySelector('.monaco-workbench') || document.body;
		const rect = anchor.getBoundingClientRect();
		const pop = dom.append(host as HTMLElement, dom.$('.chipos-eda-popover'));
		// Position below the anchor button, right-aligned so it doesn't
		// run off the right edge.
		const POPOVER_WIDTH = 200;
		pop.style.position = 'fixed';
		pop.style.top = `${rect.bottom + 4}px`;
		pop.style.left = `${Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8)}px`;
		pop.style.minWidth = `${POPOVER_WIDTH}px`;
		pop.style.zIndex = '10000';

		// Everything tied to this popover lives in one store; disposing it removes
		// the element + every listener (no per-open leak; a tab dispose cleans it).
		const store = new DisposableStore();
		this._popover.value = store;
		store.add(toDisposable(() => pop.remove()));
		const close = () => this._popover.clear();

		for (const item of items) {
			const row = dom.append(pop, dom.$('.chipos-eda-popover-item'));
			if (item.danger) { row.classList.add('danger'); }
			row.textContent = item.label;
			store.add(dom.addDisposableListener(row, 'click', async () => {
				close();
				try { await item.run(); } catch (e) { this._log.warn('[EdaToolsTab] menu action threw:', String(e)); }
			}));
		}

		// Dismiss on outside click / Escape. Deferred attach so the opening
		// click doesn't immediately close it.
		const outsideClickHandler = (e: MouseEvent) => {
			if (!pop.contains(e.target as Node) && e.target !== anchor) { close(); }
		};
		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { close(); }
		};
		setTimeout(() => {
			if (this._popover.value !== store) { return; } // already closed/replaced
			store.add(dom.addDisposableListener(document, 'mousedown', outsideClickHandler, true));
			store.add(dom.addDisposableListener(document, 'keydown', keyHandler, true));
		}, 0);
	}

	// ── mcp servers section ───────────────────────────────────────────────

	private _renderServersSection(): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		const header = dom.append(section, dom.$('.chipos-settings-section-header'));
		dom.append(header, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.edaTools.serversTitle', 'MCP Servers (worker-side)')));

		const addBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		addBtn.textContent = localize('chipos.edaTools.addServer', '+ Add MCP Server');
		this._disposables.add(dom.addDisposableListener(addBtn, 'click', async () => {
			await this._commandService.executeCommand('chipos.workerTools.addMcpServer');
			await this._refreshLiveData();
		}));

		const importBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		importBtn.textContent = localize('chipos.edaTools.importMcp', 'Import from mcp.json…');
		this._disposables.add(dom.addDisposableListener(importBtn, 'click', () => this._importMcpJson()));

		const desc = dom.append(section, dom.$('.chipos-setting-description'));
		desc.textContent = localize('chipos.edaTools.serversDesc',
			'MCP servers launched by the Worker process. Each server\'s advertised tools auto-populate the table above (impl=mcp).');

		const table = dom.append(section, dom.$('table.chipos-eda-tools-table'));
		const thead = dom.append(table, dom.$('thead'));
		const headRow = dom.append(thead, dom.$('tr'));
		for (const col of ['Name', 'Transport', 'Status', 'Provides', '']) {
			dom.append(headRow, dom.$('th', undefined, col));
		}
		this._serversTableBody = dom.append(table, dom.$('tbody'));
	}

	/**
	 * Import MCP servers from a Cursor/Claude-format `mcp.json`
	 * (`{ "mcpServers": { name: { command, args, env } } }`, or a bare map).
	 * stdio entries (those with a `command`) are added via the worker; url-only
	 * entries and names that already exist are skipped and reported. This is the
	 * MCP analogue of "Import from Local…" for the other resource tabs.
	 */
	private async _importMcpJson(): Promise<void> {
		const picks = await this._fileDialogService.showOpenDialog({
			title: localize('chipos.edaTools.importMcpTitle', 'Import MCP Servers from mcp.json'),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize('chipos.edaTools.importMcpFilter', 'JSON'), extensions: ['json'] }],
		});
		if (!picks || picks.length === 0) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse((await this._fileService.readFile(picks[0])).value.toString());
		} catch {
			this._notif.error(localize('chipos.edaTools.importMcpBadJson', 'Could not parse the selected file as JSON.'));
			return;
		}
		// Accept { mcpServers: {...} } (Cursor/Claude) or a bare { name: {...} } map.
		const root = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
		const mapRaw = (root.mcpServers && typeof root.mcpServers === 'object') ? root.mcpServers as Record<string, unknown> : root;

		let existing: ReadonlySet<string>;
		try {
			existing = new Set((await this._toolManager.listMcpServers()).servers.map(s => s.name));
		} catch {
			existing = new Set();
		}

		const asStringArray = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
		const asStringMap = (v: unknown): Record<string, string> => {
			const out: Record<string, string> = {};
			if (v && typeof v === 'object') {
				for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
					if (typeof val === 'string') { out[k] = val; }
				}
			}
			return out;
		};

		const added: string[] = [];
		const skipped: string[] = [];
		for (const [name, raw] of Object.entries(mapRaw)) {
			if (!name || existing.has(name) || !raw || typeof raw !== 'object') {
				skipped.push(name);
				continue;
			}
			const entry = raw as Record<string, unknown>;
			if (typeof entry.command !== 'string' || !entry.command) {
				// url-only / transport-only entry — the worker config is stdio-shaped.
				skipped.push(name);
				continue;
			}
			const config: McpServerConfig = {
				name,
				command: entry.command,
				args: asStringArray(entry.args),
				env: asStringMap(entry.env),
			};
			if (typeof entry.cwd === 'string') { config.cwd = entry.cwd; }
			if (typeof entry.transport === 'string') { config.transport = entry.transport; }
			try {
				const res = await this._toolManager.addMcpServer(config);
				if (res.success) { added.push(name); } else { skipped.push(name); }
			} catch {
				skipped.push(name);
			}
		}

		if (added.length > 0) {
			this._notif.info(localize('chipos.edaTools.importMcpDone', 'Imported {0} MCP server(s){1}.', added.length, skipped.length > 0 ? localize('chipos.edaTools.importMcpSkipped', ' ({0} skipped: already present or non-stdio)', skipped.length) : ''));
		} else {
			this._notif.info(localize('chipos.edaTools.importMcpNone', 'No MCP servers imported ({0} skipped: already present or non-stdio).', skipped.length));
		}
		await this._refreshLiveData();
	}

	private _renderServersTable(payload: McpServerListResult): void {
		if (!this._serversTableBody) { return; }
		dom.clearNode(this._serversTableBody);
		this._serverRowDisposables.clear();
		const disabled = Object.values(this._getDisabledMcp());
		const activeNames = new Set(payload.servers.map(srv => srv.name));
		if (payload.servers.length === 0 && disabled.length === 0) {
			const empty = dom.append(this._serversTableBody, dom.$('tr'));
			const cell = dom.append(empty, dom.$('td.chipos-eda-empty')) as HTMLTableCellElement;
			cell.colSpan = 5;
			cell.textContent = localize('chipos.edaTools.noServers',
				'No MCP servers configured. Click "+ Add MCP Server" to connect a remote tool source.');
			return;
		}
		for (const srv of payload.servers) {
			this._renderServerRow(this._serversTableBody, srv, false);
		}
		for (const srv of disabled) {
			if (!activeNames.has(srv.name)) {
				this._renderServerRow(this._serversTableBody, srv, true);
			}
		}
	}

	/** Disabled worker MCP servers stashed in `chipos.mcp.disabled` (name -> config). */
	private _getDisabledMcp(): Record<string, McpServerConfig> {
		const raw = this._configService.getValue<Record<string, McpServerConfig>>('chipos.mcp.disabled');
		return (raw && typeof raw === 'object') ? raw : {};
	}

	/**
	 * Real, worker-backed enable/disable. Disable removes the server from the
	 * worker (so it stops running) and stashes its config in `chipos.mcp.disabled`;
	 * enable re-adds the stashed config. The worker has no soft-disable flag, so
	 * this remove+stash+re-add is the honest mechanism (not a cosmetic toggle).
	 */
	private async _setMcpEnabled(srv: McpServerConfig, enable: boolean): Promise<void> {
		const map = { ...this._getDisabledMcp() };
		try {
			if (enable) {
				const stashed = map[srv.name] ?? srv;
				const res = await this._toolManager.addMcpServer(stashed);
				if (!res.success) {
					this._notif.error(localize('chipos.edaTools.enableFailed', 'Could not enable {0}: {1}', srv.name, res.error ?? res.message ?? ''));
					return;
				}
				delete map[srv.name];
			} else {
				const res = await this._toolManager.removeMcpServer(srv.name);
				if (!res.success) {
					this._notif.error(localize('chipos.edaTools.disableFailed', 'Could not disable {0}: {1}', srv.name, res.error ?? res.message ?? ''));
					return;
				}
				map[srv.name] = { name: srv.name, command: srv.command, args: srv.args, env: srv.env, cwd: srv.cwd, transport: srv.transport };
			}
			await this._configService.updateValue('chipos.mcp.disabled', map, ConfigurationTarget.USER);
		} catch (err) {
			this._notif.error(localize('chipos.edaTools.mcpToggleErr', 'MCP toggle failed: {0}', String(err)));
		}
		await this._refreshLiveData();
	}

	private _renderServerRow(parent: HTMLElement, srv: McpServerConfig, disabled: boolean): void {
		const tr = dom.append(parent, dom.$('tr'));
		if (disabled) {
			tr.style.opacity = '0.55';
		}
		dom.append(tr, dom.$('td', undefined, srv.name));
		dom.append(tr, dom.$('td', undefined, srv.transport ?? 'stdio'));
		const statusCell = dom.append(tr, dom.$('td'));
		const provides = srv.provides ?? [];
		const span = dom.append(statusCell, dom.$('span'));
		if (disabled) {
			span.classList.add('chipos-status-unknown');
			span.textContent = localize('chipos.edaTools.serverStatus.disabled', '⊘ disabled');
		} else {
			const health = srv.health?.status ?? 'unknown';
			switch (health) {
				case 'connected':
					span.classList.add('chipos-status-ok');
					span.textContent = localize('chipos.edaTools.serverStatus.connected', '✓ connected');
					if (srv.health?.latency_ms != null) {
						span.textContent += ` (${srv.health.latency_ms}ms)`;
					}
					break;
				case 'no_tools':
					span.classList.add('chipos-status-warn');
					span.textContent = localize('chipos.edaTools.serverStatus.noTools', '⚠ no tools discovered');
					break;
				case 'handshake_failed':
					span.classList.add('chipos-status-err');
					span.textContent = localize('chipos.edaTools.serverStatus.handshake', '✗ handshake failed');
					if (srv.health?.error) { span.title = srv.health.error; }
					break;
				case 'unreachable':
					span.classList.add('chipos-status-err');
					span.textContent = localize('chipos.edaTools.serverStatus.unreachable', '✗ unreachable');
					if (srv.health?.error) { span.title = srv.health.error; }
					break;
				default:
					span.classList.add('chipos-status-unknown');
					span.textContent = localize('chipos.edaTools.serverStatus.unknown', '? probing…');
			}
		}
		dom.append(tr, dom.$('td', undefined,
			(!disabled && provides.length > 0)
				? `${provides.length}: ${provides.slice(0, 3).join(', ')}${provides.length > 3 ? '…' : ''}`
				: '—'));

		const actionCell = dom.append(tr, dom.$('td'));
		const menuBtn = dom.append(actionCell, dom.$('button.chipos-btn-icon'));
		menuBtn.textContent = '⋯';
		this._serverRowDisposables.add(dom.addDisposableListener(menuBtn, 'click', async () => {
			const items = disabled
				? [
					{ id: 'enable', label: localize('chipos.edaTools.server.enable', 'Enable') },
					{ id: 'remove', label: localize('chipos.edaTools.server.remove', 'Remove') },
				]
				: [
					{ id: 'test', label: localize('chipos.edaTools.server.test', 'Test connection') },
					{ id: 'copy', label: localize('chipos.edaTools.server.copyInfo', 'Copy server info') },
					{ id: 'disable', label: localize('chipos.edaTools.server.disable', 'Disable') },
					{ id: 'remove', label: localize('chipos.edaTools.server.remove', 'Remove') },
				];
			const picked = await this._quickInput.pick(items, { title: localize('chipos.edaTools.server.menuTitle2', '{0} actions', srv.name) });
			if (!picked) { return; }
			const args = { $treeItemHandle: `worker-mcp:${srv.name}` };
			switch (picked.id) {
				case 'enable': await this._setMcpEnabled(srv, true); break;
				case 'disable': await this._setMcpEnabled(srv, false); break;
				case 'test': await this._commandService.executeCommand('chipos.eda.server.test', args); break;
				case 'copy': await this._commandService.executeCommand('chipos.eda.server.copyInfo', args); break;
				case 'remove':
					if (disabled) {
						const map = { ...this._getDisabledMcp() };
						delete map[srv.name];
						await this._configService.updateValue('chipos.mcp.disabled', map, ConfigurationTarget.USER);
						await this._refreshLiveData();
					} else {
						await this._commandService.executeCommand('chipos.workerTools.removeMcpServer', args);
						await this._refreshLiveData();
					}
					break;
			}
		}));
	}

	// ── data fetch ────────────────────────────────────────────────────────

	private async _refreshLiveData(): Promise<void> {
		const strategy = this._configService.getValue<string>('chipos.eda.defaultStrategy') ?? 'auto';
		// Read per-tool path overrides from settings so worker resolver
		// honors `chipos.eda.tools.vivado.path = "/opt/Xilinx/..."` etc.
		// Without this transport, the tab would show "configured" rows that
		// worker silently ignored — the UX bug the user explicitly flagged.
		const toolsSetting = this._configService.getValue<Record<string, { path?: string; source?: string }>>('chipos.eda.tools') ?? {};
		const overrides: Record<string, string> = {};
		for (const [name, entry] of Object.entries(toolsSetting)) {
			// Only forward path when source explicitly opts into local
			// (source=local or source=manual with a path). source=auto means
			// "let strategy decide" — passing a path there would unexpectedly
			// override the auto-resolved managed/mcp impl.
			if (entry && entry.path && (entry.source === 'local' || entry.source === 'manual')) {
				overrides[name] = entry.path;
			}
		}
		const [resOk, srvOk] = await Promise.allSettled([
			this._toolManager.getEdaToolResolutions(strategy, overrides),
			this._toolManager.listMcpServers(),
		]);
		if (resOk.status === 'fulfilled') {
			this._renderToolsTable(resOk.value);
		} else {
			this._log.warn('[EdaToolsTab] getEdaToolResolutions failed:', String(resOk.reason));
		}
		if (srvOk.status === 'fulfilled') {
			this._renderServersTable(srvOk.value);
		} else {
			this._log.warn('[EdaToolsTab] listMcpServers failed:', String(srvOk.reason));
		}
	}

	// ── helpers ───────────────────────────────────────────────────────────

	private _getToolOverride(toolName: string): { source?: string; path?: string; mcpServer?: string } | undefined {
		const all = this._configService.getValue<Record<string, any>>('chipos.eda.tools') ?? {};
		return all[toolName];
	}
}
