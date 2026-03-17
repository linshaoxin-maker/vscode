/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaSpecReview } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaSpecReviewContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaSpecReview,
	) {
		super();

		const summaryEl = $('div.eda-spec-summary');
		summaryEl.textContent = content.summary;

		const children: HTMLElement[] = [summaryEl];

		if (content.files && content.files.length > 0) {
			const filesEl = $('div.eda-spec-files');
			const filesTitle = $('strong');
			filesTitle.textContent = 'Files: ';
			filesEl.appendChild(filesTitle);
			for (const f of content.files) {
				const fileTag = $('code.eda-spec-file');
				fileTag.textContent = f;
				filesEl.appendChild(fileTag);
			}
			children.push(filesEl);
		}

		const pathEl = $('div.eda-spec-path');
		pathEl.textContent = `Spec: ${content.spec_path}`;

		children.push(pathEl);

		this.domNode = edaSection(`Spec Review: ${content.spec_name}`, ...children);
		this.domNode.classList.add('eda-spec-review');
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaSpecReview') {
			return false;
		}
		const o = other as IChatEdaSpecReview;
		return o.spec_path === this.content.spec_path;
	}
}
