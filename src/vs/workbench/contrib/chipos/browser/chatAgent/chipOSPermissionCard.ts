/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase B — PERMISSION-APPROVAL-UX-V2
 *
 * ChipOSPermissionCardContentPart replaces the stock BaseChatConfirmationWidget
 * for worker permission ASK cards. Renders as custom DOM: color bar by tool
 * type, inline metadata visible by default, scrollable code preview, four
 * horizontal action buttons.
 *
 * Button routing: each button fires chatService.sendRequest with
 *   { acceptedConfirmationData: [data], confirmation: label }
 * chipOSChatAgent's acceptedConfirmationData handler resolves action_id via
 * _mapWorkerActionToDecision — no change to that path.
 */

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ChatSendResult, IChatConfirmation, IChatSendRequestOptions, IChatService } from '../../../../contrib/chat/common/chatService/chatService.js';
import { IChatContentPart, IChatContentPartRenderContext } from '../../../../contrib/chat/browser/widget/chatContentParts/chatContentParts.js';
import { IChatRendererContent, IChatResponseViewModel, isResponseVM } from '../../../../contrib/chat/common/model/chatViewModel.js';
import { ChatTreeItem, IChatWidget, IChatWidgetService } from '../../../../contrib/chat/browser/chat.js';
import './chipOSPermissionCard.css';

// ── Data shape stored in confirmation.data ────────────────────────────────────

export interface IChipOSPermissionCardData {
	readonly __chiposWorkerAskId: string;
	readonly requestId: string;
	readonly sessionId: string;
	readonly tool: string;
	readonly specifier: string;
	readonly targetExists?: boolean;
	readonly targetSizeBytes?: number;
	readonly matchedRule?: string;
	readonly matchedLayer?: string;
	readonly contentPreview?: string;
	readonly options: ReadonlyArray<{ readonly label: string; readonly action_id: string }>;
}

export function isChipOSPermissionCardData(data: unknown): data is IChipOSPermissionCardData {
	return (
		!!data &&
		typeof data === 'object' &&
		typeof (data as IChipOSPermissionCardData).__chiposWorkerAskId === 'string'
	);
}

// ── Content part ──────────────────────────────────────────────────────────────

export class ChipOSPermissionCardContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly confirmation: IChatConfirmation,
		context: IChatContentPartRenderContext,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
	) {
		super();

		const data = confirmation.data as IChipOSPermissionCardData;
		const element = context.element;
		const responseVM: IChatResponseViewModel | undefined = isResponseVM(element) ? element : undefined;
		const widget: IChatWidget | undefined = responseVM
			? chatWidgetService.getWidgetBySessionResource(responseVM.sessionResource)
			: undefined;

		// ── Root card ─────────────────────────────────────────────────────────
		const card = dom.$('.chipos-permission-card');
		card.classList.add(`tool-${data.tool.toLowerCase()}`);

		// ── Header: [icon] [Tool] [path] [badge] ──────────────────────────────
		const header = dom.$('.chipos-permission-header');
		card.appendChild(header);

		const iconSpan = dom.$('span');
		iconSpan.className = `chipos-tool-icon codicon ${this._toolCodicon(data.tool)}`;
		header.appendChild(iconSpan);

		const toolLabel = dom.$('span.chipos-tool-label');
		toolLabel.textContent = data.tool;
		header.appendChild(toolLabel);

		const pathCode = dom.$('code.chipos-path');
		pathCode.textContent = data.specifier;
		header.appendChild(pathCode);

		const badge = this._makeBadge(data);
		if (badge) {
			header.appendChild(badge);
		}

		// ── Metadata row ──────────────────────────────────────────────────────
		const meta = dom.$('.chipos-permission-meta');
		card.appendChild(meta);

		const metaParts: string[] = [];
		if (data.matchedRule) {
			metaParts.push(
				localize('chipos.card.rule', 'Rule: {0} ({1})', data.matchedRule, data.matchedLayer || 'default'),
			);
		}
		const sessionTail = this._truncateSession(data.sessionId);
		if (sessionTail) {
			metaParts.push(localize('chipos.card.session', 'Session: {0}', sessionTail));
		}
		if (metaParts.length > 0) {
			meta.textContent = metaParts.join(' · ');
		} else {
			meta.style.display = 'none';
		}

		// ── Code preview ──────────────────────────────────────────────────────
		if (data.contentPreview) {
			const previewWrap = dom.$('.chipos-permission-preview');
			card.appendChild(previewWrap);
			const pre = dom.$('pre.chipos-code-preview');
			pre.textContent = data.contentPreview;
			previewWrap.appendChild(pre);
		}

		// ── Buttons ───────────────────────────────────────────────────────────
		const items = widget?.viewModel?.getItems();
		const elementIdx = items ? items.findIndex(item => item === element) : -1;
		const hasFollowUpRequest = elementIdx >= 0 && items!.slice(elementIdx + 1).some(item => !isResponseVM(item));
		const isPending = !!responseVM && !!responseVM.model?.isPendingConfirmation?.get();

		const buttonsRow = dom.$('.chipos-permission-buttons');
		card.appendChild(buttonsRow);

		if (!confirmation.isUsed && isPending && !hasFollowUpRequest && responseVM) {
			this._buildButtons(buttonsRow, data, responseVM, widget);
		} else {
			const usedPill = dom.$('span.chipos-used-pill');
			usedPill.textContent = localize('chipos.card.used', 'Responded');
			buttonsRow.appendChild(usedPill);
		}

		this.domNode = card;
	}

	// ── Button builder ────────────────────────────────────────────────────────

	private _buildButtons(
		buttonsRow: HTMLElement,
		data: IChipOSPermissionCardData,
		element: IChatResponseViewModel,
		widget: IChatWidget | undefined,
	): void {
		const buttons: HTMLButtonElement[] = [];
		let inFlight = false;

		const setDisabled = (disabled: boolean) => {
			for (const btn of buttons) {
				btn.disabled = disabled;
				btn.classList.toggle('chipos-btn-used', disabled);
			}
		};

		// Replace the action-button row with a "Responded" pill once the user
		// has resolved the card. This is the visual confirmation that the
		// click landed; without it the card keeps rendering active buttons
		// indefinitely (confirmation.isUsed is set on the model object but
		// the existing DOM has no reactive binding to it, so it never knows
		// to re-render).
		const swapToRespondedPill = () => {
			while (buttonsRow.firstChild) {
				buttonsRow.removeChild(buttonsRow.firstChild);
			}
			const pill = dom.$('span.chipos-used-pill');
			pill.textContent = localize('chipos.card.used', 'Responded');
			buttonsRow.appendChild(pill);
		};

		const sendAction = async (opt: { label: string; action_id: string }) => {
			// Double-click / re-entry protection — confirmation.isUsed is the
			// authoritative "already responded" flag (set after a successful
			// sendRequest), but the request is async, so guard with a local
			// in-flight flag too.
			if (inFlight || this.confirmation.isUsed) {
				return;
			}
			inFlight = true;
			setDisabled(true);
			const prompt = `${opt.label}: "${this.confirmation.title}"`;
			const opts: IChatSendRequestOptions = {
				acceptedConfirmationData: [this.confirmation.data],
				agentId: element.agent?.id,
				slashCommand: element.slashCommand?.name,
				confirmation: opt.label,
				userSelectedModelId: widget?.input.currentLanguageModel,
				modeInfo: widget?.input.currentModeInfo,
				location: widget?.location,
				...(widget?.getModeRequestOptions?.() ?? {}),
			};
			try {
				let result = await this.chatService.sendRequest(element.sessionResource, prompt, opts);
				// ChatSendResult has three kinds: 'sent' | 'rejected' | 'queued'.
				// A queued result means chat is busy and the request will be
				// processed shortly — we await its `deferred` to find out
				// whether it eventually resolves to sent or rejected. Without
				// this, the user's click looks like a no-op and the buttons
				// re-enable, prompting a second click that hits the worker
				// twice.
				if (ChatSendResult.isQueued(result)) {
					result = await result.deferred;
				}
				if (ChatSendResult.isSent(result)) {
					this.confirmation.isUsed = true;
					swapToRespondedPill();
					return;
				}
			} catch {
				// fall through to re-enable so the user can retry
			}
			inFlight = false;
			setDisabled(false);
		};

		for (const opt of data.options) {
			const btn = document.createElement('button');
			btn.className = `chipos-action-btn chipos-btn-${opt.action_id.replace(/_/g, '-')}`;
			btn.textContent = opt.label;
			btn.setAttribute('aria-label', this._ariaLabel(opt.action_id, data.specifier));
			btn.setAttribute('type', 'button');
			this._register(dom.addDisposableListener(btn, 'click', () => { void sendAction(opt); }));
			buttonsRow.appendChild(btn);
			buttons.push(btn);
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private _makeBadge(data: IChipOSPermissionCardData): HTMLElement | undefined {
		let text: string | undefined;
		if (data.targetExists === false) {
			text = localize('chipos.card.newFile', 'new file');
		} else if (data.targetExists === true && typeof data.targetSizeBytes === 'number') {
			text = this._formatBytes(data.targetSizeBytes);
		} else if (data.targetExists === true) {
			text = localize('chipos.card.existingFile', 'existing');
		}
		if (!text) {
			return undefined;
		}
		const badge = dom.$('span.chipos-size-badge');
		badge.textContent = text;
		return badge;
	}

	private _toolCodicon(tool: string): string {
		switch (tool) {
			case 'Write': return 'codicon-file-add';
			case 'Edit': return 'codicon-edit';
			case 'Read': return 'codicon-file';
			case 'Bash':
			case 'BashCommandLine': return 'codicon-terminal';
			default: return 'codicon-shield';
		}
	}

	private _formatBytes(n: number): string {
		if (n < 1024) {
			return `~${n} bytes`;
		}
		if (n < 1024 * 1024) {
			return `~${(n / 1024).toFixed(1)} KB`;
		}
		return `~${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	private _truncateSession(sessionId: string): string {
		if (!sessionId) {
			return '';
		}
		return sessionId.length <= 8 ? sessionId : `…${sessionId.slice(-8)}`;
	}

	private _ariaLabel(actionId: string, specifier: string): string {
		switch (actionId) {
			case 'allow_once': return localize('chipos.card.aria.allowOnce', 'Allow this tool call once for {0}', specifier);
			case 'allow_workspace': return localize('chipos.card.aria.allowWorkspace', 'Always allow in this workspace for {0}', specifier);
			case 'allow_always': return localize('chipos.card.aria.allowAlways', 'Always allow globally for {0}', specifier);
			case 'deny': return localize('chipos.card.aria.deny', 'Deny this tool call for {0}', specifier);
			default: return actionId;
		}
	}

	// ── IChatContentPart ──────────────────────────────────────────────────────

	hasSameContent(other: IChatRendererContent, _following: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'confirmation') {
			return false;
		}
		return isChipOSPermissionCardData((other as IChatConfirmation).data);
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}
