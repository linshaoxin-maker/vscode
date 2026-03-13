/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IMarkerService, IMarker, MarkerSeverity } from '../../../../../../platform/markers/common/markers.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const SEVERITY_LABEL: Record<number, string> = {
	[MarkerSeverity.Error]: 'error',
	[MarkerSeverity.Warning]: 'warning',
	[MarkerSeverity.Info]: 'info',
	[MarkerSeverity.Hint]: 'hint',
};

export class LinterProvider implements IContextProvider {

	readonly source = ContextSourceType.Linter;

	constructor(
		private readonly _markerService: IMarkerService,
		private readonly _editorService: IEditorService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const uris = new Set<string>();

		for (const input of this._editorService.editors) {
			const resource = input.resource;
			if (resource) {
				uris.add(resource.toString());
			}
		}

			if (uris.size === 0) {
				const editor = this._editorService.activeTextEditorControl;
				const model = editor?.getModel?.() as ITextModel | undefined;
				if (model) {
					uris.add(model.uri.toString());
				}
			}

			const markers = this._markerService.read({
				severities: MarkerSeverity.Error | MarkerSeverity.Warning,
			});

			const relevantMarkers = markers.filter(m => uris.has(m.resource.toString()));
			if (relevantMarkers.length === 0) {
				return [];
			}

			const lines = relevantMarkers.map(m => this._formatMarker(m));
			const content = `Diagnostics:\n${lines.join('\n')}`;

			return [{
				source: ContextSourceType.Linter,
				content,
				priority: 4,
				tokenEstimate: Math.ceil(content.length / 4),
				metadata: { count: relevantMarkers.length },
			}];
		} catch {
			return [];
		}
	}

	private _formatMarker(m: IMarker): string {
		const severity = SEVERITY_LABEL[m.severity] ?? 'unknown';
		const path = m.resource.fsPath;
		return `${path}:${m.startLineNumber}:${m.startColumn}: ${severity}: ${m.message}`;
	}
}
