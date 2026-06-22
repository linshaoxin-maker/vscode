/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../../../workbench/common/views.js';
import { IPpaSnapshot, IPpaStorageService } from './ppaStorageService.js';

/** Command id the list items invoke to open a snapshot's detail dashboard. */
export const OPEN_PPA_DETAIL_COMMAND_ID = 'chipos.ppa.openDetail';

/**
 * Thin handler over {@link IPpaStorageService} that mirrors
 * {@link RunHistoryTreeHandler}: it exposes the current PPA snapshot list plus
 * an `onDidChangeTreeData` event the view subscribes to for refreshes, and a
 * `findReport` lookup the data provider uses to resolve a tree handle back to a
 * snapshot record.
 */
export class PpaHistoryTreeHandler extends Disposable {

	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	private readonly _byHandle = new Map<string, IPpaSnapshot>();

	constructor(
		@IPpaStorageService private readonly _service: IPpaStorageService,
	) {
		super();

		this._reindex();
		this._register(this._service.onDidChange(() => {
			this._reindex();
			this._onDidChangeTreeData.fire();
		}));
	}

	get reports(): readonly IPpaSnapshot[] {
		return this._service.getReports();
	}

	get isEmpty(): boolean {
		return this._service.getReports().length === 0;
	}

	findReport(handle: string): IPpaSnapshot | undefined {
		return this._byHandle.get(handle);
	}

	private _reindex(): void {
		this._byHandle.clear();
		for (const snapshot of this._service.getReports()) {
			this._byHandle.set(snapshotHandle(snapshot), snapshot);
		}
	}
}

/**
 * Adapts {@link PpaHistoryTreeHandler} to the VS Code
 * {@link ITreeViewDataProvider} contract consumed by `CustomTreeView`. Mirrors
 * `RunHistoryTreeDataProvider`: maps each snapshot to a flat `ITreeItem`
 * (no nesting), exposes `isTreeEmpty` + `onDidChangeEmpty` so the pane can
 * render its empty state, and attaches an open-detail `command` so a click
 * opens the PPA detail dashboard.
 */
export class PpaHistoryTreeDataProvider extends Disposable implements ITreeViewDataProvider {

	private _isEmpty = true;
	private readonly _onDidChangeEmpty = this._register(new Emitter<void>());
	readonly onDidChangeEmpty: Event<void> = this._onDidChangeEmpty.event;

	constructor(private readonly _handler: PpaHistoryTreeHandler) {
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
		// Flat list: only the root level has items; snapshots never nest.
		if (element) {
			return [];
		}
		return this._handler.reports.map(snapshot => this._toTreeItem(snapshot));
	}

	private _toTreeItem(snapshot: IPpaSnapshot): ITreeItem {
		const handle = snapshotHandle(snapshot);
		const item: ITreeItem = {
			handle,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: labelFor(snapshot) },
			description: describeSnapshot(snapshot),
			themeIcon: stageIcon(snapshot.stage),
			tooltip: localize('chipos.ppa.tooltip', '{0} — {1}', labelFor(snapshot), snapshot.traceId),
			command: {
				id: OPEN_PPA_DETAIL_COMMAND_ID,
				title: '',
				arguments: [snapshot],
			},
		};
		return item;
	}
}

/** Stable per-snapshot handle, matching the storage service map key. */
function snapshotHandle(snapshot: IPpaSnapshot): string {
	return `${snapshot.traceId}#${snapshot.round ?? 0}`;
}

/** Primary list label, e.g. `Round 3 · pareto-sweep`. */
function labelFor(snapshot: IPpaSnapshot): string {
	return localize('chipos.ppa.label', 'Round {0} · {1}', snapshot.round ?? 0, snapshot.strategy ?? '—');
}

/** Stage → list icon. Improved uses the up-arrow; others map by meaning. */
function stageIcon(stage: string): ThemeIcon {
	switch (stage) {
		case 'improved': return Codicon.arrowUp;
		case 'not_improved': return Codicon.arrowDown;
		case 'baseline': return Codicon.circleOutline;
		case 'eval_round': return Codicon.graph;
		default: return Codicon.circleOutline;
	}
}

/** Builds the dimmed description, e.g. `improved · area 12,840`. */
function describeSnapshot(snapshot: IPpaSnapshot): string {
	const parts: string[] = [snapshot.stage];
	const area = snapshot.current?.area;
	if (typeof area === 'number') {
		parts.push(localize('chipos.ppa.metric.area', 'area {0}', area.toLocaleString()));
	}
	return parts.join(' · ');
}
