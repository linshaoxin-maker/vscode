/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { IChatEdaLintReport } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection, edaTable, edaBadge, edaSummaryRow, edaButton, edaOpenFile } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaLintReportContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaLintReport,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		const errors = content.errors ?? [];
		// Trailing "Open" column so each issue can jump to its file:line in the editor.
		const rows = errors.map(e => [
			e.file,
			String(e.line),
			e.severity,
			e.message,
			e.rule ?? '-',
			e.auto_fixable ? 'Yes' : '-',
			'',
		]);

		const table = edaTable(['File', 'Line', 'Severity', 'Message', 'Rule', 'Fixable', ''], rows);

		const bodyRows = table.querySelectorAll('tbody tr');
		for (let i = 0; i < bodyRows.length; i++) {
			const tr = bodyRows[i];
			const cells = tr.querySelectorAll('td');
			const error = errors[i];

			// Severity badge.
			const severityCell = cells[2];
			const severity = error?.severity ?? 'info';
			severityCell.textContent = '';
			severityCell.appendChild(edaBadge(severity, severity === 'error' ? 'fail' : severity === 'warning' ? 'warning' : 'info'));

			// Open File action — jumps to the offending line.
			const actionCell = cells[6];
			if (error?.file) {
				const { button, listener } = edaButton(
					localize('chipos.lintReport.open', "Open"),
					() => void edaOpenFile(this.editorService, error.file, error.line),
				);
				button.classList.add('eda-row-btn');
				this._register(listener);
				actionCell.appendChild(button);
			}
		}

		const children: HTMLElement[] = [table];

		const summary = $('div.eda-summary');
		summary.appendChild(edaSummaryRow('Total Issues', String(errors.length)));
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
