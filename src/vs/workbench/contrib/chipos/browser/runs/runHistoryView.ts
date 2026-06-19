/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../../../workbench/common/views.js';
import { IRunMetadata, IRunStorageService, RunStatus } from './runStorageService.js';

/** Command id the list items invoke to open a run's detail view. */
export const OPEN_RUN_DETAIL_COMMAND_ID = 'chipos.runs.openDetail';

/**
 * Thin handler over {@link IRunStorageService} that mirrors
 * {@link ModuleHierarchyTreeHandler}: it exposes the current run list plus an
 * `onDidChangeTreeData` event the view subscribes to for refreshes, and a
 * `findRun` lookup the data provider uses to resolve a tree handle back to a
 * run record.
 */
export class RunHistoryTreeHandler extends Disposable {

	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	private readonly _byHandle = new Map<string, IRunMetadata>();

	constructor(
		@IRunStorageService private readonly _service: IRunStorageService,
	) {
		super();

		this._reindex();
		this._register(this._service.onDidChangeRuns(() => {
			this._reindex();
			this._onDidChangeTreeData.fire();
		}));
	}

	get runs(): readonly IRunMetadata[] {
		return this._service.getRuns();
	}

	get isEmpty(): boolean {
		return this._service.getRuns().length === 0;
	}

	findRun(handle: string): IRunMetadata | undefined {
		return this._byHandle.get(handle);
	}

	private _reindex(): void {
		this._byHandle.clear();
		for (const run of this._service.getRuns()) {
			this._byHandle.set(run.traceId, run);
		}
	}
}

/**
 * Adapts {@link RunHistoryTreeHandler} to the VS Code
 * {@link ITreeViewDataProvider} contract consumed by `CustomTreeView`. Mirrors
 * `ModuleHierarchyTreeDataProvider`: maps each run to a flat `ITreeItem`
 * (no nesting), exposes `isTreeEmpty` + `onDidChangeEmpty` so the pane can
 * render its empty state, and attaches an open-detail `command` so a click
 * opens the run detail view.
 */
export class RunHistoryTreeDataProvider extends Disposable implements ITreeViewDataProvider {

	private _isEmpty = true;
	private readonly _onDidChangeEmpty = this._register(new Emitter<void>());
	readonly onDidChangeEmpty: Event<void> = this._onDidChangeEmpty.event;

	constructor(private readonly _handler: RunHistoryTreeHandler) {
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
		// Flat list: only the root level has items; runs never nest.
		if (element) {
			return [];
		}
		return this._handler.runs.map(run => this._toTreeItem(run));
	}

	private _toTreeItem(run: IRunMetadata): ITreeItem {
		const item: ITreeItem = {
			handle: run.traceId,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: run.label },
			description: describeRun(run),
			themeIcon: statusIcon(run.status),
			tooltip: localize('chipos.runs.tooltip', '{0} — {1}', run.label, run.traceId),
			command: {
				id: OPEN_RUN_DETAIL_COMMAND_ID,
				title: '',
				arguments: [run.traceId],
			},
		};
		return item;
	}
}

/** Status → list icon. Passed uses the green check; others map by severity. */
function statusIcon(status: RunStatus): ThemeIcon {
	switch (status) {
		case 'passed': return Codicon.pass;
		case 'failed': return Codicon.error;
		case 'fixed': return Codicon.tools;
		default: return Codicon.circleOutline;
	}
}

/** Builds the dimmed description, e.g. `passed · 2m ago · 3 artifacts`. */
function describeRun(run: IRunMetadata): string {
	const parts: string[] = [run.status, relativeTime(run.timestamp)];
	const artifactCount = run.artifacts.length;
	if (artifactCount > 0) {
		parts.push(artifactCount === 1
			? localize('chipos.runs.artifact.one', '{0} artifact', artifactCount)
			: localize('chipos.runs.artifact.many', '{0} artifacts', artifactCount));
	}
	return parts.join(' · ');
}

/** Coarse relative-time string (`just now`, `2m ago`, `3h ago`, `4d ago`). */
export function relativeTime(timestamp: number): string {
	const deltaMs = Math.max(0, Date.now() - timestamp);
	const seconds = Math.floor(deltaMs / 1000);
	if (seconds < 45) {
		return localize('chipos.runs.time.now', 'just now');
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return localize('chipos.runs.time.minutes', '{0}m ago', Math.max(1, minutes));
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('chipos.runs.time.hours', '{0}h ago', hours);
	}
	const days = Math.floor(hours / 24);
	return localize('chipos.runs.time.days', '{0}d ago', days);
}
