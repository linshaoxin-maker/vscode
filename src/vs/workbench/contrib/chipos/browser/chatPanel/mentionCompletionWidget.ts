/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import type { IMentionItem } from 'vs/workbench/contrib/chipos/browser/eventStream/eventTypes';

const $ = dom.$;

const ICON_MAP: Record<string, string> = {
	file: '📄',
	folder: '📁',
	snippet: '✂️',
};

export class MentionCompletionWidget extends Disposable {

	private readonly _el: HTMLElement;
	private _items: IMentionItem[] = [];
	private _activeIndex = 0;
	private _visible = false;

	private readonly _onDidSelectItem = this._register(new Emitter<IMentionItem>());
	readonly onDidSelectItem: Event<IMentionItem> = this._onDidSelectItem.event;

	private readonly _onDidCancel = this._register(new Emitter<void>());
	readonly onDidCancel: Event<void> = this._onDidCancel.event;

	constructor(parent: HTMLElement) {
		super();

		this._el = $('div.chipos-mention-completion');
		this._el.style.display = 'none';
		parent.appendChild(this._el);

		this._register(dom.addDisposableListener(this._el, 'mousedown', (e: MouseEvent) => {
			e.preventDefault();
		}));
	}

	// ── Public API ──────────────────────────────────────────────────────────

	get isVisible(): boolean {
		return this._visible;
	}

	show(items: IMentionItem[], anchorRect: DOMRect): void {
		this._items = items;
		this._activeIndex = 0;

		dom.clearNode(this._el);

		if (items.length === 0) {
			const empty = $('div.chipos-mention-empty');
			empty.textContent = 'No results';
			this._el.appendChild(empty);
		} else {
			for (let i = 0; i < items.length; i++) {
				const row = this._renderItem(items[i], i);
				this._el.appendChild(row);
			}
			this._highlightActive();
		}

		this._positionAt(anchorRect);
		this._el.style.display = '';
		this._visible = true;
	}

	hide(): void {
		this._el.style.display = 'none';
		this._visible = false;
		this._items = [];
		dom.clearNode(this._el);
	}

	selectPrevious(): void {
		if (this._items.length === 0) {
			return;
		}
		this._activeIndex = (this._activeIndex - 1 + this._items.length) % this._items.length;
		this._highlightActive();
		this._scrollActiveIntoView();
	}

	selectNext(): void {
		if (this._items.length === 0) {
			return;
		}
		this._activeIndex = (this._activeIndex + 1) % this._items.length;
		this._highlightActive();
		this._scrollActiveIntoView();
	}

	acceptSelected(): void {
		if (this._items.length === 0) {
			return;
		}
		const item = this._items[this._activeIndex];
		if (item) {
			this._onDidSelectItem.fire(item);
		}
	}

	// ── Rendering ───────────────────────────────────────────────────────────

	private _renderItem(item: IMentionItem, index: number): HTMLElement {
		const row = $('div.chipos-mention-item');
		row.dataset.index = String(index);

		const icon = $('span.chipos-mention-item-icon');
		icon.textContent = ICON_MAP[item.type] ?? '📄';
		row.appendChild(icon);

		const info = $('div.chipos-mention-item-info');

		const name = $('div.chipos-mention-item-name');
		name.textContent = item.displayName;
		info.appendChild(name);

		const path = $('div.chipos-mention-item-path');
		path.textContent = item.path;
		info.appendChild(path);

		row.appendChild(info);

		this._register(dom.addDisposableListener(row, 'click', () => {
			this._onDidSelectItem.fire(item);
		}));

		this._register(dom.addDisposableListener(row, 'mouseenter', () => {
			this._activeIndex = index;
			this._highlightActive();
		}));

		return row;
	}

	private _highlightActive(): void {
		const children = this._el.querySelectorAll('.chipos-mention-item');
		children.forEach((child, i) => {
			child.classList.toggle('chipos-mention-item-active', i === this._activeIndex);
		});
	}

	private _scrollActiveIntoView(): void {
		const active = this._el.querySelector('.chipos-mention-item-active');
		if (active) {
			active.scrollIntoView({ block: 'nearest' });
		}
	}

	private _positionAt(anchorRect: DOMRect): void {
		const parentRect = this._el.parentElement?.getBoundingClientRect();
		if (!parentRect) {
			return;
		}

		const left = anchorRect.left - parentRect.left;
		const spaceBelow = parentRect.bottom - anchorRect.bottom;
		const spaceAbove = anchorRect.top - parentRect.top;

		if (spaceBelow >= 300 || spaceBelow >= spaceAbove) {
			this._el.style.top = `${anchorRect.bottom - parentRect.top}px`;
			this._el.style.bottom = '';
		} else {
			this._el.style.bottom = `${parentRect.bottom - anchorRect.top}px`;
			this._el.style.top = '';
		}

		this._el.style.left = `${Math.max(0, left)}px`;
	}

	override dispose(): void {
		this.hide();
		this._el.remove();
		super.dispose();
	}
}
