/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * EdaStatusBarItem — IDE status bar 显示 EDA 工具就绪性, 一行汇总.
 *
 * Workflow:
 *   1. Sidecar (worker) connected → poll /api/v1/eda/status every 60s
 *   2. Render: "$(circuit-board) EDA: 19/24" + tooltip 列每个 binary 状态
 *   3. Click → open WORKER TOOLS view (FEAT-R26 panel)
 *
 * 用户截图 (2026-05-15) 显示 WORKER TOOLS 24 个 tool 全标 "not installed",
 * 因为 lifecycle.detect() 用 `which yosys_synthesis` 找不到 (MCP name != binary).
 * 修复在后端 (execution/tools/eda_lifecycle.py); 本文件加 status bar UI 让
 * 用户一眼看到聚合状态 (X/24 ready) 而不用展开整个 tree.
 */

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IStatusbarEntry,
	IStatusbarEntryAccessor,
	IStatusbarService,
	StatusbarAlignment,
} from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ISidecarManagerService, SidecarState, WorkerState } from '../common/sidecarService.js';
import {
	EdaStatusSummary,
	IWorkerToolManagerService,
} from './workerToolManager.js';

const POLL_INTERVAL_MS = 60_000;          // 60s — EDA install state changes rarely
const INITIAL_DELAY_MS = 2_000;           // wait 2s after worker connect before first poll

// Diagnostic states (pending / disconnected / error) point at the Worker
// Tools panel so the user can see *why* the worker isn't reporting back.
const COMMAND_OPEN_PANEL = 'chipos.workerTools.focus';

// Healthy "EDA: N/M" pill jumps to the Settings → EDA Tools tab where the
// user can actually configure / install / override individual tools. Wired
// as a Command object because chipos.openSettings takes a `tab` argument.
const COMMAND_OPEN_EDA_TAB = {
	id: 'chipos.openSettings',
	title: '',
	arguments: ['edaTools'],
};

export class EdaStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.edaStatusBar';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@ISidecarManagerService private readonly _sidecar: ISidecarManagerService,
		@IWorkerToolManagerService private readonly _workerTools: IWorkerToolManagerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Show "pending" entry immediately so user sees the slot
		this._showPending();

		// React to sidecar state changes
		this._register(this._sidecar.onDidChangeState(state => this._onSidecarStateChange(state)));
		// 2026-05-15 — also react to worker state. The sidecar-only listener
		// misses the case where the reasoner connection (sidecar) stays
		// alive but the worker process dies and respawns: Sidecar.state
		// never changes, so the EDA pill kept showing the stale "⚠️" from
		// the moment the worker first failed. Refresh on every Worker→
		// Connected so the pill flips back to "EDA: 19/24" automatically.
		this._register(this._sidecar.onDidChangeWorkerState(workerState => {
			if (workerState === WorkerState.Connected) {
				this._logService.debug('[EdaStatusBar] worker→Connected, refreshing');
				// Small delay so the worker's HTTP server has time to bind
				// after gRPC registration completes.
				setTimeout(() => this._poll().catch(() => { /* swallow */ }), 500);
			}
		}));
		// Initial state check
		this._onSidecarStateChange(this._sidecar.state);
	}

	async refresh(): Promise<void> {
		await this._poll();
	}

	private _onSidecarStateChange(state: SidecarState): void {
		const connected = state === SidecarState.Connected;
		if (connected) {
			this._startPolling();
		} else {
			this._stopPolling();
			this._showDisconnected();
		}
	}

	private _startPolling(): void {
		if (this._timer) {
			return; // already polling
		}
		setTimeout(() => this._poll().catch(() => { /* swallow */ }), INITIAL_DELAY_MS);
		this._timer = setInterval(() => {
			this._poll().catch(err => this._logService.debug('[EdaStatusBar] poll failed', err));
		}, POLL_INTERVAL_MS);
	}

	private _stopPolling(): void {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = undefined;
		}
	}

	private async _poll(): Promise<void> {
		try {
			const summary = await this._workerTools.getEdaStatusSummary();
			this._showSummary(summary);
		} catch (err) {
			this._logService.debug('[EdaStatusBar] /api/v1/eda/status failed', err);
			this._showError();
		}
	}

	private _showPending(): void {
		this._setEntry({
			name: localize('chipos.eda.statusbar.name', 'ChipOS EDA Tools'),
			text: '$(circuit-board) EDA: …',
			ariaLabel: localize('chipos.eda.statusbar.pending', 'ChipOS EDA Tools status pending'),
			tooltip: localize('chipos.eda.statusbar.pending.tooltip', 'Waiting for worker to report EDA tool status…'),
			command: COMMAND_OPEN_PANEL,
		});
	}

	private _showDisconnected(): void {
		this._setEntry({
			name: localize('chipos.eda.statusbar.name', 'ChipOS EDA Tools'),
			text: '$(circuit-board) EDA: $(debug-disconnect)',
			ariaLabel: localize('chipos.eda.statusbar.disconnected', 'Worker disconnected; EDA tool status unavailable'),
			tooltip: localize('chipos.eda.statusbar.disconnected.tooltip', 'Worker is not connected. Click to open WORKER TOOLS panel.'),
			command: COMMAND_OPEN_PANEL,
		});
	}

	private _showError(): void {
		this._setEntry({
			name: localize('chipos.eda.statusbar.name', 'ChipOS EDA Tools'),
			text: '$(circuit-board) EDA: $(warning)',
			ariaLabel: localize('chipos.eda.statusbar.error', 'EDA status query failed'),
			tooltip: localize('chipos.eda.statusbar.error.tooltip', 'Failed to query EDA status from worker. Click to retry.'),
			command: COMMAND_OPEN_PANEL,
		});
	}

	private _showSummary(summary: EdaStatusSummary): void {
		const ready = summary.installed_mcp_tools;
		const total = summary.total_mcp_tools;
		const allGreen = summary.missing_binaries.length === 0;
		const icon = allGreen ? '$(check)' : '$(circuit-board)';
		const text = `${icon} EDA: ${ready}/${total}`;

		// Build tooltip: by-binary breakdown
		const tooltipLines = [
			localize('chipos.eda.statusbar.summary.header', '**ChipOS EDA Tools — {0}/{1} ready**', ready, total),
			'',
		];
		const sortedBins = Object.entries(summary.by_binary).sort(([a], [b]) => a.localeCompare(b));
		for (const [binary, st] of sortedBins) {
			const mark = st.installed ? '✓' : '✗';
			const affects = st.affects.length === 1 ? '1 tool' : `${st.affects.length} tools`;
			const installHint = st.installed
				? `(${st.version || '?'})`
				: `→ install via \`${st.install_method}\``;
			tooltipLines.push(`${mark} \`${binary}\` — affects ${affects} ${installHint}`);
		}
		if (summary.missing_binaries.length > 0) {
			tooltipLines.push('');
			tooltipLines.push(
				localize('chipos.eda.statusbar.summary.action', 'Click to open EDA Tools settings — install / override / disable individual tools'),
			);
		} else {
			tooltipLines.push('');
			tooltipLines.push(
				localize('chipos.eda.statusbar.summary.action.all', 'Click to open EDA Tools settings'),
			);
		}

		this._setEntry({
			name: localize('chipos.eda.statusbar.name', 'ChipOS EDA Tools'),
			text,
			ariaLabel: summary.summary_line,
			tooltip: { value: tooltipLines.join('\n'), isTrusted: false, supportThemeIcons: true } as any,
			command: COMMAND_OPEN_EDA_TAB,
		});
	}

	private _setEntry(entry: IStatusbarEntry): void {
		if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbar.addEntry(
				entry,
				'chipos.eda.statusbar',
				StatusbarAlignment.RIGHT,
				100,
			);
		}
	}
}

registerWorkbenchContribution2(EdaStatusBarContribution.ID, EdaStatusBarContribution, WorkbenchPhase.AfterRestored);
