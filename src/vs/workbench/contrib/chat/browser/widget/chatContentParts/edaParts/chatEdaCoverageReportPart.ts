/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { IChatEdaCoverageReport } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection, edaSummaryRow, edaProgressBar, edaTable, edaBadge } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

/**
 * Coverage values arrive as either a 0-1 fraction (legacy WS payloads) or a
 * 0-100 percentage (backend_v2 coverage_boost emits `covered/total*100`).
 * Normalize for display by treating `<= 1` as a fraction. A literal 1% sent as
 * `1.0` would render as 100%, but 100% is the common/important case and a 1%
 * coverage run is degenerate — the alternative (no normalization) renders the
 * common 85% case as "8500%".
 */
function toPercent(v: number): number {
	return v <= 1 ? v * 100 : v;
}
function toFraction(v: number): number {
	return v <= 1 ? v : v / 100;
}

/** 90/70 threshold colour bands — parity with vscode-extension reportCards.js:55-58. */
function covBadgeVariant(pct: number): 'pass' | 'warning' | 'fail' {
	return pct >= 90 ? 'pass' : pct >= 70 ? 'warning' : 'fail';
}

export class ChatEdaCoverageReportContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaCoverageReport,
	) {
		super();

		const metrics = $('div.eda-coverage-metrics');

		// P1-3: render overall (aggregate) first when present, then line / branch,
		// then toggle when present — each with a 90/70 threshold badge alongside the
		// IDE's progress bar. Mirrors vscode-extension reportCards.js:53 (overall /
		// line / branch / toggle four-row table) while keeping the IDE bar.
		if (typeof content.overall_cov === 'number') {
			metrics.appendChild(this._metricRow('Overall Coverage', content.overall_cov));
		}
		metrics.appendChild(this._metricRow('Line Coverage', content.line_cov));
		metrics.appendChild(this._metricRow('Branch Coverage', content.branch_cov));
		if (typeof content.toggle_cov === 'number') {
			metrics.appendChild(this._metricRow('Toggle Coverage', content.toggle_cov));
		}

		const children: HTMLElement[] = [metrics];

		if (typeof content.target === 'number') {
			const targetEl = $('div.eda-coverage-target');
			targetEl.textContent = `Target: ${toPercent(content.target).toFixed(0)}%`;
			children.push(targetEl);
		}

		if (content.gaps && content.gaps.length > 0) {
			const rows = content.gaps.map(g => [g.file, g.lines, g.type ?? '-']);
			children.push(edaTable(['File', 'Lines', 'Type'], rows));
		}

		this.domNode = edaSection(localize('chipos.eda.coverageTitle', "覆盖率报告"), ...children);
		this.domNode.classList.add('eda-coverage-report');
	}

	private _metricRow(label: string, value: number | undefined): HTMLElement {
		const row = $('div.eda-metric-row');
		const summary = edaSummaryRow(label, '');
		const valueSlot = summary.querySelector('.eda-summary-value');
		if (typeof value === 'number') {
			const pct = toPercent(value);
			// Replace the plain value with a coloured threshold badge + keep the bar.
			valueSlot?.appendChild(edaBadge(`${pct.toFixed(1)}%`, covBadgeVariant(pct)));
			row.appendChild(summary);
			row.appendChild(edaProgressBar(toFraction(value)));
		} else {
			// Metric not measured on this run (e.g. coverage text-fallback) — show
			// N/A instead of a misleading 0% with a FAIL badge.
			if (valueSlot) {
				valueSlot.textContent = 'N/A';
			}
			row.appendChild(summary);
		}
		return row;
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaCoverageReport') {
			return false;
		}
		const o = other as IChatEdaCoverageReport;
		return o.line_cov === this.content.line_cov
			&& o.branch_cov === this.content.branch_cov
			&& o.toggle_cov === this.content.toggle_cov
			&& o.overall_cov === this.content.overall_cov;
	}
}
