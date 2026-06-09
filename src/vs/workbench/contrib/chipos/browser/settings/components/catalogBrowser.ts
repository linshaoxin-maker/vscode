/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { CatalogEntry, catalogCategories, filterCatalogEntries } from '../../resources/catalogClient.js';

export interface ICatalogBrowserCallbacks {
	/** Install a catalog entry. The host wires the confirm + git-clone flow. */
	readonly install: (entry: CatalogEntry) => void;
}

const ALL_CATEGORIES = '__all__';

/**
 * FEAT-006b — render the plugin catalog browser into `container`: a search box +
 * category filter over the entries, a filtered result list, and a per-entry detail
 * view (description / category / author / repo) with an Install action. Filtering
 * uses the pure `filterCatalogEntries` / `catalogCategories` from catalogClient, so
 * the searchable behaviour is unit-tested independently of this DOM.
 */
export function renderCatalogBrowser(container: HTMLElement, entries: readonly CatalogEntry[], cb: ICatalogBrowserCallbacks, store: DisposableStore): void {
	let query = '';
	let category = ALL_CATEGORIES;

	// ── toolbar: search + category ──
	const toolbar = dom.append(container, dom.$('.chipos-catalog-toolbar'));
	const search = dom.append(toolbar, dom.$<HTMLInputElement>('input.chipos-catalog-search'));
	search.type = 'text';
	search.placeholder = localize('chipos.catalog.search', 'Search plugins…');
	const select = dom.append(toolbar, dom.$<HTMLSelectElement>('select.chipos-catalog-category'));
	const optAll = dom.append(select, dom.$<HTMLOptionElement>('option'));
	optAll.value = ALL_CATEGORIES;
	optAll.textContent = localize('chipos.catalog.allCategories', 'All categories');
	for (const c of catalogCategories(entries)) {
		const o = dom.append(select, dom.$<HTMLOptionElement>('option'));
		o.value = c;
		o.textContent = c;
	}

	const list = dom.append(container, dom.$('.chipos-catalog-list'));
	const detail = dom.append(container, dom.$('.chipos-catalog-detail'));
	detail.style.display = 'none';

	const showDetail = (entry: CatalogEntry): void => {
		dom.clearNode(detail);
		detail.style.display = '';
		dom.append(detail, dom.$('.chipos-settings-section-title', undefined, entry.name));
		if (entry.description) {
			dom.append(detail, dom.$('.chipos-setting-description', undefined, entry.description));
		}
		const facts = dom.append(detail, dom.$('.chipos-catalog-facts'));
		const fact = (label: string, value: string): void => { dom.append(facts, dom.$('div', undefined, `${label}: ${value}`)); };
		if (entry.category) { fact(localize('chipos.catalog.category', 'Category'), entry.category); }
		if (entry.author) { fact(localize('chipos.catalog.author', 'Author'), entry.author); }
		if (entry.verified) { fact(localize('chipos.catalog.status', 'Status'), localize('chipos.catalog.verified', 'verified')); }
		fact(localize('chipos.catalog.repo', 'Repository'), entry.repo);
		const actions = dom.append(detail, dom.$('.chipos-rule-actions'));
		const installBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		installBtn.textContent = localize('chipos.catalog.install', 'Install');
		store.add(dom.addDisposableListener(installBtn, 'click', () => cb.install(entry)));
		const backBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		backBtn.textContent = localize('chipos.catalog.back', 'Back to List');
		store.add(dom.addDisposableListener(backBtn, 'click', () => { detail.style.display = 'none'; }));
	};

	const renderList = (): void => {
		dom.clearNode(list);
		detail.style.display = 'none';
		const filtered = filterCatalogEntries(entries, query, category === ALL_CATEGORIES ? undefined : category);
		if (filtered.length === 0) {
			dom.append(list, dom.$('.chipos-setting-description', undefined, localize('chipos.catalog.noMatch', 'No plugins match your filter.')));
			return;
		}
		for (const entry of filtered) {
			const row = dom.append(list, dom.$('.chipos-rule-item'));
			const nameCell = dom.append(row, dom.$('.chipos-rule-name'));
			dom.append(nameCell, dom.$('span', undefined, entry.name));
			const meta = dom.append(nameCell, dom.$('span.chipos-catalog-meta'));
			meta.style.marginLeft = '8px';
			meta.style.fontSize = '11px';
			meta.style.color = 'var(--vscode-descriptionForeground)';
			meta.textContent = [
				entry.category,
				entry.verified ? localize('chipos.catalog.verified', 'verified') : undefined,
				entry.description,
			].filter(Boolean).join(' · ');
			const actions = dom.append(row, dom.$('.chipos-rule-actions'));
			const detailsBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
			detailsBtn.textContent = localize('chipos.catalog.details', 'Details');
			store.add(dom.addDisposableListener(detailsBtn, 'click', () => showDetail(entry)));
			const installBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
			installBtn.textContent = localize('chipos.catalog.install', 'Install');
			store.add(dom.addDisposableListener(installBtn, 'click', () => cb.install(entry)));
		}
	};

	store.add(dom.addDisposableListener(search, 'input', () => { query = search.value; renderList(); }));
	store.add(dom.addDisposableListener(select, 'change', () => { category = select.value; renderList(); }));
	renderList();
}
