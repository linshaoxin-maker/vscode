/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import * as dom from '../../../../../base/browser/dom.js';
import type { IDiffHunk } from '../../../../../workbench/contrib/chipos/browser/inlineDiff/diffComputer.js';
import { DiffActionWidget } from '../../../../../workbench/contrib/chipos/browser/inlineDiff/diffActionWidget.js';

const $ = dom.$;

// ── Tracking structures ─────────────────────────────────────────────────────

interface IHunkState {
	readonly hunk: IDiffHunk;
	decorationIds: string[];
	viewZoneId: string | undefined;
	widget: DiffActionWidget | undefined;
	contentWidgetId: string | undefined;
}

// ── InlineDiffDecorator ─────────────────────────────────────────────────────

/**
 * Renders inline diff decorations (insert / delete / modify) inside
 * a single code editor and provides per-hunk accept/reject actions.
 */
export class InlineDiffDecorator extends Disposable {

	private readonly _editor: any; // ICodeEditor
	private readonly _hunkStates = new Map<string, IHunkState>();

	private readonly _onDidAcceptHunk = this._register(new Emitter<IDiffHunk>());
	readonly onDidAcceptHunk: Event<IDiffHunk> = this._onDidAcceptHunk.event;

	private readonly _onDidRejectHunk = this._register(new Emitter<IDiffHunk>());
	readonly onDidRejectHunk: Event<IDiffHunk> = this._onDidRejectHunk.event;

	constructor(editor: any, hunks: IDiffHunk[]) {
		super();
		this._editor = editor;

		for (const hunk of hunks) {
			this._hunkStates.set(hunk.id, {
				hunk,
				decorationIds: [],
				viewZoneId: undefined,
				widget: undefined,
				contentWidgetId: undefined,
			});
		}
	}

	// ── Public API ────────────────────────────────────────────────────────

	render(): void {
		for (const state of this._hunkStates.values()) {
			this._renderHunk(state);
		}
	}

	acceptHunk(hunkId: string): void {
		const state = this._hunkStates.get(hunkId);
		if (!state) {
			return;
		}
		state.hunk.status = 'accepted';
		this._clearHunkDecorations(state);
		this._hunkStates.delete(hunkId);
		this._onDidAcceptHunk.fire(state.hunk);
	}

	rejectHunk(hunkId: string): void {
		const state = this._hunkStates.get(hunkId);
		if (!state) {
			return;
		}
		state.hunk.status = 'rejected';

		this._revertHunkInModel(state);
		this._clearHunkDecorations(state);
		this._hunkStates.delete(hunkId);
		this._onDidRejectHunk.fire(state.hunk);
	}

	clearDecorations(): void {
		for (const state of this._hunkStates.values()) {
			this._clearHunkDecorations(state);
		}
		this._hunkStates.clear();
	}

	getHunks(): IDiffHunk[] {
		return Array.from(this._hunkStates.values()).map(s => s.hunk);
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	private _renderHunk(state: IHunkState): void {
		const { hunk } = state;

		switch (hunk.type) {
			case 'insert':
				this._renderInsertHunk(state);
				break;
			case 'delete':
				this._renderDeleteHunk(state);
				break;
			case 'modify':
				this._renderModifyHunk(state);
				break;
		}

		this._addActionWidget(state);
	}

	private _renderInsertHunk(state: IHunkState): void {
		const { hunk } = state;
		const decorations = [{
			range: {
				startLineNumber: hunk.newRange.startLine,
				startColumn: 1,
				endLineNumber: hunk.newRange.endLine,
				endColumn: 1,
			},
			options: {
				isWholeLine: true,
				className: 'chipos-diff-insert-line',
				glyphMarginClassName: 'chipos-diff-insert-gutter',
			},
		}];

		this._applyDecorations(state, decorations);
	}

	private _renderDeleteHunk(state: IHunkState): void {
		const { hunk } = state;
		const insertLine = hunk.oldRange.startLine;

		this._editor.changeViewZones?.((accessor: any) => {
			const domNode = $('div.chipos-diff-delete-zone');
			for (const line of hunk.oldContent) {
				const lineEl = $('div.chipos-diff-delete-line-content');
				lineEl.textContent = line;
				domNode.appendChild(lineEl);
			}

			const zoneId = accessor.addZone({
				afterLineNumber: Math.max(insertLine - 1, 0),
				heightInLines: hunk.oldContent.length,
				domNode,
			});

			state.viewZoneId = zoneId;
		});
	}

	private _renderModifyHunk(state: IHunkState): void {
		const { hunk } = state;
		const decorations = [{
			range: {
				startLineNumber: hunk.newRange.startLine,
				startColumn: 1,
				endLineNumber: hunk.newRange.endLine,
				endColumn: 1,
			},
			options: {
				isWholeLine: true,
				className: 'chipos-diff-modify-line',
				glyphMarginClassName: 'chipos-diff-modify-gutter',
			},
		}];

		this._applyDecorations(state, decorations);

		// Also render deleted content as a view zone above modified lines
		if (hunk.oldContent.length > 0) {
			this._editor.changeViewZones?.((accessor: any) => {
				const domNode = $('div.chipos-diff-delete-zone');
				for (const line of hunk.oldContent) {
					const lineEl = $('div.chipos-diff-delete-line-content');
					lineEl.textContent = line;
					domNode.appendChild(lineEl);
				}

				const zoneId = accessor.addZone({
					afterLineNumber: Math.max(hunk.newRange.startLine - 1, 0),
					heightInLines: hunk.oldContent.length,
					domNode,
				});

				state.viewZoneId = zoneId;
			});
		}
	}

	// ── Action widget ─────────────────────────────────────────────────────

	private _addActionWidget(state: IHunkState): void {
		const widget = new DiffActionWidget(state.hunk);
		state.widget = widget;

		this._register(widget.onDidAccept(() => {
			this.acceptHunk(state.hunk.id);
		}));

		this._register(widget.onDidReject(() => {
			this.rejectHunk(state.hunk.id);
		}));

		const targetLine = state.hunk.type === 'delete'
			? state.hunk.oldRange.startLine
			: state.hunk.newRange.startLine;

		const contentWidgetId = `chipos-diff-action-${state.hunk.id}`;
		state.contentWidgetId = contentWidgetId;

		const contentWidget = {
			getId: () => contentWidgetId,
			getDomNode: () => widget.getDomNode(),
			getPosition: () => ({
				position: { lineNumber: targetLine, column: 1 },
				preference: [1 /* ContentWidgetPositionPreference.ABOVE */],
			}),
		};

		this._editor.addContentWidget?.(contentWidget);
	}

	// ── Decorations helper ────────────────────────────────────────────────

	private _applyDecorations(state: IHunkState, decorations: any[]): void {
		if (this._editor.deltaDecorations) {
			const ids = this._editor.deltaDecorations([], decorations);
			state.decorationIds.push(...ids);
		}
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	private _clearHunkDecorations(state: IHunkState): void {
		if (state.decorationIds.length > 0 && this._editor.deltaDecorations) {
			this._editor.deltaDecorations(state.decorationIds, []);
			state.decorationIds = [];
		}

		if (state.viewZoneId !== undefined) {
			this._editor.changeViewZones?.((accessor: any) => {
				accessor.removeZone(state.viewZoneId!);
			});
			state.viewZoneId = undefined;
		}

		if (state.widget && state.contentWidgetId) {
			this._editor.removeContentWidget?.({
				getId: () => state.contentWidgetId!,
				getDomNode: () => state.widget!.getDomNode(),
				getPosition: () => null,
			});
			state.widget.dispose();
			state.widget = undefined;
			state.contentWidgetId = undefined;
		}
	}

	// ── Revert ────────────────────────────────────────────────────────────

	private _revertHunkInModel(state: IHunkState): void {
		const model = this._editor.getModel?.();
		if (!model) {
			return;
		}

		const { hunk } = state;

		switch (hunk.type) {
			case 'insert': {
				// Remove the inserted lines
				const range = {
					startLineNumber: hunk.newRange.startLine,
					startColumn: 1,
					endLineNumber: hunk.newRange.endLine + 1,
					endColumn: 1,
				};
				model.pushEditOperations?.([], [{
					range,
					text: null,
				}], () => null);
				break;
			}
			case 'delete': {
				// Re-insert the deleted lines
				const insertPos = {
					startLineNumber: hunk.oldRange.startLine,
					startColumn: 1,
					endLineNumber: hunk.oldRange.startLine,
					endColumn: 1,
				};
				const text = hunk.oldContent.join('\n') + '\n';
				model.pushEditOperations?.([], [{
					range: insertPos,
					text,
				}], () => null);
				break;
			}
			case 'modify': {
				// Replace new content with old content
				const range = {
					startLineNumber: hunk.newRange.startLine,
					startColumn: 1,
					endLineNumber: hunk.newRange.endLine,
					endColumn: model.getLineMaxColumn?.(hunk.newRange.endLine) ?? 1,
				};
				const text = hunk.oldContent.join('\n');
				model.pushEditOperations?.([], [{
					range,
					text,
				}], () => null);
				break;
			}
		}
	}

	override dispose(): void {
		this.clearDecorations();
		super.dispose();
	}
}
