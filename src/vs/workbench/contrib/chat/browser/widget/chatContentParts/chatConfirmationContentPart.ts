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

		// ── DOM ──
		const elements = dom.h('.chat-confirmation-widget2@root', [
			dom.h('.chat-confirmation-widget-title@title'),
			dom.h('.chat-confirmation-widget-message@messageArea'),
			dom.h('.chat-confirmation-widget-buttons@buttonsArea', [
				dom.h('.chat-buttons@buttons'),
			]),
		]);

		this.domNode = elements.root;

		const widget = isResponseVM(element) ? chatWidgetService.getWidgetBySessionResource(element.sessionResource) : undefined;
		const revealConfirmationActions = () => {
			if (confirmation.isUsed) {
				return;
			}
			// Scroll the chat list so the buttons row is visible at the bottom of the viewport.
			const buttonsRect = elements.buttonsArea.getBoundingClientRect();
			const listNode = (widget as any)?.listWidget?.domNode as HTMLElement | undefined;
			const listRect = listNode?.getBoundingClientRect();
			console.log('[ConfirmReveal] buttonsRect:', JSON.stringify({ top: buttonsRect.top, bottom: buttonsRect.bottom, height: buttonsRect.height }));
			console.log('[ConfirmReveal] listRect:', listRect ? JSON.stringify({ top: listRect.top, bottom: listRect.bottom, height: listRect.height }) : 'N/A');
			console.log('[ConfirmReveal] buttonsArea offsetParent:', elements.buttonsArea.offsetParent?.className);
			console.log('[ConfirmReveal] buttonsArea offsetTop:', elements.buttonsArea.offsetTop, 'offsetHeight:', elements.buttonsArea.offsetHeight);
			widget?.revealElement(elements.buttonsArea);
		};

		// ── Title ──
		const titleMd = new MarkdownString(
			`$(${Codicon.warning.id}) ${confirmation.title}`,
			{ supportThemeIcons: true },
		);
		const renderedTitle = this._register(markdownRendererService.render(titleMd));
		elements.title.appendChild(renderedTitle.element);

		// ── Message: "View full content in editor" link ──
		const messageContent = typeof confirmation.message === 'string'
			? confirmation.message
			: (confirmation.message as IMarkdownString).value;

		const link = document.createElement('a');
		link.textContent = localize('viewFullContent', "📄 View full content in editor");
		link.style.cursor = 'pointer';
		link.style.color = 'var(--vscode-textLink-foreground)';
		link.style.textDecoration = 'underline';
		link.style.display = 'inline-block';
		link.style.padding = '2px 0';
		link.style.fontSize = '12px';

		this._register(dom.addDisposableListener(link, 'click', async () => {
			if (!this._tempFileUri) {
				this._tempFileUri = await this._writeTempFile(confirmation.title, messageContent);
			}
			if (this._tempFileUri) {
				await this.editorService.openEditor({ resource: this._tempFileUri });
				// After editor opens, chat panel may resize — reveal the current confirmation again.
				setTimeout(() => {
					revealConfirmationActions();
				}, 300);
			}
		}));
		elements.messageArea.appendChild(link);

		// ── Buttons ──
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
				elements.buttonsArea.style.display = 'none';
			}
		};

		for (let i = 0; i < buttonLabels.length; i++) {
			const label = buttonLabels[i];
			const isSecondary = i > 0;
			const button = this._register(new Button(elements.buttons, {
				...defaultButtonStyles, small: true, secondary: isSecondary,
			}));
			button.label = label;
			this._register(button.onDidClick(() => sendConfirmation(label, isSecondary)));
		}

		if (confirmation.isUsed) {
			elements.buttonsArea.style.display = 'none';
		}

		// After the card is attached to the DOM, reveal the current response and
		// then align the action row to the bottom of the viewport so the buttons stay visible.
		if (!confirmation.isUsed) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					revealConfirmationActions();
				});
			});

			setTimeout(() => {
				revealConfirmationActions();
			}, 180);
		}
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
