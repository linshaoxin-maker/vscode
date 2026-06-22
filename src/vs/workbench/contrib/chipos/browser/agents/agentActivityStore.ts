/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/** Workspace-scoped storage key holding the last turn's `{ [role]: IAgentRun }`. */
const AGENTS_STORAGE_KEY = 'chipos.agents.live';

// ── Data model ─────────────────────────────────────────────────────────────

/**
 * A single tool-lifecycle entry recorded for a sub-agent run. One activity is
 * created on each `tool_start` and resolved (`done`, optional `result`) by the
 * matching `tool_end`.
 */
export interface IAgentActivity {
	/** The tool the sub-agent invoked, e.g. `edit_file` / `verilog_lint`. */
	readonly toolName: string;
	/** Terse end-of-tool outcome (`✓ 通过`, `12 行`, …), set on `tool_end`. */
	result?: string;
	/** Epoch ms when the `tool_start` was recorded. */
	readonly ts: number;
	/** `true` once the matching `tool_end` arrived (or `markAllDone` ran). */
	done: boolean;
}

/**
 * Live activity for a single delegated sub-agent (composite role) within the
 * current turn. Keyed by `role` (the `subagentEvent.taskId`, e.g. `rtl-coder`).
 */
export interface IAgentRun {
	/** The delegated role — keys the run and names the agent in the view. */
	readonly role: string;
	/** `running` while the role is still emitting frames; `done` at round end. */
	status: 'running' | 'done';
	/** Epoch ms when the first frame for this role was recorded. */
	readonly startedAt: number;
	/** Ordered tool activities, oldest first. */
	readonly activities: IAgentActivity[];
}

// ── Service ────────────────────────────────────────────────────────────────

export const IAgentActivityStore = createDecorator<IAgentActivityStore>('chiposAgentActivityStore');

/**
 * A `subagentEvent` dispatch frame, narrowed to the fields this store consumes.
 * Mirrors the shape produced by the stateless event dispatcher.
 */
export interface IAgentActivityEvent {
	/** The delegated role, e.g. `rtl-coder` — keys the run. */
	readonly taskId: string;
	readonly kind: 'tool_start' | 'tool_end';
	readonly toolName?: string;
	/** Terse outcome carried on a `tool_end` frame. */
	readonly result?: string;
}

export interface IAgentActivityStore {
	readonly _serviceBrand: undefined;

	/** Fires after any mutation (`recordEvent` / `markAllDone` / `clear`). */
	readonly onDidChange: Event<void>;

	/** Fold a `subagentEvent` frame into the live run set. */
	recordEvent(evt: IAgentActivityEvent): void;

	/** Mark every run `done` and close any still-open activity (call at round_end). */
	markAllDone(): void;

	/** All runs for the current turn, in first-seen order. */
	getRuns(): IAgentRun[];

	/** Drop every recorded run (e.g. when a new turn starts). */
	clear(): void;
}

/**
 * In-memory, per-turn store of live sub-agent (composite-role) activity. Unlike
 * {@link IRunStorageService} this is intentionally NOT persisted: it captures
 * the transient stream of `subagentEvent` frames a composite role emits during
 * a single turn (e.g. `lint_fix_loop` → `rtl-coder`) so the Agents view can
 * render live multi-agent progress, then is cleared when the next turn begins.
 */
export class AgentActivityStore extends Disposable implements IAgentActivityStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Runs keyed by `role`, preserving first-seen insertion order. */
	private readonly _runs = new Map<string, IAgentRun>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._load();
	}

	recordEvent(evt: IAgentActivityEvent): void {
		// Guard against malformed frames — a role is required to key the run.
		if (!evt || typeof evt.taskId !== 'string' || evt.taskId.length === 0) {
			return;
		}
		const role = evt.taskId;
		const toolName = typeof evt.toolName === 'string' && evt.toolName.length > 0 ? evt.toolName : 'tool';

		if (evt.kind === 'tool_start') {
			const run = this._findOrCreateRun(role);
			run.status = 'running';
			run.activities.push({ toolName, ts: Date.now(), done: false });
			this._changed();
			return;
		}

		if (evt.kind === 'tool_end') {
			const run = this._runs.get(role);
			if (!run) {
				// No matching `tool_start` was seen — nothing to resolve.
				return;
			}
			const activity = this._lastOpenActivity(run, toolName);
			if (activity) {
				activity.done = true;
				if (typeof evt.result === 'string' && evt.result.length > 0) {
					activity.result = evt.result;
				}
				this._changed();
			}
		}
	}

	markAllDone(): void {
		if (this._runs.size === 0) {
			return;
		}
		for (const run of this._runs.values()) {
			run.status = 'done';
			for (const activity of run.activities) {
				activity.done = true;
			}
		}
		this._onDidChange.fire();
	}

	getRuns(): IAgentRun[] {
		return Array.from(this._runs.values());
	}

	clear(): void {
		if (this._runs.size === 0) {
			return;
		}
		this._runs.clear();
		this._onDidChange.fire();
	}

	/** Resolve the run for `role`, creating a fresh `running` run if absent. */
	private _findOrCreateRun(role: string): IAgentRun {
		let run = this._runs.get(role);
		if (!run) {
			run = { role, status: 'running', startedAt: Date.now(), activities: [] };
			this._runs.set(role, run);
		}
		return run;
	}

	/**
	 * Find the activity a `tool_end` should resolve: the most recent not-yet-done
	 * activity matching `toolName`, falling back to the most recent open activity
	 * of any tool (frames sometimes omit/rename the tool on the end side).
	 */
	private _lastOpenActivity(run: IAgentRun, toolName: string): IAgentActivity | undefined {
		for (let i = run.activities.length - 1; i >= 0; i--) {
			const activity = run.activities[i];
			if (!activity.done && activity.toolName === toolName) {
				return activity;
			}
		}
		for (let i = run.activities.length - 1; i >= 0; i--) {
			const activity = run.activities[i];
			if (!activity.done) {
				return activity;
			}
		}
		return undefined;
	}

	/** Fire the change event and persist the current run set (best-effort). */
	private _changed(): void {
		this._save();
		this._onDidChange.fire();
	}

	private _load(): void {
		const raw = this._storageService.get(AGENTS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const map = JSON.parse(raw) as { [role: string]: IAgentRun };
			for (const role of Object.keys(map)) {
				const run = map[role];
				if (run && typeof run.role === 'string' && Array.isArray(run.activities)) {
					this._runs.set(run.role, run);
				}
			}
			this._logService.trace('[ChipOS] Loaded', this._runs.size, 'agent run(s) from storage');
		} catch (err) {
			this._logService.warn('[ChipOS] Failed to parse persisted agent runs, starting empty:', err);
		}
	}

	private _save(): void {
		// Persist the last turn's runs so the workflow panel survives a reload
		// (and is reviewable). The in-memory map drives live updates; this is a
		// snapshot, intentionally WORKSPACE-scoped and machine-local.
		if (this._runs.size === 0) {
			this._storageService.store(AGENTS_STORAGE_KEY, '{}', StorageScope.WORKSPACE, StorageTarget.MACHINE);
			return;
		}
		const map: { [role: string]: IAgentRun } = {};
		for (const [role, run] of this._runs) {
			map[role] = run;
		}
		this._storageService.store(AGENTS_STORAGE_KEY, JSON.stringify(map), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerSingleton(IAgentActivityStore, AgentActivityStore, InstantiationType.Delayed);
