/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatContentPart } from '../chatContentParts.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import * as dom from '../../../../../../../base/browser/dom.js';
import { IChatAgentError } from '../../../../common/chatEdaTypes.js';
import { localize } from '../../../../../../../nls.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';

export class ChatAgentErrorContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private _data: IChatAgentError,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this.domNode = dom.$('.chat-agent-error');
		this._render();
	}

	private _render(): void {
		dom.clearNode(this.domNode);

		const { error_code, message, retryable, suggestion } = this._data;

		const header = dom.append(this.domNode, dom.$('.chat-agent-error-header'));
		dom.append(header, dom.$('.codicon.codicon-error'));
		const codeEl = dom.append(header, dom.$('.chat-agent-error-code'));
		codeEl.textContent = error_code;

		const msgEl = dom.append(this.domNode, dom.$('.chat-agent-error-message'));
		msgEl.textContent = message;

		if (suggestion) {
			const sugEl = dom.append(this.domNode, dom.$('.chat-agent-error-suggestion'));
			sugEl.textContent = suggestion;
		}

		if (retryable) {
			const btnContainer = dom.append(this.domNode, dom.$('.chat-agent-error-actions'));
			const retryBtn = dom.append(btnContainer, dom.$('button.chat-agent-error-retry'));
			retryBtn.textContent = localize('chipos.error.retry', 'Retry');

			this._register(dom.addDisposableListener(retryBtn, 'click', () => {
				this._commandService.executeCommand('workbench.action.chat.resend');
			}));
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: unknown): boolean {
		const o = other as unknown as IChatAgentError;
		return o.kind === 'agentError'
			&& this._data.error_code === o.error_code
			&& this._data.message === o.message;
	}
}
