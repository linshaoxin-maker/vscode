/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import type { IFileEditPayload } from 'vs/workbench/contrib/chipos/browser/eventStream/eventTypes';
import { DiffComputer, type IDiffHunk } from 'vs/workbench/contrib/chipos/browser/inlineDiff/diffComputer';
import { InlineDiffDecorator } from 'vs/workbench/contrib/chipos/browser/inlineDiff/inlineDiffDecorator';
import { DiffSummaryWidget } from 'vs/workbench/contrib/chipos/browser/inlineDiff/diffSummaryWidget';

// ── Per-file state ──────────────────────────────────────────────────────────

interface IFileDiffState {
	readonly filePath: string;
	readonly oldContent: string;
	readonly decorator: InlineDiffDecorator;
}

// ── InlineDiffController ────────────────────────────────────────────────────

/**
 * Orchestrates inline diff review across multiple files.
 * Receives `IFileEditPayload` events, opens the affected editor,
 * computes diffs, and creates decorators for interactive review.
 */
export class InlineDiffController extends Disposable {

	private readonly _editorService: any;   // IEditorService
	private readonly _textFileService: any; // ITextFileService

	private readonly _activeDecorators = new Map<string, IFileDiffState>();
	private readonly _summaryWidget: DiffSummaryWidget;

	private readonly _onDidResolveAllHunks = this._register(new Emitter<void>());
	readonly onDidResolveAllHunks: Event<void> = this._onDidResolveAllHunks.event;

	constructor(
		editorService: any,
		textFileService: any,
	) {
		super();
		this._editorService = editorService;
		this._textFileService = textFileService;

		this._summaryWidget = this._register(new DiffSummaryWidget());

		this._register(this._summaryWidget.onDidAcceptAll(() => {
			this.acceptAllFiles();
		}));

		this._register(this._summaryWidget.onDidRejectAll(() => {
			this.rejectAllFiles();
		}));
	}

	// ── Main entry point ────────────────────────────────────────────────

	async handleFileEdit(payload: IFileEditPayload): Promise<void> {
		const { file_path, edits } = payload;

		if (edits.length === 0) {
			return;
		}

		const uri = URI.file(file_path);

		// Open file in editor
		const editorPane = await this._editorService.openEditor?.({
			resource: uri,
			options: { pinned: true, preserveFocus: false },
		});

		const editor = editorPane?.getControl?.();
		if (!editor) {
			return;
		}

		const model = editor.getModel?.();
		if (!model) {
			return;
		}

		// Read current content before edits
		const oldContent = model.getValue?.() ?? '';

		// Compute new content
		const newContent = DiffComputer.applyEdits(oldContent, edits);

		// Compute diff hunks between old and new
		const hunks = DiffComputer.compute(oldContent, newContent);

		if (hunks.length === 0) {
			return;
		}

		// Apply the new content into the model
		model.setValue?.(newContent);

		// Dispose previous decorator for this file if any
		this._activeDecorators.get(file_path)?.decorator.dispose();

		// Create decorator and render
		const decorator = new InlineDiffDecorator(editor, hunks);
		this._register(decorator);

		this._activeDecorators.set(file_path, {
			filePath: file_path,
			oldContent,
			decorator,
		});

		decorator.render();

		this._register(decorator.onDidAcceptHunk(() => {
			this._onHunkResolved(file_path);
		}));

		this._register(decorator.onDidRejectHunk(() => {
			this._onHunkResolved(file_path);
		}));

		this._updateSummary();
	}

	// ── Bulk operations ─────────────────────────────────────────────────

	acceptAll(filePath: string): void {
		const state = this._activeDecorators.get(filePath);
		if (!state) {
			return;
		}
		const hunks = state.decorator.getHunks();
		for (const hunk of hunks) {
			state.decorator.acceptHunk(hunk.id);
		}
		this._cleanupFileIfDone(filePath);
	}

	rejectAll(filePath: string): void {
		const state = this._activeDecorators.get(filePath);
		if (!state) {
			return;
		}

		// Restore original content
		this._restoreFileContent(state);
		state.decorator.clearDecorations();
		state.decorator.dispose();
		this._activeDecorators.delete(filePath);
		this._updateSummary();
	}

	acceptAllFiles(): void {
		for (const filePath of [...this._activeDecorators.keys()]) {
			this.acceptAll(filePath);
		}
	}

	rejectAllFiles(): void {
		for (const filePath of [...this._activeDecorators.keys()]) {
			this.rejectAll(filePath);
		}
	}

	getActiveDiffFiles(): string[] {
		return Array.from(this._activeDecorators.keys());
	}

	getSummaryWidget(): DiffSummaryWidget {
		return this._summaryWidget;
	}

	clearAll(): void {
		for (const state of this._activeDecorators.values()) {
			state.decorator.clearDecorations();
			state.decorator.dispose();
		}
		this._activeDecorators.clear();
		this._summaryWidget.hide();
	}

	// ── Private ─────────────────────────────────────────────────────────

	private _onHunkResolved(filePath: string): void {
		this._cleanupFileIfDone(filePath);
		this._updateSummary();
	}

	private _cleanupFileIfDone(filePath: string): void {
		const state = this._activeDecorators.get(filePath);
		if (!state) {
			return;
		}
		const remaining = state.decorator.getHunks().filter(h => h.status === 'pending');
		if (remaining.length === 0) {
			state.decorator.dispose();
			this._activeDecorators.delete(filePath);
			this._updateSummary();
		}
	}

	private _updateSummary(): void {
		const fileCount = this._activeDecorators.size;
		let hunkCount = 0;

		for (const state of this._activeDecorators.values()) {
			hunkCount += state.decorator.getHunks().filter(h => h.status === 'pending').length;
		}

		if (fileCount === 0) {
			this._summaryWidget.hide();
			this._onDidResolveAllHunks.fire();
		} else {
			this._summaryWidget.update(fileCount, hunkCount);
			this._summaryWidget.show();
		}
	}

	private async _restoreFileContent(state: IFileDiffState): Promise<void> {
		const uri = URI.file(state.filePath);

		const editorPane = await this._editorService.openEditor?.({
			resource: uri,
			options: { pinned: true, preserveFocus: true },
		});

		const editor = editorPane?.getControl?.();
		const model = editor?.getModel?.();
		if (model) {
			model.setValue?.(state.oldContent);
		}
	}

	override dispose(): void {
		this.clearAll();
		super.dispose();
	}
}
