/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const MAX_EDITS = 5;
const MAX_EDIT_TEXT_LENGTH = 500;

interface IEditSummary {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly timestamp: number;
}

export class RecentEditProvider extends Disposable implements IContextProvider {

	readonly source = ContextSourceType.RecentEdit;

	private readonly _edits: IEditSummary[] = [];
	private readonly _trackedModels = new Set<string>();

	constructor(
		private readonly _editorService: IEditorService,
	) {
		super();
		this._trackActiveEditor();

		this._register(this._editorService.onDidActiveEditorChange(() => {
			this._trackActiveEditor();
		}));
	}

	async collect(): Promise<IContextItem[]> {
		if (this._edits.length === 0) {
			return [];
		}

		const recent = this._edits.slice(-MAX_EDITS);
		const lines = recent.map(e =>
			`[${e.path} L${e.startLine}-L${e.endLine}]: ${e.text}`
		);
		const content = `Recent edits:\n${lines.join('\n')}`;

		return [{
			source: ContextSourceType.RecentEdit,
			content,
			priority: 5,
			tokenEstimate: Math.ceil(content.length / 4),
			metadata: { editCount: recent.length },
		}];
	}

	private _trackActiveEditor(): void {
		const editor = this._editorService.activeTextEditorControl;
		const model = editor?.getModel?.() as ITextModel | undefined;
		if (!model) {
			return;
		}

		const key = model.uri.toString();
		if (this._trackedModels.has(key)) {
			return;
		}
		this._trackedModels.add(key);

		this._register(model.onDidChangeContent((e) => {
			for (const change of e.changes) {
				let text = change.text;
				if (text.length > MAX_EDIT_TEXT_LENGTH) {
					text = text.slice(0, MAX_EDIT_TEXT_LENGTH) + '...';
				}

				this._edits.push({
					path: model.uri.fsPath,
					startLine: change.range.startLineNumber,
					endLine: change.range.endLineNumber,
					text: text.replace(/\n/g, '↵'),
					timestamp: Date.now(),
				});
			}

			// Keep bounded
			while (this._edits.length > MAX_EDITS * 3) {
				this._edits.shift();
			}
		}));
	}
}
