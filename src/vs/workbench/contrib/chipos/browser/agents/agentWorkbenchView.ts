/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../../../workbench/common/views.js';
import { IAgentActivity, IAgentActivityStore, IAgentRun } from './agentActivityStore.js';

/** Stable handle prefix for a run (role) row — distinguishes it from activity rows. */
const ROLE_HANDLE_PREFIX = 'chipos.agent.role::';

/**
 * Thin handler over {@link IAgentActivityStore} that mirrors
 * {@link RunHistoryTreeHandler} / {@link ModuleHierarchyTreeHandler}: it exposes
 * the current run list plus an `onDidChangeTreeData` event the view subscribes
 * to for refreshes, and a `findRun` lookup the data provider uses to resolve a
 * tree handle back to a run record.
 */
export class AgentWorkbenchTreeHandler extends Disposable {

	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	private readonly _byHandle = new Map<string, IAgentRun>();

	constructor(
		@IAgentActivityStore private readonly _service: IAgentActivityStore,
	) {
		super();

		this._reindex();
		this._register(this._service.onDidChange(() => {
			this._reindex();
			this._onDidChangeTreeData.fire();
		}));
	}

	get runs(): readonly IAgentRun[] {
		return this._service.getRuns();
	}

	get isEmpty(): boolean {
		return this._service.getRuns().length === 0;
	}

	findRun(handle: string): IAgentRun | undefined {
		return this._byHandle.get(handle);
	}

	private _reindex(): void {
		this._byHandle.clear();
		for (const run of this._service.getRuns()) {
			this._byHandle.set(ROLE_HANDLE_PREFIX + run.role, run);
		}
	}
}

/**
 * Adapts {@link AgentWorkbenchTreeHandler} to the VS Code
 * {@link ITreeViewDataProvider} contract consumed by `CustomTreeView`. Mirrors
 * `ModuleHierarchyTreeDataProvider`: a 2-level tree where the root level lists
 * one row per sub-agent run (role) and each run expands to its tool activities.
 * Exposes `isTreeEmpty` + `onDidChangeEmpty` so the pane can render its empty
 * state.
 */
export class AgentWorkbenchTreeDataProvider extends Disposable implements ITreeViewDataProvider {

	private _isEmpty = true;
	private readonly _onDidChangeEmpty = this._register(new Emitter<void>());
	readonly onDidChangeEmpty: Event<void> = this._onDidChangeEmpty.event;

	constructor(private readonly _handler: AgentWorkbenchTreeHandler) {
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
		// Root level → one row per sub-agent run.
		if (!element) {
			return this._handler.runs.map(run => this._toRunItem(run));
		}
		// Run row → its tool activities (the only nesting level).
		const run = this._handler.findRun(element.handle);
		if (run) {
			return run.activities.map(activity => this._toActivityItem(activity));
		}
		return [];
	}

	/** Top-level row for a sub-agent run: role name + status/action count. */
	private _toRunItem(run: IAgentRun): ITreeItem {
		const description = run.status === 'running'
			? localize('chipos.agents.run.running', 'running · {0} actions', run.activities.length)
			: localize('chipos.agents.run.done', 'done · {0} actions', run.activities.length);

		return {
			handle: ROLE_HANDLE_PREFIX + run.role,
			collapsibleState: TreeItemCollapsibleState.Expanded,
			label: { label: run.role },
			description,
			themeIcon: run.status === 'running' ? Codicon.hubot : Codicon.pass,
			tooltip: localize('chipos.agents.run.tooltip', '{0} — {1}', run.role, description),
		};
	}

	/** Child row for a single tool activity: tool name + outcome/spinner badge. */
	private _toActivityItem(activity: IAgentActivity): ITreeItem {
		const description = activity.result ?? (activity.done
			? localize('chipos.agents.activity.done', '✓')
			: localize('chipos.agents.activity.pending', '…'));

		return {
			handle: `${ROLE_HANDLE_PREFIX}${activity.toolName}::${activity.ts}`,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: activity.toolName },
			description,
			themeIcon: activityIcon(activity),
			tooltip: localize('chipos.agents.activity.tooltip', '{0} — {1}', activity.toolName, description),
		};
	}
}

/** Activity → row icon: a green check once done, otherwise the in-progress gear. */
function activityIcon(activity: IAgentActivity): ThemeIcon {
	return activity.done ? Codicon.check : Codicon.gear;
}
