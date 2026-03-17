/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaNegotiationView } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { edaSection } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

export class ChatEdaNegotiationViewContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaNegotiationView,
	) {
		super();

		const perspectivesContainer = $('div.eda-perspectives');

		for (const p of content.perspectives ?? []) {
			const card = $('div.eda-perspective-card');

			const agentName = $('div.eda-perspective-agent');
			agentName.textContent = p.agent;
			card.appendChild(agentName);

			const position = $('div.eda-perspective-position');
			position.textContent = p.position;
			card.appendChild(position);

			const reasoning = $('blockquote.eda-perspective-reasoning');
			reasoning.textContent = p.reasoning;
			card.appendChild(reasoning);

			perspectivesContainer.appendChild(card);
		}

		const recommendation = $('div.eda-recommendation');
		const recLabel = $('strong');
		recLabel.textContent = 'Recommendation: ';
		recommendation.appendChild(recLabel);
		const recText = $('span');
		recText.textContent = content.recommendation;
		recommendation.appendChild(recText);

		this.domNode = edaSection(`Negotiation: ${content.issue}`, perspectivesContainer, recommendation);
		this.domNode.classList.add('eda-negotiation-view');
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaNegotiationView') {
			return false;
		}
		const o = other as IChatEdaNegotiationView;
		return o.issue === this.content.issue;
	}
}
