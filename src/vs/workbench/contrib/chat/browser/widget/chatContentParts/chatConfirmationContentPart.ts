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
import { isResponseVM } from '../../../common/model/chatViewModel.js';
import { IChatWidgetService } from '../../chat.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';

export class ChatConfirmationContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;
	private _tempFileUri: URI | undefined;

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

		// ── Card DOM (title + preview only, no buttons inside) ──
		const elements = dom.h('.chat-confirmation-widget2@root', [
			dom.h('.chat-confirmation-widget-title@title'),
			dom.h('.chat-confirmation-widget-preview@preview'),
		]);

		this.domNode = elements.root;

		// ── Title: ⚠ confirmation.title ──
		const titleMd = new MarkdownString(
			`$(${Codicon.warning.id}) ${confirmation.title}`,
			{ supportThemeIcons: true },
		);
		const renderedTitle = this._register(markdownRendererService.render(titleMd));
		elements.title.appendChild(renderedTitle.element);

		// ── Preview: 2-3 line summary ──
		const messageContent = typeof confirmation.message === 'string'
			? confirmation.message
			: (confirmation.message as IMarkdownString).value;

		const previewText = this._getPreview(messageContent, 3);
		const previewMd = new MarkdownString(previewText, { supportThemeIcons: true });
		const renderedPreview = this._register(markdownRendererService.render(previewMd));
		elements.preview.appendChild(renderedPreview.element);

		// Click card to open full content in editor
		elements.root.style.cursor = 'pointer';
		this._register(dom.addDisposableListener(elements.root, 'click', async () => {
			if (!this._tempFileUri) {
				this._tempFileUri = await this._writeTempFile(confirmation.title, messageContent);
			}
			if (this._tempFileUri) {
				await this.editorService.openEditor({ resource: this._tempFileUri });
			}
		}));

		// ── Floating buttons overlay ──
		// Buttons are appended to the chat list area (not inside the card),
		// positioned at the bottom so they are always visible regardless of scroll.
		const chatDomNode = widget?.domNode;
		const listContainer = chatDomNode?.querySelector<HTMLElement>('.interactive-list');
		if (listContainer && !confirmation.isUsed) {
			// Ensure the list container is positioned for absolute children
			const pos = getComputedStyle(listContainer).position;
			if (pos === 'static') {
				listContainer.style.position = 'relative';
			}

			const overlay = document.createElement('div');
			overlay.className = 'chat-confirmation-floating-buttons';

			const buttonsRow = document.createElement('div');
			buttonsRow.className = 'chat-buttons';
			overlay.appendChild(buttonsRow);

			const buttonLabels = confirmation.buttons ?? [localize('accept', "Accept"), localize('dismiss', "Dismiss")];
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
				}
			};

			for (let i = 0; i < buttonLabels.length; i++) {
				const label = buttonLabels[i];
				const isSecondary = i > 0;
				const button = this._register(new Button(buttonsRow, {
					...defaultButtonStyles, small: true, secondary: isSecondary,
				}));
				button.label = label;
				this._register(button.onDidClick(() => sendConfirmation(label, isSecondary)));
			}

			listContainer.appendChild(overlay);

			// Clean up overlay on dispose
			this._register({
				dispose: () => overlay.remove(),
			});
		}
	}

	/**
	 * Extract first N non-heading lines as preview text.
	 */
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
		if (this._tempFileUri) {
			this.fileService.del(this._tempFileUri).catch(() => { /* ignore */ });
		}
		super.dispose();
	}
}
