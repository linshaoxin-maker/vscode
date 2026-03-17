/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaLintReport } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection, edaTable, edaBadge, edaSummaryRow } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaLintReportContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaLintReport,
	) {
		super();

		const rows = (content.errors ?? []).map(e => [
			e.file,
			String(e.line),
			e.severity,
			e.message,
			e.rule ?? '-',
			e.auto_fixable ? 'Yes' : '-',
		]);

		const table = edaTable(['File', 'Line', 'Severity', 'Message', 'Rule', 'Fixable'], rows);

		for (let i = 0; i < table.querySelectorAll('tbody tr').length; i++) {
			const tr = table.querySelectorAll('tbody tr')[i];
			const severityCell = tr.querySelectorAll('td')[2];
			const severity = content.errors[i]?.severity ?? 'info';
			severityCell.textContent = '';
			severityCell.appendChild(edaBadge(severity, severity === 'error' ? 'fail' : severity === 'warning' ? 'warning' : 'info'));
		}

		const children: HTMLElement[] = [table];

		const summary = $('div.eda-summary');
		summary.appendChild(edaSummaryRow('Total Issues', String(content.errors?.length ?? 0)));
		if (content.auto_fixable !== undefined) {
			summary.appendChild(edaSummaryRow('Auto-fixable', String(content.auto_fixable)));
		}
		if (content.tool) {
			summary.appendChild(edaSummaryRow('Tool', content.tool));
		}
		children.push(summary);

		this.domNode = edaSection(`Lint Report${content.tool ? ` (${content.tool})` : ''}`, ...children);
		this.domNode.classList.add('eda-lint-report');
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaLintReport') {
			return false;
		}
		const o = other as IChatEdaLintReport;
		return o.errors?.length === this.content.errors?.length;
	}
}
