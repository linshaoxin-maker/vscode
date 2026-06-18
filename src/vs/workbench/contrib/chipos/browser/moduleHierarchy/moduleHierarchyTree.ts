/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IModuleHierarchyNode, IModuleHierarchyService } from './moduleHierarchyService.js';

/**
 * Thin handler over {@link IModuleHierarchyService} that mirrors the
 * {@link SkillTreeHandler} shape: it exposes a stable node model plus an
 * `onDidChangeTreeData` event the view subscribes to for refreshes, and a
 * `findNode` lookup the data provider uses to resolve a tree handle back to a
 * model node.
 */
export class ModuleHierarchyTreeHandler extends Disposable {

	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	private readonly _byHandle = new Map<string, IModuleHierarchyNode>();

	constructor(
		@IModuleHierarchyService private readonly _service: IModuleHierarchyService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._reindex();
		this._register(this._service.onDidChangeHierarchy(() => {
			this._reindex();
			this._logService.trace('[ModuleHierarchy] Tree data changed:', this._byHandle.size, 'node(s)');
			this._onDidChangeTreeData.fire();
		}));
	}

	get roots(): readonly IModuleHierarchyNode[] {
		return this._service.getRoots();
	}

	get isEmpty(): boolean {
		return this._service.isEmpty;
	}

	findNode(handle: string): IModuleHierarchyNode | undefined {
		return this._byHandle.get(handle);
	}

	private _reindex(): void {
		this._byHandle.clear();
		const visit = (nodes: readonly IModuleHierarchyNode[]): void => {
			for (const node of nodes) {
				this._byHandle.set(node.handle, node);
				visit(node.children);
			}
		};
		visit(this._service.getRoots());
	}
}
