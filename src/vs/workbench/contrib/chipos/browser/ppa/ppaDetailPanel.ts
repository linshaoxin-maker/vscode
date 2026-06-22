/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { WebviewInput } from '../../../../../workbench/contrib/webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../../../workbench/contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { IPpaMetrics, IPpaSnapshot } from './ppaStorageService.js';

/** Webview view type used to identify (and revive/reuse) the PPA detail editor. */
const PPA_DETAIL_VIEW_TYPE = 'chipos.ppaDetail';

/**
 * Manages a single, reused webview editor that renders a metrics dashboard for
 * a captured PPA snapshot. Mirrors the lightweight webview-input lifecycle used
 * by {@link RunDetailPanel}: a long-lived input is opened once, and its HTML is
 * swapped when a different snapshot is selected. The dashboard is read-only —
 * its centerpiece is a Baseline | Current | Best | Δ comparison table.
 */
export class PpaDetailPanel extends Disposable {

	private _input: WebviewInput | undefined;
	private readonly _inputDisposables = this._register(new DisposableStore());

	constructor(
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/** Open (or refresh + reveal) the detail dashboard for `snapshot`. */
	open(snapshot: IPpaSnapshot): void {
		if (!snapshot || typeof snapshot.traceId !== 'string') {
			this._logService.warn('[ChipOS] PPA detail requested for an invalid snapshot');
			return;
		}

		const title = localize('chipos.ppa.detail.title', 'PPA: Round {0}', snapshot.round ?? 0);
		const html = this._renderHtml(snapshot);

		if (this._input) {
			this._input.setWebviewTitle(title);
			this._input.webview.setHtml(html);
			this._webviewWorkbenchService.revealWebview(this._input, this._editorService.activeEditorPane?.group ?? ACTIVE_GROUP, false);
			return;
		}

		this._input = this._webviewWorkbenchService.openWebview(
			{
				title,
				options: { tryRestoreScrollPosition: true, enableFindWidget: true },
				contentOptions: { allowScripts: false },
				extension: undefined,
			},
			PPA_DETAIL_VIEW_TYPE,
			title,
			Codicon.graph,
			{ group: ACTIVE_GROUP, preserveFocus: false },
		);

		this._inputDisposables.add(this._input.onWillDispose(() => {
			this._inputDisposables.clear();
			this._input = undefined;
		}));

		this._input.webview.setHtml(html);
	}

	private _renderHtml(snapshot: IPpaSnapshot): string {
		const stageClass = `stage-${cssToken(snapshot.stage)}`;
		const stageLabel = escape(snapshot.stage.replace(/_/g, ' ').toUpperCase());

		const metaBits: string[] = [];
		if (snapshot.strategy) {
			metaBits.push(escape(snapshot.strategy));
		}
		metaBits.push(escape(localize('chipos.ppa.detail.round', 'Round {0}', snapshot.round ?? 0)));
		metaBits.push(escape(snapshot.traceId));
		const meta = metaBits.join(' &middot; ');

		const rows: { label: string; key: keyof IPpaMetrics; decimals?: number }[] = [
			{ label: localize('chipos.ppa.detail.metric.area', 'Area'), key: 'area' },
			{ label: localize('chipos.ppa.detail.metric.delay', 'Delay (ns)'), key: 'delay_ns', decimals: 3 },
			{ label: localize('chipos.ppa.detail.metric.power', 'Power (W)'), key: 'power_w', decimals: 4 },
			{ label: localize('chipos.ppa.detail.metric.wns', 'WNS'), key: 'wns', decimals: 3 },
			{ label: localize('chipos.ppa.detail.metric.tns', 'TNS'), key: 'tns', decimals: 3 },
		];

		const tableRows = rows.map(row => {
			const baseline = snapshot.baseline?.[row.key];
			const current = snapshot.current?.[row.key];
			const best = snapshot.best?.[row.key];
			const delta = deltaFor(snapshot, row.key, baseline, current);
			return `<tr>
				<th scope="row">${escape(row.label)}</th>
				<td>${formatNumber(baseline, row.decimals)}</td>
				<td class="current">${formatNumber(current, row.decimals)}</td>
				<td>${formatNumber(best, row.decimals)}</td>
				<td class="${delta.className}">${delta.text}</td>
			</tr>`;
		}).join('');

		const headers = {
			metric: escape(localize('chipos.ppa.detail.col.metric', 'Metric')),
			baseline: escape(localize('chipos.ppa.detail.col.baseline', 'Baseline')),
			current: escape(localize('chipos.ppa.detail.col.current', 'Current')),
			best: escape(localize('chipos.ppa.detail.col.best', 'Best')),
			delta: escape(localize('chipos.ppa.detail.col.delta', 'Δ')),
		};

		const heading = escape(snapshot.strategy ?? localize('chipos.ppa.detail.heading', 'PPA Optimization'));
		const metricsLabel = escape(localize('chipos.ppa.detail.metrics', 'Metrics'));

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<style>
	body {
		margin: 0;
		padding: 16px 20px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground);
		background: transparent;
	}
	header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
	h1 { font-size: 1.25em; font-weight: 600; margin: 0; }
	h2 {
		font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--vscode-descriptionForeground); margin: 22px 0 8px;
	}
	.badge {
		display: inline-block; padding: 2px 9px; border-radius: 10px;
		font-size: 0.72em; font-weight: 700; letter-spacing: 0.05em;
		color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
	}
	.badge.stage-improved { background: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); color: var(--vscode-editor-background); }
	.badge.stage-not-improved { background: var(--vscode-charts-red, var(--vscode-testing-iconFailed)); color: var(--vscode-editor-background); }
	.badge.stage-eval-round { background: var(--vscode-charts-blue, var(--vscode-testing-iconQueued)); color: var(--vscode-editor-background); }
	.badge.stage-baseline { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 0 0 4px; }
	section { margin: 0; }
	table {
		width: 100%; border-collapse: collapse;
		font-variant-numeric: tabular-nums;
	}
	th, td {
		text-align: right; padding: 7px 10px;
		border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	}
	thead th {
		text-align: right; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em;
		color: var(--vscode-descriptionForeground); font-weight: 600;
		border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	}
	thead th:first-child, tbody th { text-align: left; }
	tbody th {
		font-weight: 500; color: var(--vscode-foreground);
	}
	td.current { color: var(--vscode-foreground); font-weight: 600; }
	td.delta-up { color: var(--vscode-charts-green, var(--vscode-gitDecoration-addedResourceForeground)); }
	td.delta-down { color: var(--vscode-charts-red, var(--vscode-gitDecoration-deletedResourceForeground)); }
	td.delta-none { color: var(--vscode-descriptionForeground); }
	tbody tr:hover { background: var(--vscode-list-hoverBackground); }
	.empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px 8px; }
</style>
</head>
<body>
	<header>
		<span class="badge ${stageClass}">${stageLabel}</span>
		<h1>${heading}</h1>
	</header>
	<p class="meta">${meta}</p>

	<section>
		<h2>${metricsLabel}</h2>
		<table>
			<thead>
				<tr>
					<th scope="col">${headers.metric}</th>
					<th scope="col">${headers.baseline}</th>
					<th scope="col">${headers.current}</th>
					<th scope="col">${headers.best}</th>
					<th scope="col">${headers.delta}</th>
				</tr>
			</thead>
			<tbody>
				${tableRows}
			</tbody>
		</table>
	</section>
</body>
</html>`;
	}
}

/** Outcome of a single Δ cell: the rendered text plus a directional class. */
interface IDeltaCell {
	readonly text: string;
	readonly className: string;
}

/**
 * Compute the Δ cell for a metric: prefer the explicit `improvement` map entry
 * (a percentage) when present, otherwise derive a current-vs-baseline percent.
 * Lower is better for every PPA metric, so a reduction renders as a positive
 * (green) improvement.
 */
function deltaFor(snapshot: IPpaSnapshot, key: keyof IPpaMetrics, baseline: number | undefined, current: number | undefined): IDeltaCell {
	const explicit = snapshot.improvement?.[key];
	if (typeof explicit === 'number' && isFinite(explicit)) {
		return percentCell(explicit);
	}
	if (typeof baseline === 'number' && typeof current === 'number' && baseline !== 0) {
		// Reduction relative to baseline, expressed as a positive improvement.
		const percent = ((baseline - current) / Math.abs(baseline)) * 100;
		return percentCell(percent);
	}
	return { text: '—', className: 'delta-none' };
}

/** Render a signed percentage cell with a directional class. */
function percentCell(percent: number): IDeltaCell {
	if (!isFinite(percent) || Math.abs(percent) < 0.005) {
		return { text: '0%', className: 'delta-none' };
	}
	const sign = percent > 0 ? '+' : '−';
	const text = `${sign}${Math.abs(percent).toFixed(1)}%`;
	return { text, className: percent > 0 ? 'delta-up' : 'delta-down' };
}

/** Format a metric value, applying fixed decimals when given, else locale grouping. */
function formatNumber(value: number | undefined, decimals?: number): string {
	if (typeof value !== 'number' || !isFinite(value)) {
		return '—';
	}
	if (typeof decimals === 'number') {
		return value.toFixed(decimals);
	}
	return value.toLocaleString();
}

/** Normalise a stage string into a CSS-class-safe token (e.g. `not_improved` → `not-improved`). */
function cssToken(stage: string): string {
	return stage.replace(/_/g, '-').replace(/[^a-z0-9-]/gi, '');
}

/** HTML-escape a string for safe inline interpolation. */
function escape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
