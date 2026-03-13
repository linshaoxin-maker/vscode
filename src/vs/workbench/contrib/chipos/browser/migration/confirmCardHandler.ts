/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import * as dom from '../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { MiniWebviewHost } from '../../../../../workbench/contrib/chipos/browser/chatPanel/miniWebviewHost.js';
import type { IConfirmEvent } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const $ = dom.$;

export interface IConfirmResponse {
	readonly hook_id: string;
	readonly action: 'confirm' | 'reject' | 'skip';
	readonly comment?: string;
}

const AUTO_APPROVE_CONFIG_KEY = 'chipos.agent.autoApprove';
const CONFIRM_CARD_GROUP_TIMEOUT_MS = 300;

export class ConfirmCardHandler extends Disposable {

	private readonly _onDidRespond = this._register(new Emitter<IConfirmResponse>());
	readonly onDidRespond: Event<IConfirmResponse> = this._onDidRespond.event;

	private readonly _activeCards = new Map<string, { element: HTMLElement; disposables: DisposableStore }>();
	private _pendingAutoApprove: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	handleConfirmEvent(event: IConfirmEvent): void {
		const { payload } = event;

		if (this._isAutoApproveEnabled()) {
			this._logService.debug('[ConfirmCardHandler] Auto-approving hook:', payload.hook_id);
			this._scheduleAutoApprove(payload.hook_id);
			return;
		}

		this._logService.trace('[ConfirmCardHandler] Rendering confirm card:', payload.card_type, payload.hook_id);

		let cardElement: HTMLElement;
		if (payload.card_type === 'simple') {
			cardElement = this._renderSimpleConfirm(event);
		} else {
			cardElement = this._renderComplexConfirm(event);
		}

		this._container.appendChild(cardElement);
	}

	override dispose(): void {
		if (this._pendingAutoApprove !== undefined) {
			clearTimeout(this._pendingAutoApprove);
		}
		for (const entry of this._activeCards.values()) {
			entry.disposables.dispose();
		}
		this._activeCards.clear();
		super.dispose();
	}

	// ── Simple confirm (native DOM buttons) ───────────────────────────────

	private _renderSimpleConfirm(event: IConfirmEvent): HTMLElement {
		const { payload } = event;
		const disposables = new DisposableStore();

		const card = $('.chipos-confirm-card.chipos-confirm-card-simple');
		card.dataset.hookId = payload.hook_id;

		const header = $('.chipos-confirm-header');
		const hookLabel = $('span.chipos-confirm-hook-name');
		hookLabel.textContent = payload.hook_id;
		header.appendChild(hookLabel);
		card.appendChild(header);

		if (payload.card_data['description']) {
			const desc = $('.chipos-confirm-description');
			desc.textContent = String(payload.card_data['description']);
			card.appendChild(desc);
		}

		if (payload.card_data['details']) {
			const details = $('pre.chipos-confirm-details');
			try {
				details.textContent = typeof payload.card_data['details'] === 'string'
					? payload.card_data['details'] as string
					: JSON.stringify(payload.card_data['details'], null, 2);
			} catch {
				details.textContent = String(payload.card_data['details']);
			}
			card.appendChild(details);
		}

		const buttonRow = $('.chipos-confirm-buttons');

		const confirmBtn = $('button.chipos-confirm-btn.chipos-confirm-btn-confirm');
		confirmBtn.textContent = 'Confirm';
		disposables.add(dom.addDisposableListener(confirmBtn, 'click', () => {
			this._handleResponse(payload.hook_id, 'confirm');
		}));
		buttonRow.appendChild(confirmBtn);

		const rejectBtn = $('button.chipos-confirm-btn.chipos-confirm-btn-reject');
		rejectBtn.textContent = 'Reject';
		disposables.add(dom.addDisposableListener(rejectBtn, 'click', () => {
			this._handleResponse(payload.hook_id, 'reject');
		}));
		buttonRow.appendChild(rejectBtn);

		if (payload.skippable) {
			const skipBtn = $('button.chipos-confirm-btn.chipos-confirm-btn-skip');
			skipBtn.textContent = 'Skip';
			disposables.add(dom.addDisposableListener(skipBtn, 'click', () => {
				this._handleResponse(payload.hook_id, 'skip');
			}));
			buttonRow.appendChild(skipBtn);
		}

		card.appendChild(buttonRow);

		this._activeCards.set(payload.hook_id, { element: card, disposables });
		return card;
	}

	// ── Complex confirm (MiniWebviewHost) ─────────────────────────────────

	private _renderComplexConfirm(event: IConfirmEvent): HTMLElement {
		const { payload } = event;
		const disposables = new DisposableStore();

		const card = $('.chipos-confirm-card.chipos-confirm-card-complex');
		card.dataset.hookId = payload.hook_id;

		const header = $('.chipos-confirm-header');
		const hookLabel = $('span.chipos-confirm-hook-name');
		hookLabel.textContent = payload.hook_id;
		header.appendChild(hookLabel);

		const typeBadge = $('span.chipos-confirm-type-badge');
		typeBadge.textContent = payload.card_type;
		header.appendChild(typeBadge);
		card.appendChild(header);

		const webviewContainer = $('.chipos-confirm-webview-container');
		card.appendChild(webviewContainer);

		const host = disposables.add(
			this._instantiationService.createInstance(MiniWebviewHost, webviewContainer)
		);

		disposables.add(host.onDidReceiveMessage((msg) => {
			this._handleWebviewMessage(payload.hook_id, payload.skippable, msg);
		}));

		host.loadCard(payload.card_type, payload.card_data);

		const buttonRow = $('.chipos-confirm-buttons');

		const confirmBtn = $('button.chipos-confirm-btn.chipos-confirm-btn-confirm');
		confirmBtn.textContent = 'Confirm';
		disposables.add(dom.addDisposableListener(confirmBtn, 'click', () => {
			this._handleResponse(payload.hook_id, 'confirm');
		}));
		buttonRow.appendChild(confirmBtn);

		const rejectBtn = $('button.chipos-confirm-btn.chipos-confirm-btn-reject');
		rejectBtn.textContent = 'Reject';
		disposables.add(dom.addDisposableListener(rejectBtn, 'click', () => {
			this._handleResponse(payload.hook_id, 'reject');
		}));
		buttonRow.appendChild(rejectBtn);

		if (payload.skippable) {
			const skipBtn = $('button.chipos-confirm-btn.chipos-confirm-btn-skip');
			skipBtn.textContent = 'Skip';
			disposables.add(dom.addDisposableListener(skipBtn, 'click', () => {
				this._handleResponse(payload.hook_id, 'skip');
			}));
			buttonRow.appendChild(skipBtn);
		}

		card.appendChild(buttonRow);

		this._activeCards.set(payload.hook_id, { element: card, disposables });
		return card;
	}

	// ── Response handling ─────────────────────────────────────────────────

	private _handleResponse(hookId: string, action: 'confirm' | 'reject' | 'skip', comment?: string): void {
		this._logService.debug('[ConfirmCardHandler] Response:', hookId, action);

		this._onDidRespond.fire({ hook_id: hookId, action, comment });

		const entry = this._activeCards.get(hookId);
		if (entry) {
			entry.element.classList.add('chipos-confirm-card-responded');
			const badge = $('span.chipos-confirm-response-badge');
			badge.textContent = action === 'confirm' ? '✓ Confirmed' : action === 'reject' ? '✗ Rejected' : '⏭ Skipped';
			entry.element.appendChild(badge);

			entry.disposables.dispose();
			this._activeCards.delete(hookId);
		}
	}

	private _handleWebviewMessage(hookId: string, skippable: boolean, msg: unknown): void {
		if (typeof msg !== 'object' || msg === null) {
			return;
		}

		const data = msg as Record<string, unknown>;
		if (data['type'] === 'chipos:confirm:response') {
			const action = data['action'];
			if (action === 'confirm' || action === 'reject' || (action === 'skip' && skippable)) {
				this._handleResponse(hookId, action as 'confirm' | 'reject' | 'skip', data['comment'] as string | undefined);
			}
		}
	}

	// ── Auto-approve ──────────────────────────────────────────────────────

	private _isAutoApproveEnabled(): boolean {
		return this._configurationService.getValue<boolean>(AUTO_APPROVE_CONFIG_KEY) === true;
	}

	private _scheduleAutoApprove(hookId: string): void {
		if (this._pendingAutoApprove !== undefined) {
			clearTimeout(this._pendingAutoApprove);
		}
		this._pendingAutoApprove = setTimeout(() => {
			this._pendingAutoApprove = undefined;
			this._onDidRespond.fire({ hook_id: hookId, action: 'confirm' });
		}, CONFIRM_CARD_GROUP_TIMEOUT_MS);
	}
}
