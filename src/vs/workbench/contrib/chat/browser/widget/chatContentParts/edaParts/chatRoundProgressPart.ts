/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatContentPart } from '../chatContentParts.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import * as dom from '../../../../../../../base/browser/dom.js';
import { IChatRoundProgress } from '../../../../common/chatEdaTypes.js';

export class ChatRoundProgressContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private _data: IChatRoundProgress,
	) {
		super();
		this.domNode = dom.$('.chat-round-progress');
		this._render();
	}

	private _render(): void {
		dom.clearNode(this.domNode);

		const { current_round, max_rounds, phase } = this._data;
		const pct = max_rounds > 0 ? Math.min(100, Math.round((current_round / max_rounds) * 100)) : 0;

		const header = dom.append(this.domNode, dom.$('.chat-round-progress-header'));
		header.textContent = phase
			? `Round ${current_round}/${max_rounds} — ${phase}`
			: `Round ${current_round}/${max_rounds}`;

		const track = dom.append(this.domNode, dom.$('.chat-round-progress-track'));
		const fill = dom.append(track, dom.$('.chat-round-progress-fill'));
		fill.style.width = `${pct}%`;

		const pctLabel = dom.append(this.domNode, dom.$('.chat-round-progress-pct'));
		pctLabel.textContent = `${pct}%`;
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: unknown): boolean {
		const o = other as unknown as IChatRoundProgress;
		return o.kind === 'roundProgress'
			&& this._data.current_round === o.current_round
			&& this._data.max_rounds === o.max_rounds;
	}
}
