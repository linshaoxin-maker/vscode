/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatContentPart } from '../chatContentParts.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import * as dom from '../../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../../nls.js';
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
		const safeRound = Number.isFinite(current_round) ? Math.max(0, current_round) : 0;
		const safeMax = Number.isFinite(max_rounds) && max_rounds > 0 ? max_rounds : 0;
		const pct = safeMax > 0 ? Math.max(0, Math.min(100, Math.round((safeRound / safeMax) * 100))) : 0;

		const header = dom.append(this.domNode, dom.$('.chat-round-progress-header'));
		header.textContent = phase
			? localize('chipos.progress.roundWithPhase', 'Round {0}/{1} — {2}', safeRound, safeMax, phase)
			: localize('chipos.progress.round', 'Round {0}/{1}', safeRound, safeMax);

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
