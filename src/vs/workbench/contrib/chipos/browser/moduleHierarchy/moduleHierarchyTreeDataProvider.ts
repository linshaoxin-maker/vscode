/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { API_OPEN_EDITOR_COMMAND_ID } from '../../../../../workbench/browser/parts/editor/editorCommands.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../../../workbench/common/views.js';
import { IModuleHierarchyNode } from './moduleHierarchyService.js';
import { ModuleHierarchyTreeHandler } from './moduleHierarchyTree.js';

/**
 * Adapts {@link ModuleHierarchyTreeHandler} to the VS Code
 * {@link ITreeViewDataProvider} contract consumed by `CustomTreeView`. Mirrors
 * `SkillTreeViewDataProvider`: maps model nodes to `ITreeItem`s, exposes
 * `isTreeEmpty` + `onDidChangeEmpty` so the pane can render its welcome/empty
 * state, and attaches an open-editor `command` so a click jumps to the module
 * definition.
 */
export class ModuleHierarchyTreeDataProvider extends Disposable implements ITreeViewDataProvider {

	private _isEmpty = true;
	private readonly _onDidChangeEmpty = this._register(new Emitter<void>());
	readonly onDidChangeEmpty: Event<void> = this._onDidChangeEmpty.event;

	constructor(private readonly _handler: ModuleHierarchyTreeHandler) {
		super();

		this._isEmpty = this._handler.isEmpty;
		this._register(this._handler.onDidChangeTreeData(() => {
			const wasEmpty = this._isEmpty;
			this._isEmpty = this._handler.isEmpty;
			if (wasEmpty !== this._isEmpty) {
				this._onDidChangeEmpty.fire();
			}
		}));
	}

	get isTreeEmpty(): boolean {
		return this._isEmpty;
	}

	async getChildren(element?: ITreeItem): Promise<ITreeItem[] | undefined> {
		if (!element) {
			return this._handler.roots.map(node => this._toTreeItem(node));
		}
		const node = this._handler.findNode(element.handle);
		if (node) {
			return node.children.map(child => this._toTreeItem(child));
		}
		return [];
	}

	private _toTreeItem(node: IModuleHierarchyNode): ITreeItem {
		const hasChildren = node.children.length > 0;

		// Root/top modules show just the module name; instance nodes show
		// `instance : module_type` (instance name primary, ` : type` dimmed).
		const label = node.instanceName
			? localize('chipos.moduleHierarchy.instanceLabel', '{0} : {1}', node.instanceName, node.moduleType)
			: node.moduleType;

		const item: ITreeItem = {
			handle: node.handle,
			collapsibleState: hasChildren ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
			label: { label },
			themeIcon: Codicon.circuitBoard,
		};

		const definition = node.definition;
		if (definition) {
			// Source file name, dimmed/trailing.
			item.description = definition.fileName;
			item.resourceUri = definition.uri;
			item.tooltip = localize('chipos.moduleHierarchy.tooltip', '{0} — {1}:{2}', node.moduleType, definition.fileName, definition.line + 1);

			// Click → open the `module <type>` definition (1-based line/column).
			const options: ITextEditorOptions = {
				selection: { startLineNumber: definition.line + 1, startColumn: 1 },
			};
			item.command = {
				id: API_OPEN_EDITOR_COMMAND_ID,
				title: '',
				arguments: [definition.uri, [undefined, options], undefined],
			};
		} else {
			item.tooltip = localize('chipos.moduleHierarchy.noDefinition', '{0} (definition not found)', node.moduleType);
		}

		return item;
	}
}
