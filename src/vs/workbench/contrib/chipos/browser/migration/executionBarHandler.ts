/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';

export interface ITodoItem {
	readonly label: string;
	readonly status: 'done' | 'active' | 'pending';
}

export interface IFileChange {
	readonly path: string;
	readonly type: 'modified' | 'added' | 'deleted';
}

export interface IExecutionBarItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: string;
	readonly children?: IExecutionBarItem[];
}

const TODO_STATUS_ICON: Record<string, string> = {
	done: '✓',
	active: '▶',
	pending: '○',
};

const FILE_CHANGE_ICON: Record<string, string> = {
	modified: 'M',
	added: 'A',
	deleted: 'D',
};

export class ExecutionBarHandler extends Disposable {

	private _stage = '';
	private _summary = '';
	private _todos: ITodoItem[] = [];
	private _files: IFileChange[] = [];

	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	updateStatus(stage: string, summary: string): void {
		this._stage = stage;
		this._summary = summary;
		this._logService.trace('[ExecutionBarHandler] Stage:', stage, summary);
		this._onDidChangeTreeData.fire();
	}

	updateTodoList(todos: ITodoItem[]): void {
		this._todos = todos;
		this._onDidChangeTreeData.fire();
	}

	updateFileChanges(files: IFileChange[]): void {
		this._files = files;
		this._onDidChangeTreeData.fire();
	}

	openFile(path: string): void {
		this._editorService.openEditor({ resource: URI.file(path) });
	}

	getTreeDataProvider(): IExecutionBarTreeDataProvider {
		return {
			onDidChangeTreeData: this.onDidChangeTreeData,
			getChildren: (element?: IExecutionBarItem) => this._getChildren(element),
			getTreeItem: (element: IExecutionBarItem) => this._getTreeItem(element),
		};
	}

	get stage(): string {
		return this._stage;
	}

	get summary(): string {
		return this._summary;
	}

	// ── Tree data provider implementation ─────────────────────────────────

	private _getChildren(element?: IExecutionBarItem): IExecutionBarItem[] {
		if (!element) {
			const roots: IExecutionBarItem[] = [];

			if (this._stage) {
				roots.push({
					id: 'status',
					label: `Stage: ${this._stage}`,
					description: this._summary,
					icon: '⚡',
				});
			}

			if (this._todos.length > 0) {
				const doneCount = this._todos.filter(t => t.status === 'done').length;
				roots.push({
					id: 'todos',
					label: `Tasks (${doneCount}/${this._todos.length})`,
					icon: '📋',
					children: this._todos.map((todo, i) => ({
						id: `todo-${i}`,
						label: todo.label,
						icon: TODO_STATUS_ICON[todo.status] ?? '○',
						description: todo.status,
					})),
				});
			}

			if (this._files.length > 0) {
				roots.push({
					id: 'files',
					label: `Files Changed (${this._files.length})`,
					icon: '📁',
					children: this._files.map((file, i) => ({
						id: `file-${i}`,
						label: file.path.split('/').pop() ?? file.path,
						description: file.path,
						icon: FILE_CHANGE_ICON[file.type] ?? '?',
					})),
				});
			}

			return roots;
		}

		return element.children ?? [];
	}

	private _getTreeItem(element: IExecutionBarItem): IExecutionBarTreeItem {
		return {
			id: element.id,
			label: element.label,
			description: element.description,
			collapsibleState: element.children && element.children.length > 0 ? 1 : 0,
		};
	}
}

export interface IExecutionBarTreeItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly collapsibleState: number; // 0 = None, 1 = Collapsed, 2 = Expanded
}

export interface IExecutionBarTreeDataProvider {
	readonly onDidChangeTreeData: Event<void>;
	getChildren(element?: IExecutionBarItem): IExecutionBarItem[];
	getTreeItem(element: IExecutionBarItem): IExecutionBarTreeItem;
}
