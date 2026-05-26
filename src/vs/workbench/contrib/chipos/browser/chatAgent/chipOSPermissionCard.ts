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
import { MarkdownString, isMarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ChatSendResult, IChatConfirmation, IChatSendRequestOptions, IChatService } from '../../../../contrib/chat/common/chatService/chatService.js';
import { IChatContentPart, IChatContentPartRenderContext } from '../../../../contrib/chat/browser/widget/chatContentParts/chatContentParts.js';
import { IChatRendererContent, IChatResponseViewModel, isResponseVM } from '../../../../contrib/chat/common/model/chatViewModel.js';
import { ChatTreeItem, IChatWidget, IChatWidgetService } from '../../../../contrib/chat/browser/chat.js';
import './chipOSPermissionCard.css';

// ── Data shape stored in confirmation.data ────────────────────────────────────

/**
 * Worker permission ASK card data (the original v2 shape).
 *
 * Identified by `__chiposWorkerAskId`. Click handling in
 * `chipOSChatAgent`'s `acceptedConfirmationData` branch routes the user's
 * choice to `_workerPermissionService.decide()` against the worker's
 * local HTTP endpoint.
 */
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

/**
 * Terminal-command confirmation card data — the IDE-side run_in_terminal
 * approval flow piggybacking on the permission card's visual.
 *
 * Identified by `__chiposTerminalConfirmId` (the LLM tool_call.id).
 * Routes through the same `ChipOSPermissionCardContentPart` renderer so
 * the user sees one consistent UX across MCP permission asks and
 * terminal-command approvals — but click handling lands in
 * `chipOSChatAgent`'s terminal-Deferred branch (resolves
 * `_pendingTerminalApprovals` instead of calling the worker), see
 * `_awaitTerminalApproval`.
 *
 * Subset of permission-card fields used:
 *   - `tool: 'Bash'`   → renders the terminal codicon in the header.
 *   - `specifier: cmd` → the command string, displayed as the clickable
 *     "path" line (clicking does nothing useful for a command, that's
 *     ignored downstream).
 *   - `contentPreview?: cwd / explanation` → optional context block.
 *   - `options: [Run, Reject]` → two buttons with action_id `run` /
 *     `reject`. The invoke() handler reads action_id to decide whether
 *     to resolve the Deferred with true or false.
 *
 * Permission-card-only fields (`targetExists`, `targetSizeBytes`,
 * `matchedRule`, `matchedLayer`) are unset — the renderer already
 * checks them with `if (data.matchedRule)` etc., so it gracefully
 * skips those sections when missing.
 */
export interface IChipOSTerminalConfirmCardData {
	readonly __chiposTerminalConfirmId: string;
	readonly tool: 'Bash';
	readonly specifier: string;
	readonly contentPreview?: string;
	readonly options: ReadonlyArray<{ readonly label: string; readonly action_id: 'run' | 'reject' }>;
	// Permission-card schema parity (fields the renderer touches even if
	// terminal cards don't carry meaningful values for them):
	readonly sessionId?: string;
	readonly requestId?: string;
}

export function isChipOSTerminalConfirmCardData(data: unknown): data is IChipOSTerminalConfirmCardData {
	return (
		!!data &&
		typeof data === 'object' &&
		typeof (data as IChipOSTerminalConfirmCardData).__chiposTerminalConfirmId === 'string'
	);
}

/**
 * Hook confirmation card data — chipos backend `hook_confirm` cards
 * (verification pipeline H14/H15/H16/H17, etc.) routed through the
 * same custom card visual as MCP permission asks and terminal
 * confirms.
 *
 * Identified by `__chiposHookConfirmCard: true`. Click handling
 * flows through the standard FEAT-23 `acceptedConfirmationData`
 * branch in `chipOSChatAgent.invoke()` — it reads `options[]` to
 * map the clicked label → action_id and forwards via
 * `streamClient.sendConfirmResponse(requestId, action, ...)`. No
 * Deferred / IDE-side state machine (unlike terminal confirms): the
 * backend is the source of truth for hook approvals.
 *
 * Field mapping (set in `ConfirmRequest` event handler):
 *   - `tool: 'Bash'`        — picks the terminal codicon header.
 *   - `specifier`           — hook_name (or command, or title).
 *   - `contentPreview`      — flattened description / impact /
 *     command from card_data, plain-text (chipos card renders a
 *     `<pre>` block, no markdown — see `_buildHookContentPreview`).
 *   - `options`             — passed through from backend.
 */
export interface IChipOSHookConfirmCardData {
	readonly __chiposHookConfirmCard: true;
	readonly tool: 'Bash';
	readonly specifier: string;
	readonly contentPreview?: string;
	readonly options: ReadonlyArray<{ readonly label: string; readonly action_id?: string; readonly action?: string }>;
	readonly requestId: string;
	readonly sessionId?: string;
}

export function isChipOSHookConfirmCardData(data: unknown): data is IChipOSHookConfirmCardData {
	return (
		!!data &&
		typeof data === 'object' &&
		(data as IChipOSHookConfirmCardData).__chiposHookConfirmCard === true
	);
}

/**
 * Generic confirmation card data — chipos backend `ConfirmRequest`
 * events that carry rich markdown content (spec_confirm, arch_confirm,
 * code_confirm, design_confirm, agent_ask, file_edit, verification_*
 * pipeline cards). Renders through the same ChipOSPermissionCardContentPart
 * so all confirmation flows share one card vocabulary, with the rich
 * markdown content rendered into the preview slot (vs. plain-text for
 * terminal / hook variants).
 *
 * Routes click through the existing FEAT-23 `acceptedConfirmationData`
 * branch — same as hook confirms — which forwards to backend via
 * `streamClient.sendConfirmResponse`.
 *
 * Identified by `__chiposGenericConfirmCard: true`. The renderer checks
 * `renderMessageAsMarkdown: true` on the data to know it should render
 * `confirmation.message` (an IMarkdownString) into the preview slot via
 * IMarkdownRendererService instead of treating `contentPreview` as plain
 * text.
 */
export interface IChipOSGenericConfirmCardData {
	readonly __chiposGenericConfirmCard: true;
	readonly tool: string;
	readonly specifier: string;
	readonly renderMessageAsMarkdown: true;
	readonly options: ReadonlyArray<{ readonly label: string; readonly action_id?: string; readonly action?: string }>;
	readonly requestId: string;
	readonly sessionId?: string;
}

export function isChipOSGenericConfirmCardData(data: unknown): data is IChipOSGenericConfirmCardData {
	return (
		!!data &&
		typeof data === 'object' &&
		(data as IChipOSGenericConfirmCardData).__chiposGenericConfirmCard === true
	);
}

/**
 * 2026-05-26: multi-question `agent_ask` (Read card) with concrete options
 * per question. Renders as a radio-form inline in the chat flow: each
 * question becomes its own radio group; user picks one answer per
 * question, then clicks the single "提交" button at the bottom to send
 * all answers atomically.
 *
 * Wire protocol:
 *   - `questions[]` carries the reasoner-side question definitions
 *   - `selections` is a MUTABLE record the radio handlers write into;
 *     when "提交" is clicked, the chipOSChatAgent acceptedConfirmation
 *     handler reads this back, JSON-stringifies it as the `comment`
 *     field of sendConfirmResponse. Reasoner agent_core.py (commit
 *     96135978) already parses comment-as-JSON into augmented_prompt.
 *
 * The card stays IChatConfirmation (not IChatQuestionCarousel) so it
 * renders INLINE in the chat conversation flow via this content part,
 * matching the user's "之前卡片里面" requirement. IChatQuestionCarousel
 * hardcodes itself to the input-bar area (chatListRenderer.ts:2280),
 * which the user explicitly rejected.
 */
export interface IChipOSAgentAskCardData {
	readonly __chiposAgentAskCard: true;
	readonly tool: string;
	readonly specifier: string;
	readonly questions: ReadonlyArray<{
		readonly question_id: string;
		readonly prompt: string;
		readonly options: ReadonlyArray<{ readonly action_id: string; readonly label: string }>;
	}>;
	/** Mutable: radio change handlers write { question_id: chosen_action_id } here. */
	readonly selections: Record<string, string>;
	readonly options: ReadonlyArray<{ readonly label: string; readonly action_id?: string; readonly action?: string }>;
	readonly requestId: string;
	readonly sessionId?: string;
	readonly context?: string;
}

export function isChipOSAgentAskCardData(data: unknown): data is IChipOSAgentAskCardData {
	return (
		!!data &&
		typeof data === 'object' &&
		(data as IChipOSAgentAskCardData).__chiposAgentAskCard === true
	);
}

/**
 * Umbrella check: any chipos confirmation card data shape. Used by the
 * chatListRenderer / chatListWidget dispatch so worker permission asks,
 * terminal command approvals, hook confirms, AND generic ConfirmRequest
 * cards (spec/arch/code/agent/file_edit/verification) all route to
 * `ChipOSPermissionCardContentPart` for one unified visual.
 */
export function isChipOSCardData(data: unknown): data is IChipOSPermissionCardData | IChipOSTerminalConfirmCardData | IChipOSHookConfirmCardData | IChipOSGenericConfirmCardData | IChipOSAgentAskCardData {
	return isChipOSPermissionCardData(data) || isChipOSTerminalConfirmCardData(data) || isChipOSHookConfirmCardData(data) || isChipOSGenericConfirmCardData(data) || isChipOSAgentAskCardData(data);
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
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
	) {
		super();

		// Accept any chipos card data shape — worker permission ask /
		// terminal-command confirm / hook confirm / generic ConfirmRequest
		// (spec/arch/code/agent/file_edit/verification etc.). The renderer
		// treats permission-only fields (matchedRule, targetSizeBytes, …)
		// as optional with existing `if (data.foo)` checks; cards that
		// don't carry them just skip those sections. Generic cards opt
		// into markdown rendering of `confirmation.message` via the
		// `renderMessageAsMarkdown` flag below.
		const data = confirmation.data as IChipOSPermissionCardData | IChipOSTerminalConfirmCardData | IChipOSHookConfirmCardData | IChipOSGenericConfirmCardData | IChipOSGenericConfirmCardData;
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

		// matchedRule + matchedLayer only exist on the permission-ask
		// variant. Terminal-confirm cards skip this row entirely.
		const matchedRule = 'matchedRule' in data ? data.matchedRule : undefined;
		const matchedLayer = 'matchedLayer' in data ? data.matchedLayer : undefined;
		if (matchedRule) {
			hasMeta = true;
			const ruleSpan = dom.$('span.chipos-meta-rule');
			ruleSpan.appendChild(document.createTextNode(localize('chipos.card.ruleLabel', 'Rule: ')));
			const ruleCode = dom.$('code.chipos-meta-rule-code');
			ruleCode.textContent = matchedRule;
			ruleSpan.appendChild(ruleCode);
			ruleSpan.appendChild(document.createTextNode(` (${matchedLayer || 'default'})`));

			const copyBtn = dom.$('button.chipos-copy-btn');
			copyBtn.setAttribute('type', 'button');
			copyBtn.setAttribute('aria-label', localize('chipos.card.copyRuleAria', 'Copy rule key {0} to clipboard', matchedRule));
			copyBtn.setAttribute('title', localize('chipos.card.copyRuleTooltip', 'Copy rule key'));
			const copyIcon = dom.$('span.codicon.codicon-copy');
			copyBtn.appendChild(copyIcon);
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

		const sessionTail = this._truncateSession(data.sessionId ?? '');
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

		// ── Preview ───────────────────────────────────────────────────────────
		// Two modes:
		//   (a) Generic-confirm cards (spec/arch/code/agent/file_edit/...)
		//       opt into markdown rendering via `renderMessageAsMarkdown`.
		//       The full `confirmation.message` MarkdownString flows through
		//       IMarkdownRendererService so headings / code blocks / links
		//       all render properly. Otherwise these card types' rich
		//       content would be lost (which was the reason chipOSChatAgent
		//       used to keep them on the framework's default confirmation
		//       renderer pre-this-commit).
		//   (b) Worker permission ask / terminal / hook cards carry plain
		//       text in `contentPreview` and render it inside a `<pre>`
		//       monospace block — matches the design-spec for showing a
		//       command / file snippet inline.
		const renderAsMarkdown = (data as IChipOSGenericConfirmCardData).renderMessageAsMarkdown === true;
		// 2026-05-26: agent_ask multi-question card → render an inline radio
		// form. Detected via __chiposAgentAskCard marker; rendering replaces
		// the markdown preview path. The form mutates data.selections in place
		// so the click handler in _buildButtons → sendAction picks it up via
		// acceptedConfirmationData[0].data (the same data reference flows
		// through the chat framework's accept path).
		if (isChipOSAgentAskCardData(data)) {
			this._renderAgentAskForm(card, data);
		} else if (renderAsMarkdown) {
			const previewWrap = dom.$('.chipos-permission-preview.chipos-permission-preview-markdown');
			card.appendChild(previewWrap);
			const md = isMarkdownString(confirmation.message)
				? confirmation.message
				: new MarkdownString(typeof confirmation.message === 'string' ? confirmation.message : String(confirmation.message ?? ''), { supportThemeIcons: true, isTrusted: true });
			const rendered = this._register(this.markdownRendererService.render(md));
			previewWrap.appendChild(rendered.element);
		} else if ((data as { contentPreview?: string }).contentPreview) {
			const previewWrap = dom.$('.chipos-permission-preview');
			card.appendChild(previewWrap);
			const pre = dom.$('pre.chipos-code-preview');
			pre.textContent = (data as { contentPreview?: string }).contentPreview ?? '';
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
		data: IChipOSPermissionCardData | IChipOSTerminalConfirmCardData | IChipOSHookConfirmCardData | IChipOSGenericConfirmCardData,
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

		// Replace the action-button row with a pill showing WHICH action the
		// user picked once the card resolves. Reads "Allow once" / "Reject"
		// / "Run" / etc. — same label that was on the button — with a check
		// icon prefix. This is the visual confirmation that the click
		// landed AND surfaces the user's choice inline in the card, so the
		// separate "Selected 'Run'" framework bubble below the card becomes
		// redundant (hidden by chiposOverrides.css; see the
		// `.interactive-item-container.confirmation-message` rule).
		//
		// When called WITHOUT an option arg (historical re-render of a card
		// that landed but we no longer have button context), falls back to
		// the generic "Responded" label.
		const swapToRespondedPill = (chosen?: { label: string; action_id?: string }) => {
			while (buttonsRow.firstChild) {
				buttonsRow.removeChild(buttonsRow.firstChild);
			}
			const pill = dom.$('span.chipos-used-pill');
			if (chosen) {
				if (chosen.action_id) {
					pill.classList.add(`chipos-btn-${chosen.action_id.replace(/_/g, '-')}`);
				}
				const icon = dom.$('span.codicon.codicon-check.chipos-used-pill-icon');
				pill.appendChild(icon);
				const labelEl = dom.$('span.chipos-used-pill-label');
				labelEl.textContent = chosen.label;
				pill.appendChild(labelEl);
			} else {
				pill.textContent = localize('chipos.card.used', 'Responded');
			}
			buttonsRow.appendChild(pill);
		};

		const sendAction = async (opt: { label: string; action_id?: string }) => {
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
					swapToRespondedPill(opt);
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
			const actionSlug = opt.action_id ? opt.action_id.replace(/_/g, '-') : `option-${i + 1}`;
			btn.className = `chipos-action-btn chipos-btn-${actionSlug}`;
			// #1 — Show 1-4 number hint inside the button so users learn the
			// keyboard shortcuts inline (Cursor / Claude Code pattern).
			const numHint = dom.$('span.chipos-btn-num');
			numHint.textContent = String(i + 1);
			btn.appendChild(numHint);
			const labelSpan = dom.$('span.chipos-btn-label');
			labelSpan.textContent = opt.label;
			btn.appendChild(labelSpan);
			btn.setAttribute('aria-label', this._ariaLabel(opt.action_id ?? opt.label, data.specifier));
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

	private _makeBadge(data: IChipOSPermissionCardData | IChipOSTerminalConfirmCardData | IChipOSHookConfirmCardData | IChipOSGenericConfirmCardData): HTMLElement | undefined {
		// Terminal-confirm cards don't carry file-existence metadata —
		// the badge slot stays empty for them.
		if (!('targetExists' in data)) {
			return undefined;
		}
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

	/**
	 * 2026-05-26 — render a multi-question inline form for an `agent_ask` card
	 * (Read tool, e.g. AXI4-Lite "data_width? addr_width? reg_count? reset?").
	 *
	 * Layout:
	 *   ┌──────────────────────────────────────────────────────┐
	 *   │ context (optional, e.g. "Detected: AXI4-Lite slave") │
	 *   │                                                      │
	 *   │ 1. <prompt question 1>                               │
	 *   │    ( ) opt A   ( ) opt B   ( ) opt C                 │
	 *   │                                                      │
	 *   │ 2. <prompt question 2>                               │
	 *   │    ( ) opt A   ( ) opt B                             │
	 *   │  ...                                                 │
	 *   └──────────────────────────────────────────────────────┘
	 *
	 * Each radio's change handler writes
	 *   `data.selections[question.question_id] = option.action_id`
	 * The Submit button in _buildButtons reads back data.selections via
	 * acceptedConfirmationData (same data reference flows through), and
	 * chipOSChatAgent.invoke()'s accept branch JSON.stringifies it into
	 * the `comment` field of sendConfirmResponse. The reasoner
	 * agent_core.py (commit 96135978) already parses comment-as-JSON
	 * into augmented_prompt.
	 *
	 * Note: NO submit/skip wiring here — the bottom action row built by
	 * `_buildButtons` (called below) carries the "提交" / "跳过" buttons
	 * passed via `data.options`. This method only builds the radio
	 * groups.
	 */
	private _renderAgentAskForm(card: HTMLElement, data: IChipOSAgentAskCardData): void {
		const wrap = dom.$('.chipos-permission-preview.chipos-agent-ask-form');
		card.appendChild(wrap);

		if (data.context && data.context.trim().length > 0) {
			const ctxEl = dom.$('.chipos-agent-ask-context');
			ctxEl.textContent = data.context;
			wrap.appendChild(ctxEl);
		}

		// Stable per-card prefix so radio `name` groups don't collide across
		// multiple cards in the same chat session.
		const cardKey = `cak-${data.requestId || Math.random().toString(36).slice(2, 10)}`;

		for (let qi = 0; qi < data.questions.length; qi++) {
			const q = data.questions[qi];
			const qWrap = dom.$('.chipos-agent-ask-question');
			wrap.appendChild(qWrap);

			const qHeader = dom.$('.chipos-agent-ask-q-header');
			const qNum = dom.$('span.chipos-agent-ask-q-num');
			qNum.textContent = `${qi + 1}.`;
			qHeader.appendChild(qNum);
			const qPrompt = dom.$('span.chipos-agent-ask-q-prompt');
			qPrompt.textContent = q.prompt;
			qHeader.appendChild(qPrompt);
			qWrap.appendChild(qHeader);

			const optsWrap = dom.$('.chipos-agent-ask-options');
			qWrap.appendChild(optsWrap);

			const groupName = `${cardKey}-${q.question_id}`;
			for (let oi = 0; oi < q.options.length; oi++) {
				const opt = q.options[oi];
				const optLabel = document.createElement('label');
				optLabel.className = 'chipos-agent-ask-option';

				const radio = document.createElement('input');
				radio.type = 'radio';
				radio.name = groupName;
				radio.value = opt.action_id;
				radio.className = 'chipos-agent-ask-radio';
				// Pre-select if reasoner pre-filled a selection (or the user
				// previously committed and re-renders the card).
				if (data.selections[q.question_id] === opt.action_id) {
					radio.checked = true;
				}
				optLabel.appendChild(radio);

				const labelTxt = dom.$('span.chipos-agent-ask-option-label');
				labelTxt.textContent = opt.label;
				optLabel.appendChild(labelTxt);

				this._register(dom.addDisposableListener(radio, 'change', () => {
					if (radio.checked) {
						data.selections[q.question_id] = opt.action_id;
					}
				}));

				optsWrap.appendChild(optLabel);
			}
		}
	}

	// ── IChatContentPart ──────────────────────────────────────────────────────

	hasSameContent(other: IChatRendererContent, _following: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'confirmation') {
			return false;
		}
		return isChipOSCardData((other as IChatConfirmation).data);
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}
