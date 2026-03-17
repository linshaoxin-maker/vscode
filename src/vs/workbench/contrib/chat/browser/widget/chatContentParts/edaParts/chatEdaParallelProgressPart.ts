/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaParallelProgress } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection, edaBadge, edaProgressBar } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaParallelProgressContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaParallelProgress,
	) {
		super();

		const tracksContainer = $('div.eda-parallel-tracks');

		for (const track of content.tracks ?? []) {
			const trackEl = $('div.eda-parallel-track');

			const header = $('div.eda-track-header');
			header.appendChild(edaBadge(track.status, track.status === 'done' ? 'done' : track.status === 'running' ? 'running' : track.status === 'failed' ? 'fail' : 'pending'));
			const name = $('span.eda-track-name');
			name.textContent = track.name;
			header.appendChild(name);
			if (track.file) {
				const file = $('span.eda-track-file');
				file.textContent = track.file;
				header.appendChild(file);
			}
			trackEl.appendChild(header);

			if (track.progress !== undefined) {
				trackEl.appendChild(edaProgressBar(track.progress));
			}

			tracksContainer.appendChild(trackEl);
		}

		const children: HTMLElement[] = [tracksContainer];

		if (content.conflicts && content.conflicts.length > 0) {
			const conflictsEl = $('div.eda-conflicts');
			const conflictsTitle = $('span.eda-conflicts-title');
			conflictsTitle.textContent = 'Conflicts:';
			conflictsEl.appendChild(conflictsTitle);
			for (const conflict of content.conflicts) {
				const item = $('span.eda-conflict-item');
				item.textContent = conflict;
				conflictsEl.appendChild(item);
			}
			children.push(conflictsEl);
		}

		this.domNode = edaSection(`Parallel: ${content.phase}`, ...children);
		this.domNode.classList.add('eda-parallel-progress');
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaParallelProgress') {
			return false;
		}
		const o = other as IChatEdaParallelProgress;
		return o.phase === this.content.phase && o.tracks?.length === this.content.tracks?.length;
	}
}
