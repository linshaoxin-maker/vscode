/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaParallelProgress } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import '../media/edaParts.css';

const $ = dom.$;

/**
 * Renders parallel progress tracks in Cursor-native style:
 * each track is a progress-container row with spinner/check icon + text.
 */
export class ChatEdaParallelProgressContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaParallelProgress,
	) {
		super();

		const wrapper = $('div.eda-parallel-wrapper');

		// Phase header (small, muted)
		const phaseLabel = $('div.eda-parallel-phase');
		phaseLabel.textContent = content.phase ?? 'checking';
		wrapper.appendChild(phaseLabel);

		for (const track of content.tracks ?? []) {
			const row = $('div.progress-container');

			// Icon: spinner for running, check for done, error for failed
			let iconClass: string;
			if (track.status === 'done') {
				iconClass = 'codicon codicon-check';
				row.classList.add('show-checkmarks');
			} else if (track.status === 'failed') {
				iconClass = 'codicon codicon-error';
			} else if (track.status === 'running') {
				iconClass = 'codicon codicon-loading codicon-modifier-spin';
			} else {
				iconClass = 'codicon codicon-circle-outline';
			}
			const icon = $(`div.${iconClass.split(' ').join('.')}`);
			row.appendChild(icon);

			// Text
			const textEl = $('div.rendered-markdown.progress-step');
			const p = $('p');
			p.textContent = track.name + (track.file ? ` — ${track.file}` : '');
			textEl.appendChild(p);
			row.appendChild(textEl);

			wrapper.appendChild(row);
		}

		// Conflicts (if any)
		if (content.conflicts && content.conflicts.length > 0) {
			const conflictsRow = $('div.eda-parallel-conflicts');
			const icon = $('div.codicon.codicon-warning');
			conflictsRow.appendChild(icon);
			const text = $('span');
			text.textContent = `${content.conflicts.length} conflict(s) detected`;
			conflictsRow.appendChild(text);
			wrapper.appendChild(conflictsRow);
		}

		this.domNode = wrapper;
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaParallelProgress') {
			return false;
		}
		const o = other as IChatEdaParallelProgress;
		return o.phase === this.content.phase && o.tracks?.length === this.content.tracks?.length;
	}
}
