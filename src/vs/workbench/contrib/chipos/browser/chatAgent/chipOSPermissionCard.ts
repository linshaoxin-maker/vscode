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
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
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
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
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

		// #3 — Path becomes clickable. For paths inside the workspace, open as
		// editor; for everything else, reveal in OS Finder so the user can
		// inspect what the AI is about to touch without losing the card.
		// Hover gives a faint underline; the codicon hints "this is an action."
		const pathCode = dom.$('code.chipos-path.chipos-path-link');
		pathCode.textContent = data.specifier;
		pathCode.setAttribute('role', 'link');
		pathCode.setAttribute('tabindex', '0');
		pathCode.setAttribute('title', localize('chipos.card.pathTooltip', 'Click to open / reveal {0}', data.specifier));
		const openPath = () => {
			void this._openSpecifier(data.specifier);
		};
		this._register(dom.addDisposableListener(pathCode, 'click', openPath));
		this._register(dom.addDisposableListener(pathCode, 'keydown', (e: KeyboardEvent) => {
			const ev = new StandardKeyboardEvent(e);
			if (ev.keyCode === KeyCode.Enter || ev.keyCode === KeyCode.Space) {
				ev.preventDefault();
				ev.stopPropagation();
				openPath();
			}
		}));
		header.appendChild(pathCode);

		const badge = this._makeBadge(data);
		if (badge) {
			header.appendChild(badge);
		}

		// ── Metadata row ──────────────────────────────────────────────────────
		// #5 — Rule key gets a click-to-copy button so users can paste it
		// straight into `~/.chipos/permissions.json` without selecting the
		// text manually. Built as DOM nodes (not a single textContent string)
		// so we can attach interactive bits selectively.
		const meta = dom.$('.chipos-permission-meta');
		card.appendChild(meta);
		let hasMeta = false;

		if (data.matchedRule) {
			hasMeta = true;
			const ruleSpan = dom.$('span.chipos-meta-rule');
			ruleSpan.appendChild(document.createTextNode(localize('chipos.card.ruleLabel', 'Rule: ')));
			const ruleCode = dom.$('code.chipos-meta-rule-code');
			ruleCode.textContent = data.matchedRule;
			ruleSpan.appendChild(ruleCode);
			ruleSpan.appendChild(document.createTextNode(` (${data.matchedLayer || 'default'})`));

			const copyBtn = dom.$('button.chipos-copy-btn');
			copyBtn.setAttribute('type', 'button');
			copyBtn.setAttribute('aria-label', localize('chipos.card.copyRuleAria', 'Copy rule key {0} to clipboard', data.matchedRule));
			copyBtn.setAttribute('title', localize('chipos.card.copyRuleTooltip', 'Copy rule key'));
			const copyIcon = dom.$('span.codicon.codicon-copy');
			copyBtn.appendChild(copyIcon);
			const matchedRule = data.matchedRule;
			this._register(dom.addDisposableListener(copyBtn, 'click', async (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				await this.clipboardService.writeText(matchedRule);
				// Briefly swap the icon to a check to confirm the copy landed.
				copyIcon.classList.remove('codicon-copy');
				copyIcon.classList.add('codicon-check');
				setTimeout(() => {
					copyIcon.classList.remove('codicon-check');
					copyIcon.classList.add('codicon-copy');
				}, 1200);
			}));
			ruleSpan.appendChild(copyBtn);
			meta.appendChild(ruleSpan);
		}

		const sessionTail = this._truncateSession(data.sessionId);
		if (sessionTail) {
			if (hasMeta) {
				meta.appendChild(document.createTextNode(' · '));
			}
			hasMeta = true;
			const sessionSpan = dom.$('span.chipos-meta-session');
			sessionSpan.textContent = localize('chipos.card.session', 'Session: {0}', sessionTail);
			meta.appendChild(sessionSpan);
		}

		if (!hasMeta) {
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
			// 2026-05-20 dogfood (Bug #12): chatWidget.ts:2571's
			// `containsChipOSCard` branch deliberately disables auto-scroll on
			// every layout pass once a worker-permission card lands in chat —
			// to stop the scroll-snap that yanked the user back to bottom
			// during streaming. Side effect: when a NEW pending card is
			// appended at the end of chat content, the button row sits BELOW
			// the chat-list viewport edge, visually covered by the chat-
			// input-part (working set / mention / input box stack), with no
			// indication to the user that scrolling will reveal them.
			//
			// Fix: when the card first attaches AND its buttons are still
			// active, use the IChatWidget.revealElement API (which knows
			// about the virtualized list internals — naive
			// element.scrollIntoView gets undone by the next listWidget
			// layout pass since the list mounts rows lazily). revealElement
			// is exactly meant for "scroll chat list so given DOM element is
			// visible at the bottom of the viewport". Fire once per mount;
			// subsequent user scrolling is not fought.
			const revealButtonsRow = () => {
				if (!card.isConnected) {
					const rafId = requestAnimationFrame(revealButtonsRow);
					this._register({ dispose: () => cancelAnimationFrame(rafId) });
					return;
				}
				try {
					widget?.revealElement(card);
				} catch {
					// revealElement is best-effort; if the row's not mounted
					// yet or widget became disposed, ignore.
				}
			};
			requestAnimationFrame(revealButtonsRow);
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

		for (let i = 0; i < data.options.length; i++) {
			const opt = data.options[i];
			const btn = document.createElement('button');
			btn.className = `chipos-action-btn chipos-btn-${opt.action_id.replace(/_/g, '-')}`;
			// #1 — Show 1-4 number hint inside the button so users learn the
			// keyboard shortcuts inline (Cursor / Claude Code pattern).
			const numHint = dom.$('span.chipos-btn-num');
			numHint.textContent = String(i + 1);
			btn.appendChild(numHint);
			const labelSpan = dom.$('span.chipos-btn-label');
			labelSpan.textContent = opt.label;
			btn.appendChild(labelSpan);
			btn.setAttribute('aria-label', this._ariaLabel(opt.action_id, data.specifier));
			btn.setAttribute('aria-keyshortcuts', String(i + 1));
			btn.setAttribute('type', 'button');
			this._register(dom.addDisposableListener(btn, 'click', () => { void sendAction(opt); }));
			buttonsRow.appendChild(btn);
			buttons.push(btn);
		}

		// #1 — Keyboard shortcuts on the card itself: 1/2/3/4 → action_ids in
		// declaration order; Escape → deny. Listener lives on buttonsRow with
		// tabindex so users can Tab into it from the chat input. The handler
		// only fires when no input/textarea has focus (so typing 1 in chat
		// input doesn't accidentally Allow).
		buttonsRow.setAttribute('tabindex', '0');
		buttonsRow.setAttribute('aria-label', localize('chipos.card.buttonsAria', 'Permission decision buttons. Press 1 to 4 to choose, Escape to deny.'));
		this._register(dom.addDisposableListener(buttonsRow, 'keydown', (e: KeyboardEvent) => {
			if (inFlight || this.confirmation.isUsed) {
				return;
			}
			const target = e.target as HTMLElement | null;
			// If focus is in an input/textarea/contenteditable, don't hijack.
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
				return;
			}
			const ev = new StandardKeyboardEvent(e);
			let actionIdx = -1;
			switch (ev.keyCode) {
				case KeyCode.Digit1: case KeyCode.Numpad1: actionIdx = 0; break;
				case KeyCode.Digit2: case KeyCode.Numpad2: actionIdx = 1; break;
				case KeyCode.Digit3: case KeyCode.Numpad3: actionIdx = 2; break;
				case KeyCode.Digit4: case KeyCode.Numpad4: actionIdx = 3; break;
				case KeyCode.Escape: {
					// Map Escape → "deny" by action_id, since not all cards
					// guarantee deny is the 4th option (older or customized
					// servers might reorder).
					actionIdx = data.options.findIndex(o => o.action_id === 'deny');
					break;
				}
			}
			if (actionIdx >= 0 && actionIdx < data.options.length) {
				ev.preventDefault();
				ev.stopPropagation();
				void sendAction(data.options[actionIdx]);
			}
		}));
	}

	/**
	 * #3 — Open or reveal the specifier path. For paths inside the workspace
	 * we prefer `vscode.open` (opens as an editor). For everything else, fall
	 * back to `revealFileInOS` (Finder / Explorer). Both work for new-or-
	 * existing files; if the path doesn't exist (Write to a new file), the
	 * OS reveal shows the parent directory which is still useful.
	 */
	private async _openSpecifier(specifier: string): Promise<void> {
		try {
			const uri = URI.file(specifier);
			await this.commandService.executeCommand('vscode.open', uri);
		} catch {
			try {
				const uri = URI.file(specifier);
				await this.commandService.executeCommand('revealFileInOS', uri);
			} catch {
				// best-effort — don't break the card if neither command exists
			}
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
