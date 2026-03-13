/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import { IContextKeyService, RawContextKey, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import type { IMentionItem } from 'vs/workbench/contrib/chipos/browser/eventStream/eventTypes';

const $ = dom.$;

export const ChipOSChatInputFocused = new RawContextKey<boolean>('chiposChatInputFocused', false);

export interface ISubmitEvent {
	readonly text: string;
	readonly mentions: IMentionItem[];
}

export class ChatInputWidget extends Disposable {

	private readonly _container: HTMLElement;
	private readonly _textarea: HTMLTextAreaElement;
	private readonly _sendButton: HTMLButtonElement;
	private readonly _stopButton: HTMLButtonElement;
	private readonly _thinkingToggle: HTMLInputElement;
	private readonly _autoApproveToggle: HTMLInputElement;
	private readonly _attachmentSlot: HTMLElement;
	private readonly _controlsRow: HTMLElement;

	private readonly _inputFocusedKey: IContextKey<boolean>;
	private _isAgentRunning = false;
	private _mentions: IMentionItem[] = [];

	private readonly _onDidSubmit = this._register(new Emitter<ISubmitEvent>());
	readonly onDidSubmit: Event<ISubmitEvent> = this._onDidSubmit.event;

	private readonly _onDidRequestStop = this._register(new Emitter<void>());
	readonly onDidRequestStop: Event<void> = this._onDidRequestStop.event;

	constructor(
		parent: HTMLElement,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._inputFocusedKey = ChipOSChatInputFocused.bindTo(contextKeyService);

		this._container = $('.chipos-chat-input-area');

		// ── Attachment slot (FEAT-03, FEAT-05 placeholder) ─────────────────
		this._attachmentSlot = $('.chipos-chat-attachment-slot');
		this._container.appendChild(this._attachmentSlot);

		// ── Textarea ───────────────────────────────────────────────────────
		const inputRow = $('.chipos-chat-input-row');

		this._textarea = document.createElement('textarea');
		this._textarea.className = 'chipos-chat-textarea';
		this._textarea.placeholder = 'Ask ChipOS anything… (Enter to send, Shift+Enter for newline)';
		this._textarea.rows = 1;
		inputRow.appendChild(this._textarea);

		// Send button
		this._sendButton = document.createElement('button');
		this._sendButton.className = 'chipos-chat-send-btn';
		this._sendButton.textContent = '▶';
		this._sendButton.title = 'Send message';
		inputRow.appendChild(this._sendButton);

		// Stop button (hidden by default)
		this._stopButton = document.createElement('button');
		this._stopButton.className = 'chipos-chat-stop-btn';
		this._stopButton.textContent = '■';
		this._stopButton.title = 'Stop agent';
		this._stopButton.style.display = 'none';
		inputRow.appendChild(this._stopButton);

		this._container.appendChild(inputRow);

		// ── Controls row ──────────────────────────────────────────────────
		this._controlsRow = $('.chipos-chat-controls-row');

		// Thinking toggle
		const thinkingLabel = $('label.chipos-chat-toggle-label');
		this._thinkingToggle = document.createElement('input');
		this._thinkingToggle.type = 'checkbox';
		this._thinkingToggle.className = 'chipos-chat-toggle';
		thinkingLabel.appendChild(this._thinkingToggle);
		const thinkingText = $('span');
		thinkingText.textContent = 'Thinking';
		thinkingLabel.appendChild(thinkingText);
		this._controlsRow.appendChild(thinkingLabel);

		// Auto-approve toggle
		const autoApproveLabel = $('label.chipos-chat-toggle-label');
		this._autoApproveToggle = document.createElement('input');
		this._autoApproveToggle.type = 'checkbox';
		this._autoApproveToggle.className = 'chipos-chat-toggle';
		autoApproveLabel.appendChild(this._autoApproveToggle);
		const autoApproveText = $('span');
		autoApproveText.textContent = 'Auto-approve';
		autoApproveLabel.appendChild(autoApproveText);
		this._controlsRow.appendChild(autoApproveLabel);

		this._container.appendChild(this._controlsRow);

		parent.appendChild(this._container);

		// ── Event listeners ───────────────────────────────────────────────
		this._registerListeners();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	setAgentRunning(isRunning: boolean): void {
		this._isAgentRunning = isRunning;
		this._sendButton.style.display = isRunning ? 'none' : '';
		this._stopButton.style.display = isRunning ? '' : 'none';
		this._textarea.disabled = isRunning;
		this._textarea.placeholder = isRunning
			? 'Agent is running…'
			: 'Ask ChipOS anything… (Enter to send, Shift+Enter for newline)';
	}

	getText(): string {
		return this._textarea.value;
	}

	clear(): void {
		this._textarea.value = '';
		this._mentions = [];
		this._autoResize();
		this._clearAttachmentSlot();
	}

	focus(): void {
		this._textarea.focus();
	}

	isThinkingEnabled(): boolean {
		return this._thinkingToggle.checked;
	}

	isAutoApproveEnabled(): boolean {
		return this._autoApproveToggle.checked;
	}

	setThinkingEnabled(value: boolean): void {
		this._thinkingToggle.checked = value;
	}

	setAutoApproveEnabled(value: boolean): void {
		this._autoApproveToggle.checked = value;
	}

	addAttachment(widget: IDisposable & { element: HTMLElement }): void {
		this._attachmentSlot.appendChild(widget.element);
		this._register(widget);
	}

	addMention(mention: IMentionItem): void {
		this._mentions.push(mention);
		const tag = $('span.chipos-chat-mention-tag');
		tag.textContent = `@${mention.displayName}`;

		const removeBtn = $('span.chipos-chat-mention-remove');
		removeBtn.textContent = '×';
		this._register(dom.addDisposableListener(removeBtn, 'click', () => {
			const idx = this._mentions.indexOf(mention);
			if (idx >= 0) {
				this._mentions.splice(idx, 1);
			}
			tag.remove();
		}));
		tag.appendChild(removeBtn);

		this._attachmentSlot.appendChild(tag);
	}

	layout(_width: number): void {
		// Textarea auto-resize is handled by _autoResize
	}

	// ── Private ────────────────────────────────────────────────────────────

	private _registerListeners(): void {
		this._register(dom.addDisposableListener(this._textarea, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this._submit();
			}
		}));

		this._register(dom.addDisposableListener(this._textarea, 'input', () => {
			this._autoResize();
		}));

		this._register(dom.addDisposableListener(this._textarea, 'focus', () => {
			this._inputFocusedKey.set(true);
		}));

		this._register(dom.addDisposableListener(this._textarea, 'blur', () => {
			this._inputFocusedKey.set(false);
		}));

		this._register(dom.addDisposableListener(this._sendButton, 'click', () => {
			this._submit();
		}));

		this._register(dom.addDisposableListener(this._stopButton, 'click', () => {
			this._onDidRequestStop.fire();
		}));
	}

	private _submit(): void {
		const text = this._textarea.value.trim();
		if (!text || this._isAgentRunning) {
			return;
		}
		this._onDidSubmit.fire({ text, mentions: [...this._mentions] });
	}

	private _autoResize(): void {
		this._textarea.style.height = 'auto';
		const maxHeight = 200;
		this._textarea.style.height = `${Math.min(this._textarea.scrollHeight, maxHeight)}px`;
	}

	private _clearAttachmentSlot(): void {
		dom.clearNode(this._attachmentSlot);
	}
}
