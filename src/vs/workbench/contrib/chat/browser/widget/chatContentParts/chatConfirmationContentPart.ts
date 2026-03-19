/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IMarkdownString, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { localize } from '../../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IChatProgressRenderableResponseContent } from '../../../common/model/chatModel.js';
import { ChatSendResult, IChatConfirmation, IChatSendRequestOptions, IChatService } from '../../../common/chatService/chatService.js';
import { IChatResponseViewModel, isResponseVM } from '../../../common/model/chatViewModel.js';
import { IChatWidget, IChatWidgetService } from '../../chat.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import './media/chatConfirmationWidget.css';

export class ChatConfirmationContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;
	private _tempFileUri: URI | undefined;
	private _overlay: HTMLElement | undefined;

	constructor(
		confirmation: IChatConfirmation,
		context: IChatContentPartRenderContext,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IMarkdownRendererService markdownRendererService: IMarkdownRendererService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const element = context.element;
		const widget = isResponseVM(element) ? chatWidgetService.getWidgetBySessionResource(element.sessionResource) : undefined;

		// ── Card DOM (title + preview, no buttons) ──
		const elements = dom.h('.chat-confirmation-widget2@root', [
			dom.h('.chat-confirmation-widget-title@title'),
			dom.h('.chat-confirmation-widget-preview@preview'),
		]);

		this.domNode = elements.root;

		// ── Title ──
		const titleMd = new MarkdownString(
			`$(${Codicon.warning.id}) ${confirmation.title}`,
			{ supportThemeIcons: true },
		);
		const renderedTitle = this._register(markdownRendererService.render(titleMd));
		elements.title.appendChild(renderedTitle.element);

		// ── Preview ──
		const messageContent = typeof confirmation.message === 'string'
			? confirmation.message
			: (confirmation.message as IMarkdownString).value;

		const previewText = this._getPreview(messageContent, 3);
		const previewMd = new MarkdownString(previewText, { supportThemeIcons: true });
		const renderedPreview = this._register(markdownRendererService.render(previewMd));
		elements.preview.appendChild(renderedPreview.element);

		// Click card to open full content
		elements.root.style.cursor = 'pointer';
		this._register(dom.addDisposableListener(elements.root, 'click', async () => {
			if (!this._tempFileUri) {
				this._tempFileUri = await this._writeTempFile(confirmation.title, messageContent);
			}
			if (this._tempFileUri) {
				await this.editorService.openEditor({ resource: this._tempFileUri });
			}
		}));

		// ── Floating buttons ──
		if (!confirmation.isUsed) {
			// Find the list container to attach the floating overlay
			let target = widget?.domNode?.querySelector<HTMLElement>('.interactive-list');
			if (!target) {
				// Fallback: search from document root
				target = document.querySelector<HTMLElement>('.interactive-list');
			}
			// console.log('[ConfirmCard] widget:', !!widget, 'target:', !!target, 'isUsed:', confirmation.isUsed);

			if (target) {
				this._createFloatingButtons(target, confirmation, element, widget);
			}
		}
	}

	private _createFloatingButtons(
		container: HTMLElement,
		confirmation: IChatConfirmation,
		element: IChatResponseViewModel | any,
		widget: IChatWidget | undefined,
	): void {
		// Ensure container is positioned
		const pos = getComputedStyle(container).position;
		if (pos === 'static') {
			container.style.position = 'relative';
		}

		const overlay = document.createElement('div');
		overlay.className = 'chat-confirmation-floating-buttons';
		this._overlay = overlay;

		const buttonLabels = confirmation.buttons ?? [localize('accept', "Accept"), localize('dismiss', "Dismiss")];

		// ── Options row: radio-style selectable chips ──
		const optionsRow = document.createElement('div');
		optionsRow.className = 'chat-confirm-options';
		overlay.appendChild(optionsRow);

		let selectedIndex = 0; // default: first option
		const chips: HTMLElement[] = [];

		const updateSelection = (idx: number) => {
			selectedIndex = idx;
			chips.forEach((chip, i) => {
				chip.classList.toggle('selected', i === idx);
			});
		};

		for (let i = 0; i < buttonLabels.length; i++) {
			const chip = document.createElement('div');
			chip.className = 'chat-confirm-chip';
			// Letter label (A, B, C, ...)
			const letterSpan = document.createElement('span');
			letterSpan.className = 'chat-confirm-chip-letter';
			letterSpan.textContent = String.fromCharCode(65 + i); // A, B, C...
			chip.appendChild(letterSpan);
			// Label text
			const labelSpan = document.createElement('span');
			labelSpan.textContent = buttonLabels[i];
			chip.appendChild(labelSpan);
			if (i === 0) {
				chip.classList.add('selected');
			}
			chip.addEventListener('click', () => updateSelection(i));
			optionsRow.appendChild(chip);
			chips.push(chip);
		}

		// ── Action row: Skip (Esc) + Continue (→) ──
		const actionsRow = document.createElement('div');
		actionsRow.className = 'chat-confirm-actions';
		overlay.appendChild(actionsRow);

		const sendConfirmation = async (label: string, isSecondary: boolean) => {
			if (!isResponseVM(element)) {
				return;
			}
			const prompt = `${label}: "${confirmation.title}"`;
			const options: IChatSendRequestOptions = isSecondary
				? { rejectedConfirmationData: [confirmation.data] }
				: { acceptedConfirmationData: [confirmation.data] };
			options.agentId = element.agent?.id;
			options.slashCommand = element.slashCommand?.name;
			options.confirmation = label;
			options.userSelectedModelId = widget?.input.currentLanguageModel;
			options.modeInfo = widget?.input.currentModeInfo;
			options.location = widget?.location;
			Object.assign(options, widget?.getModeRequestOptions());

			const result = await this.chatService.sendRequest(element.sessionResource, prompt, options);
			if (ChatSendResult.isSent(result)) {
				confirmation.isUsed = true;
				overlay.remove();
				this._overlay = undefined;
			}
		};

		// Skip — plain text link style (like Cursor)
		const skipEl = document.createElement('span');
		skipEl.className = 'chat-confirm-skip';
		skipEl.textContent = 'Skip';
		const escHint = document.createElement('span');
		escHint.className = 'chat-confirm-keyhint';
		escHint.textContent = 'Esc';
		skipEl.appendChild(escHint);
		skipEl.addEventListener('click', () => {
			const dismissLabel = buttonLabels.length > 1 ? buttonLabels[buttonLabels.length - 1] : 'Dismiss';
			sendConfirmation(dismissLabel, true);
		});
		actionsRow.appendChild(skipEl);

		// Continue button — primary style with arrow hint
		const continueBtn = this._register(new Button(actionsRow, {
			...defaultButtonStyles, small: true, secondary: true,
		}));
		continueBtn.label = 'Continue';
		const arrowHint = document.createElement('span');
		arrowHint.className = 'chat-confirm-keyhint';
		arrowHint.textContent = '→';
		(continueBtn.element as HTMLElement).appendChild(arrowHint);
		this._register(continueBtn.onDidClick(() => {
			const selectedLabel = buttonLabels[selectedIndex];
			sendConfirmation(selectedLabel, selectedIndex > 0);
		}));

		// Keyboard shortcuts
		const keyHandler = (e: KeyboardEvent) => {
			if (confirmation.isUsed) {
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				const dismissLabel = buttonLabels.length > 1 ? buttonLabels[buttonLabels.length - 1] : 'Dismiss';
				sendConfirmation(dismissLabel, true);
			} else if (e.key === 'Enter' || e.key === 'ArrowRight') {
				e.preventDefault();
				const selectedLabel = buttonLabels[selectedIndex];
				sendConfirmation(selectedLabel, selectedIndex > 0);
			} else if (e.key >= 'a' && e.key <= 'z') {
				// Letter key selects option (a=0, b=1, ...)
				const idx = e.key.charCodeAt(0) - 97;
				if (idx >= 0 && idx < buttonLabels.length) {
					updateSelection(idx);
				}
			}
		};
		document.addEventListener('keydown', keyHandler);
		this._register({ dispose: () => document.removeEventListener('keydown', keyHandler) });

		container.appendChild(overlay);
	}

	private _getPreview(content: string, maxLines: number): string {
		const lines = content.split('\n')
			.filter(l => l.trim().length > 0)
			.filter(l => !l.startsWith('#'));
		const preview = lines.slice(0, maxLines).join('\n');
		if (lines.length > maxLines) {
			return preview + '\n\n*Click to view full content...*';
		}
		return preview || '*Click to view full content...*';
	}

	private async _writeTempFile(title: string, content: string): Promise<URI | undefined> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		const root = folders[0].uri;
		const safeName = title.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 60);
		const fileName = `${safeName}_${Date.now()}.md`;
		const fileUri = URI.joinPath(root, '.coderust', 'tmp', fileName);
		try {
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(`# ${title}\n\n${content}`));
			return fileUri;
		} catch {
			return undefined;
		}
	}

	hasSameContent(other: IChatProgressRenderableResponseContent): boolean {
		return other.kind === 'confirmation';
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}

	override dispose(): void {
		this._overlay?.remove();
		if (this._tempFileUri) {
			this.fileService.del(this._tempFileUri).catch(() => { /* ignore */ });
		}
		super.dispose();
	}
}
