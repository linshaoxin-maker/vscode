/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import { IThemeService, IColorTheme } from 'vs/platform/theme/common/themeService';
import {
	editorBackground,
	editorForeground,
} from 'vs/platform/theme/common/colorRegistry';

const $ = dom.$;

const CARD_LOAD_TIMEOUT_MS = 5000;

const SANDBOX_ATTRS = 'allow-scripts allow-same-origin';

/**
 * Lightweight iframe host for rendering rich cards (simulation reports,
 * confirmation dialogs, coverage reports, etc.) within the native Chat Panel.
 * The iframe is sandboxed and communicates with the host via postMessage.
 */
export class MiniWebviewHost extends Disposable {

	private readonly _wrapper: HTMLElement;
	private _iframe: HTMLIFrameElement | undefined;
	private readonly _fallbackContainer: HTMLElement;

	private readonly _onDidReceiveMessage = this._register(new Emitter<unknown>());
	readonly onDidReceiveMessage: Event<unknown> = this._onDidReceiveMessage.event;

	private _messageListener: ((e: MessageEvent) => void) | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super();

		this._wrapper = $('.chipos-mini-webview-host');
		this._fallbackContainer = $('.chipos-mini-webview-fallback');
		this._fallbackContainer.style.display = 'none';
		this._wrapper.appendChild(this._fallbackContainer);

		this._container.appendChild(this._wrapper);

		this._register(this._themeService.onDidColorThemeChange(() => {
			this._syncTheme();
		}));
	}

	// ── Public API ─────────────────────────────────────────────────────────

	async loadCard(cardType: string, data: Record<string, unknown>): Promise<void> {
		this._disposeIframe();
		this._fallbackContainer.style.display = 'none';

		this._iframe = document.createElement('iframe');
		this._iframe.className = 'chipos-mini-webview-iframe';
		this._iframe.setAttribute('sandbox', SANDBOX_ATTRS);
		this._iframe.setAttribute('tabindex', '-1');
		this._wrapper.appendChild(this._iframe);

		this._messageListener = (e: MessageEvent) => {
			if (e.source === this._iframe?.contentWindow) {
				this._onDidReceiveMessage.fire(e.data);
			}
		};
		window.addEventListener('message', this._messageListener);

		const loaded = await this._waitForLoad(this._iframe);
		if (!loaded) {
			this._showFallback(cardType, data);
			return;
		}

		const doc = this._iframe.contentDocument;
		if (!doc) {
			this._showFallback(cardType, data);
			return;
		}

		this._injectBaseStyles(doc);
		this._syncTheme();
		this._postInitMessage(cardType, data);
	}

	postMessageToCard(message: unknown): void {
		this._iframe?.contentWindow?.postMessage(message, '*');
	}

	override dispose(): void {
		this._disposeIframe();
		super.dispose();
	}

	// ── Private ────────────────────────────────────────────────────────────

	private _waitForLoad(iframe: HTMLIFrameElement): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const timer = setTimeout(() => {
				resolve(false);
			}, CARD_LOAD_TIMEOUT_MS);

			iframe.addEventListener('load', () => {
				clearTimeout(timer);
				resolve(true);
			}, { once: true });

			iframe.addEventListener('error', () => {
				clearTimeout(timer);
				resolve(false);
			}, { once: true });

			// Write a blank document to trigger load
			iframe.srcdoc = '<!DOCTYPE html><html><head></head><body></body></html>';
		});
	}

	private _injectBaseStyles(doc: Document): void {
		const style = doc.createElement('style');
		style.textContent = `
			:root {
				color-scheme: light dark;
			}
			body {
				margin: 0;
				padding: 8px;
				font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
				font-size: var(--vscode-font-size, 13px);
				color: var(--vscode-editor-foreground, #cccccc);
				background: var(--vscode-editor-background, #1e1e1e);
			}
			* { box-sizing: border-box; }
		`;
		doc.head.appendChild(style);
	}

	private _syncTheme(): void {
		if (!this._iframe?.contentDocument) {
			return;
		}

		const theme: IColorTheme = this._themeService.getColorTheme();
		const root = this._iframe.contentDocument.documentElement;

		const bg = theme.getColor(editorBackground);
		const fg = theme.getColor(editorForeground);

		if (bg) {
			root.style.setProperty('--vscode-editor-background', bg.toString());
		}
		if (fg) {
			root.style.setProperty('--vscode-editor-foreground', fg.toString());
		}
	}

	private _postInitMessage(cardType: string, data: Record<string, unknown>): void {
		this._iframe?.contentWindow?.postMessage({
			type: 'chipos:card:init',
			cardType,
			data,
		}, '*');
	}

	private _showFallback(cardType: string, data: Record<string, unknown>): void {
		this._disposeIframe();
		this._fallbackContainer.style.display = '';
		dom.clearNode(this._fallbackContainer);

		const title = $('div.chipos-mini-webview-fallback-title');
		title.textContent = `[${cardType}] Card failed to load`;
		this._fallbackContainer.appendChild(title);

		const content = $('pre.chipos-mini-webview-fallback-content');
		try {
			content.textContent = JSON.stringify(data, null, 2);
		} catch {
			content.textContent = String(data);
		}
		this._fallbackContainer.appendChild(content);
	}

	private _disposeIframe(): void {
		if (this._messageListener) {
			window.removeEventListener('message', this._messageListener);
			this._messageListener = undefined;
		}
		if (this._iframe) {
			this._iframe.remove();
			this._iframe = undefined;
		}
	}
}
