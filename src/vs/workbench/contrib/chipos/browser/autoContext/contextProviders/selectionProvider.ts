/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

export class SelectionProvider implements IContextProvider {

	readonly source = ContextSourceType.Selection;

	constructor(
		private readonly _editorService: IEditorService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const editor = this._editorService.activeTextEditorControl;
			const selection = editor?.getSelection?.();
			if (!selection || selection.isEmpty()) {
				return [];
			}

			const model = editor!.getModel?.() as ITextModel | undefined;
			if (!model) {
				return [];
			}

			const text = model.getValueInRange(selection);
			if (!text) {
				return [];
			}

			const uri = model.uri;
			const content = `Selection in ${uri.fsPath} [L${selection.startLineNumber}-L${selection.endLineNumber}]:\n\n${text}`;
			return [{
				source: ContextSourceType.Selection,
				content,
				priority: 1,
				tokenEstimate: Math.ceil(content.length / 4),
				metadata: {
					path: uri.fsPath,
					startLine: selection.startLineNumber,
					endLine: selection.endLineNumber,
				},
			}];
		} catch {
			return [];
		}
	}
}
