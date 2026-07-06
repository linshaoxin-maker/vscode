/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { localize } from '../../../../../../../nls.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IChatEdaSpecReview, IChatEdaSpecReviewAction } from '../../../../common/chatService/chatService.js';
import { IChatSendRequestOptions, IChatService } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent, isResponseVM } from '../../../../common/model/chatViewModel.js';
import { IChatWidgetService } from '../../../chat.js';
import { IChatContentPart, IChatContentPartRenderContext } from '../chatContentParts.js';
import { edaSection } from './edaContentPartUtils.js';
import '../media/edaParts.css';

const $ = dom.$;

/**
 * Default action set when the payload carries none — parity with vscode-extension
 * specCard.js:86-88. `view` opens the spec; `regenerate` redoes the design;
 * `build` drives the next agent round on the approved spec (spec→build loop).
 */
const DEFAULT_SPEC_ACTIONS: ReadonlyArray<IChatEdaSpecReviewAction> = [
	{ id: 'view', label: localize('chipos.specReview.view', "查看方案") },
	{ id: 'regenerate', label: localize('chipos.specReview.regenerate', "重新生成") },
	{ id: 'build', label: localize('chipos.specReview.build', "Build") },
];

export class ChatEdaSpecReviewContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly content: IChatEdaSpecReview,
		private readonly context: IChatContentPartRenderContext | undefined,
		@IChatService private readonly chatService: IChatService,
		@ICommandService private readonly commandService: ICommandService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();

		const summaryEl = $('div.eda-spec-summary');
		summaryEl.textContent = content.summary;

		const children: HTMLElement[] = [summaryEl];

		if (content.files && content.files.length > 0) {
			const filesEl = $('div.eda-spec-files');
			const filesTitle = $('strong');
			filesTitle.textContent = 'Files: ';
			filesEl.appendChild(filesTitle);
			for (const f of content.files) {
				const fileTag = $('code.eda-spec-file');
				fileTag.textContent = f;
				filesEl.appendChild(fileTag);
			}
			children.push(filesEl);
		}

		const pathEl = $('div.eda-spec-path');
		pathEl.textContent = `Spec: ${content.spec_path}`;
		children.push(pathEl);

		// P1-1 (IDE-MIGRATION-GAPS §1.1): action buttons. Previously the card was
		// read-only (button count = 0), so the AI4RTL spec→build closed loop had no
		// one-click driver. Render View Plan / Regenerate / Build wired to
		// IChatService / ICommandService.
		children.push(this._buildActions());

		this.domNode = edaSection(`Spec Review: ${content.spec_name}`, ...children);
		this.domNode.classList.add('eda-spec-review');
	}

	private _buildActions(): HTMLElement {
		const row = $('div.eda-spec-actions');
		const actions = this.content.actions && this.content.actions.length > 0
			? this.content.actions
			: DEFAULT_SPEC_ACTIONS;

		const buttons: HTMLButtonElement[] = [];
		let inFlight = false;
		const lockAll = (clicked: HTMLButtonElement) => {
			inFlight = true;
			for (const b of buttons) {
				b.disabled = true;
			}
			clicked.classList.add('eda-spec-btn-used');
		};

		for (const action of actions) {
			const btn = document.createElement('button');
			btn.className = action.id === 'build' ? 'eda-spec-btn eda-spec-btn-primary' : 'eda-spec-btn';
			btn.textContent = action.label;
			btn.setAttribute('type', 'button');
			this._register(dom.addDisposableListener(btn, 'click', () => {
				if (inFlight) {
					return;
				}
				// `view` opens the spec without consuming the card — no lock.
				if (action.id === 'view') {
					void this._openSpec();
					return;
				}
				lockAll(btn);
				void this._runAction(action.id);
			}));
			row.appendChild(btn);
			buttons.push(btn);
		}
		return row;
	}

	private async _openSpec(): Promise<void> {
		if (!this.content.spec_path) {
			return;
		}
		try {
			await this.commandService.executeCommand('vscode.open', URI.file(this.content.spec_path));
		} catch {
			// best-effort — keep the card intact if the file can't be opened
		}
	}

	private async _runAction(id: 'regenerate' | 'build'): Promise<void> {
		const element = this.context?.element;
		const sessionResource = element?.sessionResource;
		if (!sessionResource) {
			// No render context (e.g. restored history without a live session) — the
			// best we can do is reveal the spec so the user can act on it manually.
			void this._openSpec();
			return;
		}
		const specPath = this.content.spec_path || this.content.spec_name;
		const prompt = id === 'build'
			? localize('chipos.specReview.buildPrompt', "请按照 {0} 中已批准的设计方案执行。先 read_file 读取方案，然后按步骤执行。", specPath)
			: localize('chipos.specReview.regeneratePrompt', "请重新生成 {0} 的设计方案。参考之前的方案进行改进。", specPath);

		const widget = this.chatWidgetService.getWidgetBySessionResource(sessionResource);
		const opts: IChatSendRequestOptions = {
			agentId: isResponseVM(element) ? element.agent?.id : undefined,
			userSelectedModelId: widget?.input.currentLanguageModel,
			modeInfo: widget?.input.currentModeInfo,
			location: widget?.location,
			...(widget?.getModeRequestOptions?.() ?? {}),
		};
		try {
			await this.chatService.sendRequest(sessionResource, prompt, opts);
		} catch {
			// sendRequest can reject when the session is busy; the buttons are
			// already disabled, so surface nothing further — the user can retry from
			// a fresh card or the input box.
		}
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaSpecReview') {
			return false;
		}
		const o = other as IChatEdaSpecReview;
		return o.spec_path === this.content.spec_path;
	}
}
