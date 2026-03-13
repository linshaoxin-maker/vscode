/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import * as dom from '../../../../../base/browser/dom.js';

const $ = dom.$;

/**
 * Floating summary bar showing total change count with Accept All / Reject All buttons.
 */
export class DiffSummaryWidget extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _summaryText: HTMLSpanElement;

	private readonly _onDidAcceptAll = this._register(new Emitter<void>());
	readonly onDidAcceptAll: Event<void> = this._onDidAcceptAll.event;

	private readonly _onDidRejectAll = this._register(new Emitter<void>());
	readonly onDidRejectAll: Event<void> = this._onDidRejectAll.event;

	constructor() {
		super();

		this._domNode = $('div.chipos-diff-summary');

		this._summaryText = $('span.chipos-diff-summary-text');
		this._summaryText.textContent = '0 changes in 0 files';
		this._domNode.appendChild(this._summaryText);

		const acceptAllBtn = $('button.chipos-diff-accept-all');
		acceptAllBtn.textContent = 'Accept All';
		this._register(dom.addDisposableListener(acceptAllBtn, 'click', (e) => {
			dom.EventHelper.stop(e, true);
			this._onDidAcceptAll.fire();
		}));
		this._domNode.appendChild(acceptAllBtn);

		const rejectAllBtn = $('button.chipos-diff-reject-all');
		rejectAllBtn.textContent = 'Reject All';
		this._register(dom.addDisposableListener(rejectAllBtn, 'click', (e) => {
			dom.EventHelper.stop(e, true);
			this._onDidRejectAll.fire();
		}));
		this._domNode.appendChild(rejectAllBtn);
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	update(fileCount: number, hunkCount: number): void {
		const changeTxt = hunkCount === 1 ? '1 change' : `${hunkCount} changes`;
		const fileTxt = fileCount === 1 ? '1 file' : `${fileCount} files`;
		this._summaryText.textContent = `${changeTxt} in ${fileTxt}`;
	}

	show(): void {
		this._domNode.classList.remove('chipos-diff-summary-hidden');
	}

	hide(): void {
		this._domNode.classList.add('chipos-diff-summary-hidden');
	}
}
