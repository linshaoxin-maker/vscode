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
			? localize('chipos.error.auth.message', "未登录或会话已过期,请登录后继续。")
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
			loginBtn.textContent = localize('chipos.error.login', "登录");

			this._register(dom.addDisposableListener(loginBtn, 'click', () => {
				if (loginBtn.disabled) {
					return;
				}
				loginBtn.disabled = true;
				loginBtn.setAttribute('aria-busy', 'true');
				this._commandService.executeCommand('chipos.auth.login');
			}));
		} else {
			const resumeContext = this._data.resumeContext;
			if (resumeContext || retryable) {
				const btnContainer = dom.append(this.domNode, dom.$('.chat-agent-error-actions'));

				// ADR-018 resume-from-break: when the failed turn can be continued,
				// the PRIMARY action resumes it from the last checkpoint (POST
				// /resume — preserving prior output) rather than re-running the
				// whole prompt. The Retry (resend) button below is the fallback.
				if (resumeContext) {
					const resumeBtn = dom.append(btnContainer, dom.$<HTMLButtonElement>('button.chat-agent-error-retry'));
					resumeBtn.type = 'button';
					resumeBtn.textContent = localize('chipos.error.resume', "继续 (从中断处)");

					let resumeResetTimer: ReturnType<typeof setTimeout> | undefined;
					this._register({
						dispose: () => {
							if (resumeResetTimer !== undefined) {
								clearTimeout(resumeResetTimer);
							}
						},
					});

					this._register(dom.addDisposableListener(resumeBtn, 'click', () => {
						if (resumeBtn.disabled) {
							return;
						}
						resumeBtn.disabled = true;
						resumeBtn.setAttribute('aria-busy', 'true');
						// The command continues the turn from its last checkpoint. If it
						// can't (session disposed / busy / history restored after a
						// restart) it resolves falsy → fall back to resend so the button
						// is never a dead end. Re-enable after a short cool-down either way.
						const csId = this._data.chatSessionId ?? resumeContext.chatSessionId;
						void Promise.resolve(this._commandService.executeCommand('_chipos.resumeStatelessTurn', resumeContext))
							.then(resumed => {
								if (!resumed) {
									this._commandService.executeCommand('_chipos.retryStatelessTurn', csId);
								}
							}, () => this._commandService.executeCommand('_chipos.retryStatelessTurn', csId))
							.finally(() => {
								resumeResetTimer = setTimeout(() => {
									resumeBtn.disabled = false;
									resumeBtn.removeAttribute('aria-busy');
									resumeResetTimer = undefined;
								}, 2000);
							});
					}));
				}

				if (retryable) {
					const retryBtn = dom.append(btnContainer, dom.$<HTMLButtonElement>('button.chat-agent-error-retry'));
					retryBtn.type = 'button';
					// Demote to secondary styling when a primary resume action precedes it.
					if (resumeContext) {
						retryBtn.classList.add('secondary');
					}
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
						// Resend the last user message. Routes through the ChipOS agent
						// command (NOT the framework `workbench.action.chat.resend`, which
						// is unregistered here → the click used to silently no-op).
						this._commandService.executeCommand('_chipos.retryStatelessTurn', this._data.chatSessionId);
						// Re-enable after a short cool-down so users can retry if the resend silently failed.
						resetTimer = setTimeout(() => {
							retryBtn.disabled = false;
							retryBtn.removeAttribute('aria-busy');
							resetTimer = undefined;
						}, 2000);
					}));
				}
			}
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: unknown): boolean {
		const o = other as unknown as IChatAgentError;
		return o.kind === 'agentError'
			&& this._data.error_code === o.error_code
			&& this._data.message === o.message;
	}
}
