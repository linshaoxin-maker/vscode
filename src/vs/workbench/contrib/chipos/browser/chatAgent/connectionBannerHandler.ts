/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import './connectionBanner.css';

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import * as dom from '../../../../../base/browser/dom.js';
import { ConnectionState } from '../eventTypes.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/**
 * Manages a floating "connection lost" banner inside the chat widget's
 * `.interactive-list` container.
 *
 * Lifecycle:
 *  - Call `show(state, onReconnect)` when connection drops → banner appears
 *  - Call `hide()` when connection is restored → banner fades out and is removed
 *  - Dispose to clean up all DOM and listeners
 */
export class ConnectionBannerHandler extends Disposable {

	private _bannerEl: HTMLElement | undefined;
	private _bannerDisposables = this._register(new DisposableStore());
	private _currentState: ConnectionState | undefined;

	constructor(
		private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Show (or update) the connection banner inside the given chat container.
	 * @param container  The `.interactive-list` element of the chat widget
	 * @param state      Current connection state (Reconnecting | Error | Disconnected)
	 * @param onReconnect  Callback invoked when the user clicks "Reconnect Now"
	 */
	show(container: HTMLElement, state: ConnectionState, onReconnect: () => void): void {
		this._currentState = state;

		if (this._bannerEl) {
			// Already visible — just update the content
			this._updateContent(state, onReconnect);
			return;
		}

		this._bannerDisposables.clear();

		const banner = dom.$('.chipos-connection-banner');
		this._bannerEl = banner;

		// Insert at the bottom of the list container (above the input)
		container.appendChild(banner);

		this._updateContent(state, onReconnect);

		this._logService.trace('[ConnectionBanner] shown, state=%s', state);
	}

	/**
	 * Hide and remove the banner (e.g. when connection is restored).
	 */
	hide(): void {
		if (!this._bannerEl) { return; }

		const el = this._bannerEl;
		this._bannerEl = undefined;
		this._currentState = undefined;
		this._bannerDisposables.clear();

		// Fade out then remove
		el.classList.add('chipos-connection-banner--hiding');
		const onEnd = () => {
			el.removeEventListener('animationend', onEnd);
			el.remove();
		};
		el.addEventListener('animationend', onEnd);

		// Safety fallback: remove after 400ms even if animationend doesn't fire
		setTimeout(() => { el.remove(); }, 400);

		this._logService.trace('[ConnectionBanner] hidden');
	}

	private _updateContent(state: ConnectionState, onReconnect: () => void): void {
		if (!this._bannerEl) { return; }
		this._bannerDisposables.clear();
		dom.clearNode(this._bannerEl);

		// ── Icon + message ──
		const left = dom.append(this._bannerEl, dom.$('.chipos-connection-banner-left'));

		const iconEl = dom.append(left, dom.$('.chipos-connection-banner-icon.codicon'));
		const msgEl = dom.append(left, dom.$('.chipos-connection-banner-msg'));

		if (state === ConnectionState.Reconnecting) {
			iconEl.classList.add('codicon-loading', 'codicon-modifier-spin');
			msgEl.textContent = localize('chipos.banner.reconnecting', 'Connection lost — reconnecting to ChipOS backend...');
			this._bannerEl.classList.remove('chipos-connection-banner--error');
		} else {
			// Error or Disconnected
			iconEl.classList.add('codicon-plug');
			msgEl.textContent = localize('chipos.banner.disconnected', 'ChipOS backend disconnected. Check if the Reasoner is running.');
			this._bannerEl.classList.add('chipos-connection-banner--error');
		}

		// ── Actions ──
		const actions = dom.append(this._bannerEl, dom.$('.chipos-connection-banner-actions'));

		if (state !== ConnectionState.Reconnecting) {
			// Manual reconnect button — only shown when auto-reconnect has given up
			const reconnectBtn = dom.append(actions, dom.$<HTMLButtonElement>('button.chipos-connection-banner-btn'));
			reconnectBtn.textContent = localize('chipos.banner.reconnect', 'Reconnect Now');
			this._bannerDisposables.add(dom.addDisposableListener(reconnectBtn, 'click', () => {
				// Switch to reconnecting state visually while the caller tries
				iconEl.classList.remove('codicon-plug');
				iconEl.classList.add('codicon-loading', 'codicon-modifier-spin');
				msgEl.textContent = localize('chipos.banner.reconnecting', 'Connection lost — reconnecting to ChipOS backend...');
				reconnectBtn.disabled = true;
				onReconnect();
			}));
		}

		// Dismiss button
		const dismissBtn = dom.append(actions, dom.$('button.chipos-connection-banner-dismiss'));
		dismissBtn.setAttribute('aria-label', localize('chipos.banner.dismiss', 'Dismiss'));
		dismissBtn.classList.add('codicon', 'codicon-close');
		this._bannerDisposables.add(dom.addDisposableListener(dismissBtn, 'click', () => {
			this.hide();
		}));
	}

	get isVisible(): boolean {
		return !!this._bannerEl;
	}

	get currentState(): ConnectionState | undefined {
		return this._currentState;
	}
}
