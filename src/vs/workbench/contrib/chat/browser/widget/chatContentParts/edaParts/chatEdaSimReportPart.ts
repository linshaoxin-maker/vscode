/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaSimReport } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaTable, edaSection, edaBadge, edaSummaryRow } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaSimReportContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaSimReport,
	) {
		super();

		const rows = (content.tests ?? []).map(t => [
			t.name,
			t.status,
			t.message || '-',
			t.duration_ms !== undefined ? `${t.duration_ms}ms` : '-',
		]);

		const table = edaTable(['Test', 'Status', 'Message', 'Duration'], rows);

		for (let i = 0; i < table.querySelectorAll('tbody tr').length; i++) {
			const tr = table.querySelectorAll('tbody tr')[i];
			const statusCell = tr.querySelectorAll('td')[1];
			const status = content.tests[i]?.status ?? 'skip';
			statusCell.textContent = '';
			statusCell.appendChild(edaBadge(status, status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : status === 'error' ? 'error' : 'skip'));
		}

		const summary = $('div.eda-summary');
		if (content.summary) {
			const s = content.summary;
			summary.appendChild(edaSummaryRow('Total', String(s.total)));
			summary.appendChild(edaSummaryRow('Passed', String(s.passed)));
			summary.appendChild(edaSummaryRow('Failed', String(s.failed)));
			if (s.errors !== undefined) {
				summary.appendChild(edaSummaryRow('Errors', String(s.errors)));
			}
		}

		this.domNode = edaSection('Simulation Report', table, summary);
		this.domNode.classList.add('eda-sim-report');
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaSimReport') {
			return false;
		}
		const o = other as IChatEdaSimReport;
		return o.tests?.length === this.content.tests?.length;
	}
}
