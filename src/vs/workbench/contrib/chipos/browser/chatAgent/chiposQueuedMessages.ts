/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatWidget } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatRequestQueueKind, IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatPendingRequest } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';

/**
 * ChipOS Queued Messages bar — Claude Code–style "what's queued up next"
 * card stack rendered directly above the chat input box.
 *
 * Why this exists:
 *   The framework auto-queues messages submitted while a request is in
 *   flight (see `_acceptInput` in chatWidget.ts), but only surfaces them
 *   as a `pendingDivider` entry at the end of the chat transcript — easy
 *   to miss, hard to cancel without scrolling. This bar shows each queued
 *   message inline above the input with a × to dequeue.
 *
 * Owner: `ChipOSQueuedMessagesContribution` instantiates one per
 * `.chipos-queued-messages-slot` element (created in `chatInputPart.ts`).
 * The contribution also pairs each slot with the IChatWidget that owns it
 * (by DOM containment) and routes `attachWidget`/`detachWidget` here.
 *
 * Rendering shape (only when there are queued items):
 *   ┌─────────────────────────────────────┐
 *   │ 2 queued                            │  ← header
 *   ├─────────────────────────────────────┤
 *   │ run the tests in src/foo          × │  ← per-message card
 *   │ then commit with message "feat:…" × │
 *   └─────────────────────────────────────┘
 */
export class ChipOSQueuedMessages extends Disposable {
	private readonly _container: HTMLElement;
	private readonly _widgetSubscription = this._register(new MutableDisposable<DisposableStore>());
	private readonly _rowListeners = this._register(new DisposableStore());
	private _currentWidget: IChatWidget | undefined;
	/** Pending-request count from the previous render — used to detect "queue grew". */
	private _lastPendingCount = 0;
	/** Deferred scroll-to-end after the bar grows (waits for the re-layout). */
	private readonly _scrollSchedule = this._register(new MutableDisposable());

	constructor(
		host: HTMLElement,
		@IChatService private readonly _chatService: IChatService,
		@IHoverService private readonly _hoverService: IHoverService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._container = host;
		this._container.classList.add('chipos-queued-messages');
		this._container.classList.add('chipos-queued-messages-empty');
	}

	/**
	 * Attach to a chat widget — subscribe to its current view-model's pending
	 * requests, and re-subscribe on view-model swap (session switch).
	 */
	attachWidget(widget: IChatWidget): void {
		if (this._currentWidget === widget) {
			return;
		}
		this._currentWidget = widget;
		this._lastPendingCount = 0;
		const sub = new DisposableStore();
		this._widgetSubscription.value = sub;

		// View-model can be replaced when the user switches sessions. Wrap
		// the per-model subscription in a MutableDisposable so the outer
		// `_widgetSubscription` owns both this swap-watcher and the inner
		// per-model listener.
		const perModel = sub.add(new MutableDisposable<DisposableStore>());
		const subscribeToCurrentModel = () => {
			const inner = new DisposableStore();
			perModel.value = inner;
			const vm = widget.viewModel;
			if (vm) {
				inner.add(vm.model.onDidChangePendingRequests(() => this.render()));
			}
			this.render();
		};
		subscribeToCurrentModel();
		sub.add(widget.onDidChangeViewModel(() => subscribeToCurrentModel()));
	}

	/**
	 * Drop the current widget binding — called when the slot owner widget
	 * is detached (chat panel closed, pane disposed).
	 */
	detachWidget(): void {
		this._currentWidget = undefined;
		this._widgetSubscription.clear();
		this.render();
	}

	private render(): void {
		this._rowListeners.clear();
		dom.clearNode(this._container);

		const widget = this._currentWidget;
		const vm = widget?.viewModel;
		const sessionResource = vm?.sessionResource;
		if (!vm || !sessionResource) {
			this._container.classList.add('chipos-queued-messages-empty');
			return;
		}
		// Include BOTH user-pending kinds:
		//   - Queued: waits for current request to fully complete
		//   - Steering: signals current request to yield, then sends next
		// Both are user-submitted-while-busy messages. (ChipOS defaults
		// `chat.requestQueuing.defaultAction` to 'queue', but a user can still
		// steer explicitly, so render either kind.)
		const pending = vm.model.getPendingRequests();

		// When the queue GROWS, the bar gets taller and pushes the transcript
		// shorter; a tall latest card (e.g. an agent_ask / permission request)
		// then has its bottom clipped behind the bar. Scroll the transcript to
		// the end — after the input-part ResizeObserver has re-laid out the list
		// to the new height — so the latest card stays fully visible above the
		// bar. Only on growth, so we don't fight the user's manual scrolling.
		const grew = pending.length > this._lastPendingCount;
		this._lastPendingCount = pending.length;
		if (grew && pending.length > 0 && widget) {
			const win = dom.getWindow(this._container);
			this._scrollSchedule.value = dom.scheduleAtNextAnimationFrame(win, () => {
				this._scrollSchedule.value = dom.scheduleAtNextAnimationFrame(win, () => widget.scrollToEnd());
			});
		}

		if (pending.length === 0) {
			this._container.classList.add('chipos-queued-messages-empty');
			return;
		}
		this._container.classList.remove('chipos-queued-messages-empty');

		const header = dom.append(this._container, dom.$('.chipos-queued-messages-header'));
		const headerIcon = dom.append(header, dom.$('span.chipos-queued-messages-header-icon.codicon.codicon-history'));
		void headerIcon;
		const headerLabel = dom.append(header, dom.$('span.chipos-queued-messages-header-label'));
		headerLabel.textContent = pending.length === 1
			? localize('chipos.queue.headerOne', '1 pending message')
			: localize('chipos.queue.headerN', '{0} pending messages', pending.length);

		const list = dom.append(this._container, dom.$('.chipos-queued-messages-list'));
		for (const p of pending) {
			this._renderItem(list, p, sessionResource);
		}
	}

	private _renderItem(parent: HTMLElement, pending: IChatPendingRequest, sessionResource: URI): void {
		const card = dom.append(parent, dom.$('.chipos-queued-message'));
		// Steering vs Queued affects styling + the small "kind" badge.
		// Steering carries a yield-now intent so we mark it visually
		// distinct, but the cancel behavior is identical (both flow
		// through `chatService.removePendingRequest`).
		const isSteering = pending.kind === ChatRequestQueueKind.Steering;
		if (isSteering) {
			card.classList.add('chipos-queued-message-steering');
		}

		// Small inline badge for steering items so the user understands
		// the semantic difference vs a plain queued message. No badge for
		// Queued (the default-looking card already conveys "waiting").
		if (isSteering) {
			const badge = dom.append(card, dom.$('span.chipos-queued-message-badge'));
			badge.textContent = localize('chipos.queue.steeringBadge', 'steer');
			this._rowListeners.add(this._hoverService.setupManagedHover(
				getDefaultHoverDelegate('mouse'),
				badge,
				localize('chipos.queue.steeringTooltip', "Steering: will be sent at the next tool-call boundary, signaling the current request to yield"),
			));
		}

		const textEl = dom.append(card, dom.$('.chipos-queued-message-text'));
		// `request.message.text` is the raw user input (with @mentions,
		// /commands, file refs, etc. still in their text form). Trim
		// whitespace so the card doesn't render with a blank first line
		// when the user hit Enter with no content (defensive — the
		// framework usually rejects empty requests, but be safe).
		textEl.textContent = pending.request.message.text.trim();

		const cancelTooltip = isSteering
			? localize('chipos.queue.cancelSteering', 'Cancel steering message')
			: localize('chipos.queue.cancel', 'Cancel queued message');
		const closeBtn = dom.append(card, dom.$('span.chipos-queued-message-close.codicon.codicon-close'));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', cancelTooltip);
		closeBtn.setAttribute('tabindex', '0');
		this._rowListeners.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), closeBtn, cancelTooltip));

		const removeRequest = () => {
			try {
				this._chatService.removePendingRequest(sessionResource, pending.request.id);
			} catch (err) {
				this._logService.warn('[ChipOS Queue] removePendingRequest failed', err);
			}
		};

		this._rowListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			removeRequest();
		}));
		this._rowListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				e.stopPropagation();
				removeRequest();
			}
		}));
	}

	override dispose(): void {
		dom.clearNode(this._container);
		this._container.classList.remove('chipos-queued-messages');
		this._container.classList.remove('chipos-queued-messages-empty');
		super.dispose();
	}
}

/**
 * Helper to materialize a ChipOSQueuedMessages via DI given the host
 * element. Mirrors `createChipOSChatSessionTabs` so service-layer code
 * doesn't have to import the heavy DOM widget directly.
 */
export function createChipOSQueuedMessages(
	instantiationService: IInstantiationService,
	host: HTMLElement,
): ChipOSQueuedMessages {
	return instantiationService.createInstance(ChipOSQueuedMessages, host);
}
