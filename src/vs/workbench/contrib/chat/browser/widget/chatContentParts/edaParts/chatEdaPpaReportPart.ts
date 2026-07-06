/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IChatEdaPpaReport, IChatEdaPpaMetrics } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaTable, edaSection, edaBadge, edaSummaryRow } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

function fmtNum(v: number | undefined, unit: string, precision = 2): string {
	if (v === undefined || v === null || v < 0) { return '-'; }
	return `${v.toFixed(precision)} ${unit}`;
}

// `improvement` is ALREADY a percentage (ppa_optimize_loop._calc_improvement:
// (baseline-current)/baseline*100). Do NOT re-scale ×100 (was rendering 8.3% as
// 830%). Matches the ext's formatImprovement + the CLI's ppaImpTail.
function fmtPct(v: number | undefined): string {
	if (v === undefined || v === null) { return '-'; }
	const sign = v > 0 ? '+' : '';
	return `${sign}${v.toFixed(1)}%`;
}

function metricsRow(label: string, m: IChatEdaPpaMetrics | undefined): string[] {
	if (!m) { return [label, '-', '-', '-']; }
	return [
		label,
		fmtNum(m.area, ''),
		fmtNum(m.delay_ns, 'ns'),
		fmtNum(m.power_w, 'W', 4),
	];
}

export class ChatEdaPpaReportContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaPpaReport,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		const container = $('div.eda-ppa-report');

		// Stage badge
		const stageLabel = this._stageLabel(content.stage);
		const stageBadge = edaBadge(stageLabel, content.stage === 'improved' ? 'pass' : content.stage === 'not_improved' ? 'fail' : 'info');
		const header = $('div.eda-ppa-header');
		header.appendChild(stageBadge);
		if (content.round !== undefined) {
			header.appendChild($('span.eda-ppa-round', undefined, localize('chipos.ppa.round', "轮次 {0}", content.round)));
		}
		if (content.strategy) {
			header.appendChild($('span.eda-ppa-strategy', undefined, content.strategy));
		}
		container.appendChild(header);

		// PPA comparison table
		const rows: string[][] = [];
		if (content.stage === 'baseline') {
			rows.push(metricsRow(localize('chipos.ppa.row.baseline', "基线"), content.ppa));
		} else {
			rows.push(metricsRow(localize('chipos.ppa.row.baseline2', "基线"), content.baseline_ppa));
			if (content.previous_best_ppa) {
				rows.push(metricsRow(localize('chipos.ppa.row.prevBest', "前最优"), content.previous_best_ppa));
			}
			rows.push(metricsRow(localize('chipos.ppa.row.current', "当前"), content.current_ppa ?? content.ppa));
			if (content.best_ppa) {
				rows.push(metricsRow(localize('chipos.ppa.row.best', "最优"), content.best_ppa));
			}
		}
		const table = edaTable(['', 'Area', 'Delay', 'Power'], rows);
		container.appendChild(table);

		// Improvement summary
		if (content.improvement) {
			const imp = content.improvement;
			const summary = $('div.eda-summary');
			if (imp.area !== undefined) { summary.appendChild(edaSummaryRow('Area Δ', fmtPct(imp.area))); }
			if (imp.delay_ns !== undefined) { summary.appendChild(edaSummaryRow('Delay Δ', fmtPct(imp.delay_ns))); }
			if (imp.power_w !== undefined) { summary.appendChild(edaSummaryRow('Power Δ', fmtPct(imp.power_w))); }
			container.appendChild(summary);
		}

		// STA / Power reports (collapsible)
		if (content.sta_report) {
			container.appendChild(this._collapsible('Timing Report (STA)', content.sta_report));
		}
		if (content.power_report) {
			container.appendChild(this._collapsible('Power Report', content.power_report));
		}

		// Chat → status-bar → editor linkage: open the full PPA dashboard as an
		// editor tab. No argument means "latest snapshot", which is exactly the
		// one this card was rendered from (same ppa_report event).
		const actions = $('div.eda-ppa-actions');
		const openBtn = document.createElement('button');
		openBtn.className = 'eda-spec-btn';
		openBtn.type = 'button';
		openBtn.textContent = localize('chipos.ppa.openDashboard', "打开仪表盘 ↗");
		this._register(dom.addDisposableListener(openBtn, 'click', () => {
			this.commandService.executeCommand('chipos.ppa.openDetail');
		}));
		actions.appendChild(openBtn);
		container.appendChild(actions);

		this.domNode = edaSection(localize('chipos.ppaReport.title', "PPA 报告"), container);
		this.domNode.classList.add('eda-ppa-report-section');
	}

	private _stageLabel(stage: string): string {
		switch (stage) {
			case 'baseline': return localize('chipos.ppa.stage.baseline', "基线");
			case 'eval_round': return localize('chipos.ppa.stage.eval', "评估");
			case 'improved': return localize('chipos.ppa.stage.improved', "已改进 ✓");
			case 'not_improved': return localize('chipos.ppa.stage.notImproved', "未改进");
			default: return stage;
		}
	}

	private _collapsible(title: string, text: string): HTMLElement {
		const details = document.createElement('details');
		details.classList.add('eda-ppa-details');
		const summary = document.createElement('summary');
		summary.textContent = title;
		details.appendChild(summary);
		const pre = $('pre.eda-ppa-report-text', undefined, text);
		details.appendChild(pre);
		return details;
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaPpaReport') {
			return false;
		}
		const o = other as IChatEdaPpaReport;
		return o.stage === this.content.stage && o.round === this.content.round;
	}
}
