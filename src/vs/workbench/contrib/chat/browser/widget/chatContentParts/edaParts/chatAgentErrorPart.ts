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
		// UX-AUTH-1: AUTH_FAILED is a distinct case — Retry won't help (token
		// is missing/expired), the right action is to re-authenticate. Render
		// a "Log in" button instead of Retry, and replace the misleading
		// "check your API token" suggestion with sign-in guidance.
		const isAuthFailure = error_code === 'AUTH_FAILED' || error_code === 'AUTH_TOKEN_EXPIRED' || error_code === 'AUTH_TOKEN_INVALID';

		const header = dom.append(this.domNode, dom.$('.chat-agent-error-header'));
		dom.append(header, dom.$('.codicon.codicon-error'));
		const codeEl = dom.append(header, dom.$('.chat-agent-error-code'));
		codeEl.textContent = error_code;

		const msgEl = dom.append(this.domNode, dom.$('.chat-agent-error-message'));
		msgEl.textContent = isAuthFailure
			? localize('chipos.error.auth.message', "Not signed in or your session has expired. Please log in to continue.")
			: message;

		if (suggestion && !isAuthFailure) {
			// Skip suggestion text in auth case — the Log in button below IS
			// the suggestion. Avoid the legacy "check your API token" string
			// which doesn't apply to OAuth-based auth.
			const sugEl = dom.append(this.domNode, dom.$('.chat-agent-error-suggestion'));
			sugEl.textContent = suggestion;
		}

		if (isAuthFailure) {
			const btnContainer = dom.append(this.domNode, dom.$('.chat-agent-error-actions'));
			const loginBtn = dom.append(btnContainer, dom.$<HTMLButtonElement>('button.chat-agent-error-retry'));
			loginBtn.type = 'button';
			loginBtn.textContent = localize('chipos.error.login', "Log In");

			this._register(dom.addDisposableListener(loginBtn, 'click', () => {
				if (loginBtn.disabled) {
					return;
				}
				loginBtn.disabled = true;
				loginBtn.setAttribute('aria-busy', 'true');
				this._commandService.executeCommand('chipos.auth.login');
			}));
		} else if (retryable) {
			const btnContainer = dom.append(this.domNode, dom.$('.chat-agent-error-actions'));
			const retryBtn = dom.append(btnContainer, dom.$<HTMLButtonElement>('button.chat-agent-error-retry'));
			retryBtn.type = 'button';
			retryBtn.textContent = localize('chipos.error.retry', 'Retry');

			let resetTimer: ReturnType<typeof setTimeout> | undefined;
			this._register({
				dispose: () => {
					if (resetTimer !== undefined) {
						clearTimeout(resetTimer);
					}
				},
			});

			this._register(dom.addDisposableListener(retryBtn, 'click', () => {
				if (retryBtn.disabled) {
					return;
				}
				retryBtn.disabled = true;
				retryBtn.setAttribute('aria-busy', 'true');
				this._commandService.executeCommand('workbench.action.chat.resend');
				// Re-enable after a short cool-down so users can retry if the resend silently failed.
				resetTimer = setTimeout(() => {
					retryBtn.disabled = false;
					retryBtn.removeAttribute('aria-busy');
					resetTimer = undefined;
				}, 2000);
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
