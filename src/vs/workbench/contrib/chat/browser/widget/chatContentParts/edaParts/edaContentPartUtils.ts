/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';

const $ = dom.$;

export function edaTable(headers: string[], rows: string[][]): HTMLElement {
	const table = $('table.eda-table');
	const thead = $('thead');
	const headerRow = $('tr');
	for (const h of headers) {
		const th = $('th');
		th.textContent = h;
		headerRow.appendChild(th);
	}
	thead.appendChild(headerRow);
	table.appendChild(thead);

	const tbody = $('tbody');
	for (const row of rows) {
		const tr = $('tr');
		for (const cell of row) {
			const td = $('td');
			td.textContent = cell;
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	return table;
}

export function edaSection(title: string, ...children: HTMLElement[]): HTMLElement {
	const section = $('div.eda-section');
	const header = $('h3.eda-section-title');
	header.textContent = title;
	section.appendChild(header);
	for (const child of children) {
		section.appendChild(child);
	}
	return section;
}

export function edaBadge(text: string, variant: 'pass' | 'fail' | 'error' | 'warning' | 'info' | 'skip' | 'pending' | 'running' | 'done'): HTMLElement {
	const badge = $(`span.eda-badge.eda-badge-${variant}`);
	badge.textContent = text;
	return badge;
}

export function edaSummaryRow(label: string, value: string): HTMLElement {
	const row = $('div.eda-summary-row');
	const labelEl = $('span.eda-summary-label');
	labelEl.textContent = label;
	const valueEl = $('span.eda-summary-value');
	valueEl.textContent = value;
	row.appendChild(labelEl);
	row.appendChild(valueEl);
	return row;
}

export function edaProgressBar(progress: number): HTMLElement {
	const container = $('div.eda-progress-bar');
	const fill = $('div.eda-progress-fill');
	fill.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
	container.appendChild(fill);
	return container;
}

/**
 * A flex row container for action buttons. Reuses the `.eda-spec-actions`
 * styling first introduced by the Spec Review card so all EDA report cards share
 * one button layout.
 */
export function edaButtonRow(): HTMLElement {
	return $('div.eda-actions.eda-spec-actions');
}

/**
 * Create a single action button reusing the `.eda-spec-btn` styling. The caller
 * owns the returned disposable (the click listener) and must register it for
 * disposal. `primary` renders the accent (filled) variant.
 *
 * Pattern factored out of chatEdaSpecReviewPart so the Lint / Coverage / Sim
 * report cards can mount interactive buttons (Open File / Fix / Waveform …)
 * without duplicating the button markup or styling.
 */
export function edaButton(label: string, onClick: () => void, primary = false): { button: HTMLButtonElement; listener: IDisposable } {
	const button = document.createElement('button');
	button.className = primary ? 'eda-spec-btn eda-spec-btn-primary' : 'eda-spec-btn';
	button.textContent = label;
	button.setAttribute('type', 'button');
	const listener = dom.addDisposableListener(button, 'click', () => onClick());
	return { button, listener };
}

/**
 * Open a workspace file in the editor, optionally revealing a 1-based line. Used
 * by the "Open File" action on the Lint / Coverage / Sim cards to make their
 * file:line references jump-to-source. Best-effort: never throws so a missing
 * file leaves the card intact.
 */
export async function edaOpenFile(editorService: IEditorService, filePath: string, line?: number): Promise<void> {
	if (!filePath) {
		return;
	}
	try {
		await editorService.openEditor({
			resource: URI.file(filePath),
			options: typeof line === 'number' && line > 0
				? { selection: { startLineNumber: line, startColumn: 1 } }
				: undefined,
		});
	} catch {
		// best-effort — keep the card intact if the file can't be opened
	}
}
