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

		// Error card container
		this.domNode.style.padding = '12px';
		this.domNode.style.borderRadius = '6px';
		this.domNode.style.border = '1px solid var(--vscode-inputValidation-errorBorder, #be1100)';
		this.domNode.style.background = 'var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.1))';
		this.domNode.style.marginBottom = '8px';

		// Error icon + code
		const header = dom.append(this.domNode, dom.$('.chat-agent-error-header'));
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '6px';
		header.style.marginBottom = '6px';

		const icon = dom.append(header, dom.$('.codicon.codicon-error'));
		icon.style.color = 'var(--vscode-testing-iconFailed)';

		const codeEl = dom.append(header, dom.$('span'));
		codeEl.textContent = error_code;
		codeEl.style.fontWeight = '600';
		codeEl.style.fontSize = '13px';
		codeEl.style.color = 'var(--vscode-foreground)';

		// Message
		const msgEl = dom.append(this.domNode, dom.$('.chat-agent-error-message'));
		msgEl.textContent = message;
		msgEl.style.fontSize = '12px';
		msgEl.style.color = 'var(--vscode-foreground)';
		msgEl.style.lineHeight = '1.4';

		// Suggestion
		if (suggestion) {
			const sugEl = dom.append(this.domNode, dom.$('.chat-agent-error-suggestion'));
			sugEl.textContent = suggestion;
			sugEl.style.fontSize = '12px';
			sugEl.style.color = 'var(--vscode-descriptionForeground)';
			sugEl.style.marginTop = '6px';
			sugEl.style.fontStyle = 'italic';
		}

		// Retry button
		if (retryable) {
			const btnContainer = dom.append(this.domNode, dom.$('.chat-agent-error-actions'));
			btnContainer.style.marginTop = '8px';

			const retryBtn = dom.append(btnContainer, dom.$('button.chipos-verify-button'));
			retryBtn.textContent = localize('chipos.error.retry', 'Retry');
			retryBtn.style.padding = '4px 12px';
			retryBtn.style.fontSize = '12px';
			retryBtn.style.cursor = 'pointer';
			retryBtn.style.border = '1px solid var(--vscode-button-border, transparent)';
			retryBtn.style.background = 'var(--vscode-button-background)';
			retryBtn.style.color = 'var(--vscode-button-foreground)';
			retryBtn.style.borderRadius = '4px';

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
