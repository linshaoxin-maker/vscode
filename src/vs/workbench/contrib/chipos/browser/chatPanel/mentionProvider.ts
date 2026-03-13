/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import * as dom from '../../../../../base/browser/dom.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';
import type { IMentionItem } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

// ── IMentionSource ──────────────────────────────────────────────────────────

export interface IMentionSource {
	readonly type: 'file' | 'folder' | 'snippet';
	readonly icon: string;
	search(query: string): Promise<IMentionItem[]>;
}

// ── FileMentionSource ───────────────────────────────────────────────────────

const MAX_DEPTH = 5;
const MAX_FILES = 500;
const MAX_RESULTS_PER_SOURCE = 15;

export class FileMentionSource implements IMentionSource {
	readonly type = 'file' as const;
	readonly icon = '📄';

	private _cache: IMentionItem[] | undefined;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _workspaceContext: IWorkspaceContextService,
	) {}

	async search(query: string): Promise<IMentionItem[]> {
		const items = await this._getFileCache();
		return fuzzyFilter(items, query).slice(0, MAX_RESULTS_PER_SOURCE);
	}

	private async _getFileCache(): Promise<IMentionItem[]> {
		if (this._cache) {
			return this._cache;
		}

		const folders = this._workspaceContext.getWorkspace().folders;
		if (folders.length === 0) {
			return [];
		}

		const rootUri = folders[0].uri;
		const results: IMentionItem[] = [];
		await this._walk(rootUri, rootUri, 0, results);
		this._cache = results;

		setTimeout(() => { this._cache = undefined; }, 30_000);
		return results;
	}

	private async _walk(uri: URI, rootUri: URI, depth: number, results: IMentionItem[]): Promise<void> {
		if (depth > MAX_DEPTH || results.length >= MAX_FILES) {
			return;
		}

		try {
			const stat = await this._fileService.resolve(uri);
			if (!stat.children) {
				return;
			}

			for (const child of stat.children) {
				if (results.length >= MAX_FILES) {
					break;
				}
				if (child.name.startsWith('.') || child.name === 'node_modules') {
					continue;
				}

				if (child.isFile) {
					const relativePath = this._relativePath(rootUri, child.resource);
					results.push({
						path: relativePath,
						type: 'file',
						displayName: child.name,
					});
				} else if (child.isDirectory) {
					await this._walk(child.resource, rootUri, depth + 1, results);
				}
			}
		} catch {
			// directory not readable — skip
		}
	}

	private _relativePath(root: URI, target: URI): string {
		const rootPath = root.path.endsWith('/') ? root.path : root.path + '/';
		return target.path.startsWith(rootPath) ? target.path.slice(rootPath.length) : target.path;
	}
}

// ── FolderMentionSource ─────────────────────────────────────────────────────

export class FolderMentionSource implements IMentionSource {
	readonly type = 'folder' as const;
	readonly icon = '📁';

	private _cache: IMentionItem[] | undefined;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _workspaceContext: IWorkspaceContextService,
	) {}

	async search(query: string): Promise<IMentionItem[]> {
		const items = await this._getFolderCache();
		return fuzzyFilter(items, query).slice(0, MAX_RESULTS_PER_SOURCE);
	}

	private async _getFolderCache(): Promise<IMentionItem[]> {
		if (this._cache) {
			return this._cache;
		}

		const folders = this._workspaceContext.getWorkspace().folders;
		if (folders.length === 0) {
			return [];
		}

		const rootUri = folders[0].uri;
		const results: IMentionItem[] = [];
		await this._walk(rootUri, rootUri, 0, results);
		this._cache = results;

		setTimeout(() => { this._cache = undefined; }, 30_000);
		return results;
	}

	private async _walk(uri: URI, rootUri: URI, depth: number, results: IMentionItem[]): Promise<void> {
		if (depth > MAX_DEPTH || results.length >= MAX_FILES) {
			return;
		}

		try {
			const stat = await this._fileService.resolve(uri);
			if (!stat.children) {
				return;
			}

			for (const child of stat.children) {
				if (results.length >= MAX_FILES) {
					break;
				}
				if (child.name.startsWith('.') || child.name === 'node_modules') {
					continue;
				}

				if (child.isDirectory) {
					const rootPath = rootUri.path.endsWith('/') ? rootUri.path : rootUri.path + '/';
					const relativePath = child.resource.path.startsWith(rootPath)
						? child.resource.path.slice(rootPath.length)
						: child.resource.path;
					results.push({
						path: relativePath,
						type: 'folder',
						displayName: child.name,
					});
					await this._walk(child.resource, rootUri, depth + 1, results);
				}
			}
		} catch {
			// skip
		}
	}
}

// ── SelectionMentionSource ──────────────────────────────────────────────────

export class SelectionMentionSource implements IMentionSource {
	readonly type = 'snippet' as const;
	readonly icon = '✂️';

	constructor(
		private readonly _editorService: IEditorService,
	) {}

	async search(_query: string): Promise<IMentionItem[]> {
		const editor = this._editorService.activeTextEditorControl;
		if (!editor || typeof (editor as any).getModel !== 'function') {
			return [];
		}

		const model = (editor as any).getModel();
		const selection = (editor as any).getSelection?.();
		if (!model || !selection || selection.isEmpty()) {
			return [];
		}

		const content = model.getValueInRange(selection);
		if (!content) {
			return [];
		}

		const uri: URI | undefined = model.uri;
		const fileName = uri ? basename(uri) : 'untitled';
		const filePath = uri ? uri.fsPath : 'untitled';

		return [{
			path: filePath,
			type: 'snippet',
			displayName: `Selection in ${fileName}`,
			content,
			startLine: selection.startLineNumber,
			endLine: selection.endLineNumber,
		}];
	}
}

// ── MentionProvider ─────────────────────────────────────────────────────────

const AT_REGEX = /@([^\s]*)$/;
const DEBOUNCE_MS = 150;
const MAX_TOTAL_RESULTS = 20;

export class MentionProvider extends Disposable {

	private readonly _sources: IMentionSource[];
	private _active = false;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidRequestShow = this._register(new Emitter<IMentionItem[]>());
	readonly onDidRequestShow: Event<IMentionItem[]> = this._onDidRequestShow.event;

	private readonly _onDidRequestHide = this._register(new Emitter<void>());
	readonly onDidRequestHide: Event<void> = this._onDidRequestHide.event;

	constructor(
		private readonly _textarea: HTMLTextAreaElement,
		fileService: IFileService,
		editorService: IEditorService,
		workspaceContext: IWorkspaceContextService,
	) {
		super();

		this._sources = [
			new SelectionMentionSource(editorService),
			new FileMentionSource(fileService, workspaceContext),
			new FolderMentionSource(fileService, workspaceContext),
		];

		this._register(dom.addDisposableListener(this._textarea, 'input', () => this._onInput()));
		this._register(dom.addDisposableListener(this._textarea, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this._active) {
				this.cancel();
			}
		}));
	}

	isActive(): boolean {
		return this._active;
	}

	getAtQueryRange(): { start: number; end: number } | undefined {
		const pos = this._textarea.selectionStart;
		const textBefore = this._textarea.value.slice(0, pos);
		const match = AT_REGEX.exec(textBefore);
		if (!match) {
			return undefined;
		}
		const start = pos - match[0].length;
		return { start, end: pos };
	}

	consumeAtQuery(): void {
		const range = this.getAtQueryRange();
		if (!range) {
			return;
		}
		const value = this._textarea.value;
		this._textarea.value = value.slice(0, range.start) + value.slice(range.end);
		this._textarea.selectionStart = range.start;
		this._textarea.selectionEnd = range.start;
		this._active = false;
	}

	async triggerSearch(query: string): Promise<void> {
		const allResults: IMentionItem[] = [];
		const promises = this._sources.map(source => source.search(query));
		const results = await Promise.all(promises);
		for (const batch of results) {
			allResults.push(...batch);
			if (allResults.length >= MAX_TOTAL_RESULTS) {
				break;
			}
		}
		const trimmed = allResults.slice(0, MAX_TOTAL_RESULTS);
		this._active = true;
		this._onDidRequestShow.fire(trimmed);
	}

	cancel(): void {
		this._active = false;
		this._clearDebounce();
		this._onDidRequestHide.fire();
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private _onInput(): void {
		const range = this.getAtQueryRange();
		if (!range) {
			if (this._active) {
				this.cancel();
			}
			return;
		}

		const query = this._textarea.value.slice(range.start + 1, range.end); // skip '@'
		this._clearDebounce();
		this._debounceTimer = setTimeout(() => this.triggerSearch(query), DEBOUNCE_MS);
	}

	private _clearDebounce(): void {
		if (this._debounceTimer !== undefined) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
	}

	override dispose(): void {
		this._clearDebounce();
		super.dispose();
	}
}

// ── Utilities ───────────────────────────────────────────────────────────────

function fuzzyFilter(items: IMentionItem[], query: string): IMentionItem[] {
	if (!query) {
		return items;
	}
	const lower = query.toLowerCase();
	return items.filter(item => {
		const name = item.displayName.toLowerCase();
		const path = item.path.toLowerCase();
		return fuzzyMatch(name, lower) || fuzzyMatch(path, lower);
	});
}

function fuzzyMatch(target: string, query: string): boolean {
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (target[ti] === query[qi]) {
			qi++;
		}
	}
	return qi === query.length;
}
