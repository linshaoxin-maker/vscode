/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChipOSQueuedMessages, createChipOSQueuedMessages } from './chiposQueuedMessages.js';

/**
 * ChipOS Queued Messages contribution — orchestrates the lifecycle of the
 * per-chat-input queued-messages bar. It walks the document for
 * `.chipos-queued-messages-slot` elements (seeded in `chatInputPart.ts`'s
 * element tree) and mounts one `ChipOSQueuedMessages` widget inside each
 * one, paired with the IChatWidget that DOM-contains the slot.
 *
 * Why this mirrors the chat-session-tabs contribution pattern (and not,
 * say, a per-IChatWidget subclass or an IChatWidgetContrib registration):
 *   - The slot lives inside `ChatInputPart`, which is a sub-component of
 *     `ChatWidget`. There's no clean injection point in either class to
 *     instantiate a chipos widget without leaking concerns. Going through
 *     the DOM + MutationObserver keeps the change minimal and isolated.
 *   - `IChatWidgetContrib` runs in the widget's instantiation scope but
 *     fires too early — the slot DOM element doesn't exist until the
 *     input part's `render()` runs. By the time MutationObserver picks
 *     it up, all DOM is ready.
 *
 * Slot → widget pairing:
 *   When a slot appears in the DOM, walk up to find its owning
 *   `IChatWidget`. We match by `widget.domNode.contains(slot)` — the slot
 *   lives inside the chat input part, which lives inside the chat
 *   widget's DOM tree. Only one widget will contain any given slot.
 *
 * Lifecycle:
 *   - Construct on `WorkbenchPhase.BlockRestore`.
 *   - One `ChipOSQueuedMessages` per slot, indexed by HTMLElement key in
 *     a `DisposableMap` so dropping the slot reference disposes the
 *     widget and its event subscriptions.
 *   - MutationObserver coalesces bursts of unrelated DOM mutations via
 *     `queueMicrotask` to a single rescan.
 */
export class ChipOSQueuedMessagesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.queuedMessages';

	private readonly _bars = this._register(new DisposableMap<HTMLElement, ChipOSQueuedMessages>());

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
	) {
		super();

		// Initial mount attempt for any chat widget already rendered (e.g.
		// the user reloads the window with the chat panel restored open).
		queueMicrotask(() => this._scanAndMount());

		// React to subsequent chat widget additions. New widgets create
		// fresh slot DOM elements; we need to bind them.
		this._register(this._chatWidgetService.onDidAddWidget(() => this._scanAndMount()));

		// MutationObserver: the chat panel can be closed/reopened, the
		// orientation can flip, etc. — all of which rebuild the chat
		// input DOM and produce new slot elements. Coalesce mutation
		// bursts with `queueMicrotask` so we run one rescan per turn.
		let scanScheduled = false;
		const observer = new MutationObserver(mutations => {
			let touchesSlot = false;
			outer: for (const m of mutations) {
				for (const n of [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)]) {
					if (!(n instanceof HTMLElement)) {
						continue;
					}
					if (n.classList?.contains('chipos-queued-messages-slot') ||
						n.querySelector?.('.chipos-queued-messages-slot')) {
						touchesSlot = true;
						break outer;
					}
				}
			}
			if (!touchesSlot || scanScheduled) {
				return;
			}
			scanScheduled = true;
			queueMicrotask(() => {
				scanScheduled = false;
				this._scanAndMount();
			});
		});
		observer.observe(document.body, { childList: true, subtree: true });
		this._register({ dispose: () => observer.disconnect() });
	}

	private _findOwningWidget(slot: HTMLElement): IChatWidget | undefined {
		// Walk all known widgets and pick the one whose DOM tree contains
		// the slot. The slot lives inside `ChatInputPart`'s DOM, which
		// lives inside the chat widget's DOM, so containment is a clean
		// "this slot belongs to that widget" test.
		for (const widget of this._chatWidgetService.getAllWidgets()) {
			if (widget.domNode && widget.domNode.contains(slot)) {
				return widget;
			}
		}
		return undefined;
	}

	private _scanAndMount(): void {
		// Drop bars whose slot is no longer in the document (chat panel
		// closed, layout flipped, etc.). DisposableMap disposes the
		// widget + its event subscriptions on `deleteAndDispose`.
		for (const [slot] of this._bars) {
			if (!slot.isConnected) {
				this._bars.deleteAndDispose(slot);
			}
		}

		const slots = document.querySelectorAll<HTMLElement>('.chipos-queued-messages-slot');
		for (const slot of Array.from(slots)) {
			if (!this._bars.get(slot)) {
				const bar = createChipOSQueuedMessages(this._instantiationService, slot);
				this._bars.set(slot, bar);
				const widget = this._findOwningWidget(slot);
				if (widget) {
					bar.attachWidget(widget);
				}
				continue;
			}
			// Slot already mounted — re-resolve owning widget in case the
			// widget service learned of it after we mounted (e.g. mount
			// happened before `onDidAddWidget` fired).
			const widget = this._findOwningWidget(slot);
			if (widget) {
				this._bars.get(slot)!.attachWidget(widget);
			}
		}
	}
}

registerWorkbenchContribution2(ChipOSQueuedMessagesContribution.ID, ChipOSQueuedMessagesContribution, WorkbenchPhase.BlockRestore);
