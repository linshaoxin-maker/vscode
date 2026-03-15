/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';

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
