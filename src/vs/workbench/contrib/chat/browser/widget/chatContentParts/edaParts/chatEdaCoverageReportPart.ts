/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaCoverageReport } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection, edaSummaryRow, edaProgressBar, edaTable } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaCoverageReportContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaCoverageReport,
	) {
		super();

		const metrics = $('div.eda-coverage-metrics');

		const lineRow = $('div.eda-metric-row');
		lineRow.appendChild(edaSummaryRow('Line Coverage', `${(content.line_cov * 100).toFixed(1)}%`));
		lineRow.appendChild(edaProgressBar(content.line_cov));
		metrics.appendChild(lineRow);

		const branchRow = $('div.eda-metric-row');
		branchRow.appendChild(edaSummaryRow('Branch Coverage', `${(content.branch_cov * 100).toFixed(1)}%`));
		branchRow.appendChild(edaProgressBar(content.branch_cov));
		metrics.appendChild(branchRow);

		const children: HTMLElement[] = [metrics];

		if (content.gaps && content.gaps.length > 0) {
			const rows = content.gaps.map(g => [g.file, g.lines, g.type ?? '-']);
			children.push(edaTable(['File', 'Lines', 'Type'], rows));
		}

		this.domNode = edaSection('Coverage Report', ...children);
		this.domNode.classList.add('eda-coverage-report');
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaCoverageReport') {
			return false;
		}
		const o = other as IChatEdaCoverageReport;
		return o.line_cov === this.content.line_cov && o.branch_cov === this.content.branch_cov;
	}
}
