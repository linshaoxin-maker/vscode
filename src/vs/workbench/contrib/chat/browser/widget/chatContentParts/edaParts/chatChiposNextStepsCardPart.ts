/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IChatChiposNextStepsCard } from '../../../../common/chatEdaTypes.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import '../media/edaParts.css';

const $ = dom.$;

/**
 * [ChipOS] Renders the inline next-step suggestions card (design variant A): a
 * borderless list of rows, each a clickable short title + a one-line description
 * with a trailing chevron and a hover highlight. Clicking (or Enter/Space on) a
 * row sends its `action` as the next turn via the chipos.chat.sendFollowup
 * command — which works both live and from restored history, since the
 * sessionResource is carried in-band on the card data.
 */
export class ChatChiposNextStepsCardContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly _data: IChatChiposNextStepsCard,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this.domNode = $('.chipos-next-steps-card');
		this._render();
	}

	private _render(): void {
		dom.clearNode(this.domNode);

		const header = dom.append(this.domNode, $('.chipos-next-steps-header'));
		dom.append(header, $('.codicon.codicon-lightbulb'));
		const headerTitle = dom.append(header, $('.chipos-next-steps-header-title'));
		headerTitle.textContent = localize('chipos.nextSteps.title', "下一步");

		for (const item of this._data.items) {
			if (!item.title) {
				continue;
			}
			const row = dom.append(this.domNode, $('.chipos-next-steps-row'));
			row.setAttribute('role', 'button');
			row.tabIndex = 0;
			row.title = item.action;

			const main = dom.append(row, $('.chipos-next-steps-row-main'));
			const title = dom.append(main, $('.chipos-next-steps-row-title'));
			title.textContent = item.title;
			if (item.description) {
				const desc = dom.append(main, $('.chipos-next-steps-row-desc'));
				desc.textContent = item.description;
			}

			dom.append(row, $('.chipos-next-steps-row-chevron.codicon.codicon-chevron-right'));

			const fire = () => this._send(item.action);
			this._register(dom.addDisposableListener(row, 'click', fire));
			this._register(dom.addDisposableListener(row, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					fire();
				}
			}));
		}
	}

	private _send(action: string): void {
		const text = action?.trim();
		if (!text) {
			return;
		}
		void this._commandService.executeCommand('chipos.chat.sendFollowup', this._data.sessionResource, text);
	}

	hasSameContent(other: IChatRendererContent): boolean {
		const o = other as unknown as IChatChiposNextStepsCard;
		if (o.kind !== 'chiposNextSteps' || o.items.length !== this._data.items.length) {
			return false;
		}
		return this._data.items.every((it, i) =>
			it.title === o.items[i].title
			&& it.description === o.items[i].description
			&& it.action === o.items[i].action);
	}
}
