/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const MAX_CONTENT_LENGTH = 10_000;

export class ActiveFileProvider implements IContextProvider {

	readonly source = ContextSourceType.ActiveFile;

	constructor(
		private readonly _editorService: IEditorService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const editor = this._editorService.activeTextEditorControl;
			const model = editor?.getModel?.() as ITextModel | undefined;
			if (!model) {
				return [];
			}

			const uri = model.uri;
			let content = model.getValue();
			if (content.length > MAX_CONTENT_LENGTH) {
				content = content.slice(0, MAX_CONTENT_LENGTH) + '\n... [truncated]';
			}

			const fullContent = `File: ${uri.fsPath}\n\n${content}`;
			return [{
				source: ContextSourceType.ActiveFile,
				content: fullContent,
				priority: 2,
				tokenEstimate: Math.ceil(fullContent.length / 4),
				metadata: { path: uri.fsPath },
			}];
		} catch {
			return [];
		}
	}
}
