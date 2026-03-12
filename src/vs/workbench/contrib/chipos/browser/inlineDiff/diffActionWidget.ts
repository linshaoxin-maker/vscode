/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import type { IDiffHunk } from 'vs/workbench/contrib/chipos/browser/inlineDiff/diffComputer';

const $ = dom.$;

/**
 * Per-hunk inline widget that shows Accept (✓) and Reject (✗) buttons
 * next to the first line of a diff hunk.
 */
export class DiffActionWidget {

	private readonly _domNode: HTMLElement;

	private readonly _onDidAccept = new Emitter<void>();
	readonly onDidAccept: Event<void> = this._onDidAccept.event;

	private readonly _onDidReject = new Emitter<void>();
	readonly onDidReject: Event<void> = this._onDidReject.event;

	readonly hunk: IDiffHunk;

	constructor(hunk: IDiffHunk) {
		this.hunk = hunk;

		this._domNode = $('div.chipos-diff-actions');

		const acceptBtn = $('button.chipos-diff-accept');
		acceptBtn.textContent = '✓';
		acceptBtn.title = 'Accept change';
		dom.addDisposableListener(acceptBtn, 'click', (e) => {
			dom.EventHelper.stop(e, true);
			this._onDidAccept.fire();
		});
		this._domNode.appendChild(acceptBtn);

		const rejectBtn = $('button.chipos-diff-reject');
		rejectBtn.textContent = '✗';
		rejectBtn.title = 'Reject change';
		dom.addDisposableListener(rejectBtn, 'click', (e) => {
			dom.EventHelper.stop(e, true);
			this._onDidReject.fire();
		});
		this._domNode.appendChild(rejectBtn);
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	dispose(): void {
		this._onDidAccept.dispose();
		this._onDidReject.dispose();
		this._domNode.remove();
	}
}
