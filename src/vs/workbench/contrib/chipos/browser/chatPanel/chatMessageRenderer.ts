/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import * as dom from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import type { IToolCallPayload, IToolResultPayload, IMentionItem } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const $ = dom.$;

// ── StreamingMessageHandle ──────────────────────────────────────────────────

export interface IStreamingMessageHandle {
	readonly messageId: string;
	readonly element: HTMLElement;
	readonly contentElement: HTMLElement;
	isStreaming: boolean;
	rawText: string;
}

// ── Code block state machine ────────────────────────────────────────────────

const enum CodeBlockState {
	Normal = 0,
	InCodeBlock = 1,
}

function computeCodeBlockState(text: string): CodeBlockState {
	let open = 0;
	let idx = 0;
	while (idx < text.length) {
		const tick = text.indexOf('```', idx);
		if (tick === -1) {
			break;
		}
		open++;
		idx = tick + 3;
	}
	return open % 2 === 1 ? CodeBlockState.InCodeBlock : CodeBlockState.Normal;
}

function closeOpenCodeBlock(text: string): string {
	if (computeCodeBlockState(text) === CodeBlockState.InCodeBlock) {
		return text + '\n```';
	}
	return text;
}

// ── ChatMessageRenderer ─────────────────────────────────────────────────────

export class ChatMessageRenderer extends Disposable {

	private readonly _messageList: HTMLElement;
	private readonly _scrollable: DomScrollableElement;
	private readonly _scrollToBottomButton: HTMLElement;
	private readonly _mdRenderer: IMarkdownRendererService;

	private _autoScrollEnabled = true;
	private _handlesByMessageId = new Map<string, IStreamingMessageHandle>();
	private _toolCallElements = new Map<string, HTMLElement>();

	private readonly _onDidClickScrollToBottom = this._register(new Emitter<void>());
	readonly onDidClickScrollToBottom: Event<void> = this._onDidClickScrollToBottom.event;

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IOpenerService _openerService: IOpenerService,
		@IMarkdownRendererService mdRendererService: IMarkdownRendererService,
	) {
		super();

		this._mdRenderer = mdRendererService;

		this._messageList = $('.chipos-chat-message-list');

		this._scrollable = this._register(new DomScrollableElement(this._messageList, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
		}));
		this._container.appendChild(this._scrollable.getDomNode());
		this._scrollable.getDomNode().classList.add('chipos-chat-scroll-container');

		// Scroll-to-bottom button
		this._scrollToBottomButton = $('.chipos-chat-scroll-to-bottom');
		this._scrollToBottomButton.textContent = '↓';
		this._scrollToBottomButton.title = 'Scroll to bottom';
		this._scrollToBottomButton.style.display = 'none';
		this._container.appendChild(this._scrollToBottomButton);

		this._register(dom.addDisposableListener(this._scrollToBottomButton, 'click', () => {
			this._autoScrollEnabled = true;
			this._scrollToBottom();
			this._scrollToBottomButton.style.display = 'none';
		}));

		this._register(dom.addDisposableListener(this._scrollable.getDomNode(), 'scroll', () => {
			this._handleScrollEvent();
		}));

		this._register(dom.addDisposableListener(this._messageList, 'wheel', () => {
			const node = this._scrollable.getDomNode();
			const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
			if (!atBottom) {
				this._autoScrollEnabled = false;
				this._scrollToBottomButton.style.display = '';
			}
		}));

		this._renderWelcome();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	renderUserMessage(text: string, mentions?: IMentionItem[]): HTMLElement {
		const wrapper = $('.chipos-chat-message.chipos-chat-message-user');

		const avatar = $('.chipos-chat-avatar.chipos-chat-avatar-user');
		avatar.textContent = 'U';
		wrapper.appendChild(avatar);

		const bubble = $('.chipos-chat-bubble.chipos-chat-bubble-user');

		if (mentions && mentions.length > 0) {
			const mentionLine = $('.chipos-chat-mentions');
			for (const m of mentions) {
				const tag = $('span.chipos-chat-mention-tag');
				tag.textContent = `@${m.displayName}`;
				mentionLine.appendChild(tag);
			}
			bubble.appendChild(mentionLine);
		}

		const content = $('.chipos-chat-content');
		content.textContent = text;
		bubble.appendChild(content);

		wrapper.appendChild(bubble);
		this._messageList.appendChild(wrapper);
		this._afterAppend();
		return wrapper;
	}

	beginAssistantMessage(): IStreamingMessageHandle {
		const messageId = generateUuid();
		const wrapper = $('.chipos-chat-message.chipos-chat-message-assistant');

		const avatar = $('.chipos-chat-avatar.chipos-chat-avatar-assistant');
		avatar.textContent = 'AI';
		wrapper.appendChild(avatar);

		const bubble = $('.chipos-chat-bubble.chipos-chat-bubble-assistant');
		const contentEl = $('.chipos-chat-content.chipos-chat-streaming');
		bubble.appendChild(contentEl);
		wrapper.appendChild(bubble);

		this._messageList.appendChild(wrapper);

		const handle: IStreamingMessageHandle = {
			messageId,
			element: wrapper,
			contentElement: contentEl,
			isStreaming: true,
			rawText: '',
		};

		this._handlesByMessageId.set(messageId, handle);
		this._afterAppend();
		return handle;
	}

	appendToken(handle: IStreamingMessageHandle, token: string): void {
		if (!handle.isStreaming) {
			return;
		}

		handle.rawText += token;
		this._renderMarkdownContent(handle);
		this._afterAppend();
	}

	finishAssistantMessage(handle: IStreamingMessageHandle): void {
		handle.isStreaming = false;
		handle.contentElement.classList.remove('chipos-chat-streaming');

		// Final re-render without streaming adjustments
		this._renderMarkdownContent(handle);
		this._addCopyButtonsToCodeBlocks(handle.contentElement);
		this._afterAppend();
	}

	renderToolCall(payload: IToolCallPayload): HTMLElement {
		const wrapper = $('.chipos-chat-tool-trace');

		const header = $('.chipos-chat-tool-header');
		const expandIcon = $('span.chipos-chat-tool-expand-icon');
		expandIcon.textContent = '▶';
		header.appendChild(expandIcon);

		const toolName = $('span.chipos-chat-tool-name');
		toolName.textContent = payload.tool_name;
		header.appendChild(toolName);

		const statusBadge = $('span.chipos-chat-tool-status');
		statusBadge.textContent = '⏳ running';
		statusBadge.classList.add('chipos-chat-tool-status-running');
		header.appendChild(statusBadge);

		wrapper.appendChild(header);

		const body = $('.chipos-chat-tool-body');
		body.style.display = 'none';

		const argsBlock = $('pre.chipos-chat-tool-args');
		try {
			argsBlock.textContent = JSON.stringify(payload.arguments, null, 2);
		} catch {
			argsBlock.textContent = String(payload.arguments);
		}
		body.appendChild(argsBlock);

		const resultContainer = $('.chipos-chat-tool-result');
		body.appendChild(resultContainer);

		wrapper.appendChild(body);

		// Toggle expand/collapse
		this._register(dom.addDisposableListener(header, 'click', () => {
			const isCollapsed = body.style.display === 'none';
			body.style.display = isCollapsed ? '' : 'none';
			expandIcon.textContent = isCollapsed ? '▼' : '▶';
		}));

		this._toolCallElements.set(payload.call_id, wrapper);
		this._messageList.appendChild(wrapper);
		this._afterAppend();
		return wrapper;
	}

	renderToolResult(payload: IToolResultPayload): void {
		const wrapper = this._toolCallElements.get(payload.call_id);
		if (!wrapper) {
			return;
		}

		const statusBadge = wrapper.querySelector('.chipos-chat-tool-status');
		if (statusBadge) {
			statusBadge.textContent = payload.success ? '✓ done' : '✗ failed';
			statusBadge.classList.remove('chipos-chat-tool-status-running');
			statusBadge.classList.add(payload.success ? 'chipos-chat-tool-status-done' : 'chipos-chat-tool-status-failed');
		}

		const resultContainer = wrapper.querySelector('.chipos-chat-tool-result');
		if (resultContainer) {
			const pre = $('pre.chipos-chat-tool-result-content');
			const text = typeof payload.result === 'string'
				? payload.result
				: JSON.stringify(payload.result, null, 2);
			pre.textContent = text.length > 2000 ? text.slice(0, 2000) + '\n…(truncated)' : text;
			resultContainer.appendChild(pre);
		}

		this._afterAppend();
	}

	renderSystemMessage(text: string, level: 'info' | 'warning' | 'error'): HTMLElement {
		const wrapper = $(`.chipos-chat-message.chipos-chat-message-system.chipos-chat-system-${level}`);
		const icon = $('span.chipos-chat-system-icon');
		icon.textContent = level === 'error' ? '✗' : level === 'warning' ? '⚠' : 'ℹ';
		wrapper.appendChild(icon);

		const content = $('span.chipos-chat-system-text');
		content.textContent = text;
		wrapper.appendChild(content);

		this._messageList.appendChild(wrapper);
		this._afterAppend();
		return wrapper;
	}

	clear(): void {
		dom.clearNode(this._messageList);
		this._handlesByMessageId.clear();
		this._toolCallElements.clear();
		this._autoScrollEnabled = true;
		this._scrollToBottomButton.style.display = 'none';
		this._renderWelcome();
	}

	layout(): void {
		this._scrollable.scanDomNode();
	}

	// ── Private rendering helpers ──────────────────────────────────────────

	private _renderWelcome(): void {
		const welcome = $('.chipos-chat-welcome');
		const title = $('h2');
		title.textContent = 'ChipOS AI Assistant';
		welcome.appendChild(title);
		const subtitle = $('p');
		subtitle.textContent = 'Ask me about your Verilog/SystemVerilog design, run simulations, or get help with EDA workflows.';
		welcome.appendChild(subtitle);
		this._messageList.appendChild(welcome);
	}

	private _renderMarkdownContent(handle: IStreamingMessageHandle): void {
		const disposables = new DisposableStore();
		const textForRender = handle.isStreaming
			? closeOpenCodeBlock(handle.rawText)
			: handle.rawText;

		const md = new MarkdownString(textForRender, { supportThemeIcons: true });
		md.isTrusted = { enabledCommands: [] };
		md.supportHtml = false;

		const result = disposables.add(this._mdRenderer.render(md));

		dom.clearNode(handle.contentElement);
		handle.contentElement.appendChild(result.element);

		if (handle.isStreaming) {
			const cursor = $('span.chipos-chat-streaming-cursor');
			handle.contentElement.appendChild(cursor);
		}

		// Dispose previous render resources on next render
		const existing = this._handlesByMessageId.get(handle.messageId);
		if (existing) {
			// The disposable store is lightweight; previous render results are
			// cleaned up when we clear the content element on the next render.
		}
	}

	private _addCopyButtonsToCodeBlocks(container: HTMLElement): void {
		const codeBlocks = container.querySelectorAll('pre > code');
		codeBlocks.forEach(codeEl => {
			const pre = codeEl.parentElement;
			if (!pre || pre.querySelector('.chipos-chat-code-copy')) {
				return;
			}

			const copyBtn = $('button.chipos-chat-code-copy');
			copyBtn.textContent = 'Copy';
			copyBtn.title = 'Copy code';

			this._register(dom.addDisposableListener(copyBtn, 'click', () => {
				const text = codeEl.textContent ?? '';
				navigator.clipboard.writeText(text).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
				});
			}));

			pre.style.position = 'relative';
			pre.appendChild(copyBtn);
		});
	}

	private _afterAppend(): void {
		this._scrollable.scanDomNode();
		if (this._autoScrollEnabled) {
			this._scrollToBottom();
		}
	}

	private _scrollToBottom(): void {
		const node = this._scrollable.getDomNode();
		this._scrollable.setScrollPosition({ scrollTop: node.scrollHeight });
	}

	private _handleScrollEvent(): void {
		const node = this._scrollable.getDomNode();
		const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
		if (atBottom) {
			this._autoScrollEnabled = true;
			this._scrollToBottomButton.style.display = 'none';
		}
	}
}
