/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { IChatEdaParallelProgress } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import '../media/edaParts.css';

const $ = dom.$;

/**
 * Renders parallel progress tracks using Cursor-native tool-progress style:
 * each track is a single row with a codicon (spinner/check/error) + label text.
 * No badges, no boxes — just clean inline rows like Cursor's tool invocations.
 */
export class ChatEdaParallelProgressContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaParallelProgress,
	) {
		super();

		const wrapper = $('div.eda-parallel-wrapper');

		for (const track of content.tracks ?? []) {
			const row = $('div.eda-parallel-row');

			// Codicon icon based on status
			const iconEl = $('span.eda-parallel-icon');
			if (track.status === 'done') {
				iconEl.classList.add(...ThemeIcon.asClassNameArray({ id: 'check' }));
				iconEl.classList.add('eda-icon-done');
			} else if (track.status === 'failed') {
				iconEl.classList.add(...ThemeIcon.asClassNameArray({ id: 'error' }));
				iconEl.classList.add('eda-icon-error');
			} else if (track.status === 'running') {
				iconEl.classList.add(...ThemeIcon.asClassNameArray({ id: 'loading~spin' }));
				iconEl.classList.add('eda-icon-running');
			} else {
				// pending / unknown
				iconEl.classList.add(...ThemeIcon.asClassNameArray({ id: 'circle-outline' }));
			}
			row.appendChild(iconEl);

			// Label text
			const label = $('span.eda-parallel-label');
			label.textContent = track.name + (track.file ? ` — ${track.file}` : '');
			row.appendChild(label);

			wrapper.appendChild(row);
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
