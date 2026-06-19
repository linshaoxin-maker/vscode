/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Workspace-scoped storage key holding the `{ [traceId]: IRunMetadata }` map. */
const RUNS_STORAGE_KEY = 'chipos.runs';

/** Hard cap on retained runs — the oldest are evicted past this. */
const MAX_RUNS = 200;

// ── Data model ─────────────────────────────────────────────────────────────

/** Verdict-style outcome of a captured run. */
export type RunStatus = 'passed' | 'failed' | 'fixed' | 'unknown';

/** A produced artifact (report, waveform, log, …) referenced by a run. */
export interface IRunArtifact {
	readonly kind: string;
	readonly uri?: string;
	readonly summary?: string;
}

/** A file touched during a run, with optional churn counts. */
export interface IRunChangedFile {
	readonly path: string;
	readonly added?: number;
	readonly removed?: number;
}

/** A structured error surfaced by a run. */
export interface IRunError {
	readonly category?: string;
	readonly code?: string;
	readonly message: string;
}

/**
 * Persisted metadata for a single captured run. This is the canonical record
 * the Runs sidebar list and the run detail view render; it is intentionally a
 * plain, JSON-serialisable shape so it round-trips through `IStorageService`.
 */
export interface IRunMetadata {
	readonly traceId: string;
	readonly sessionId: string;
	readonly timestamp: number;
	readonly label: string;
	readonly status: RunStatus;
	readonly verdictSummary?: string;
	readonly durationMs?: number;
	readonly tool?: string;
	readonly artifacts: IRunArtifact[];
	readonly changedFiles: IRunChangedFile[];
	readonly errors?: IRunError[];
}

// ── Service ────────────────────────────────────────────────────────────────

export const IRunStorageService = createDecorator<IRunStorageService>('chiposRunStorageService');

export interface IRunStorageService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the persisted run set changes (save/delete/clear). */
	readonly onDidChangeRuns: Event<void>;

	/** All retained runs, most-recent first. */
	getRuns(): IRunMetadata[];

	/** Look up a single run by its trace id. */
	getRun(traceId: string): IRunMetadata | undefined;

	/** Insert or replace a run (keyed by `traceId`) and persist. */
	saveRun(run: IRunMetadata): void;

	/** Remove a single run by trace id and persist. */
	deleteRun(traceId: string): void;

	/** Drop every retained run and persist the empty set. */
	clear(): void;
}

/**
 * Workspace-scoped, machine-local store for captured runs. Backed by
 * {@link IStorageService} under {@link RUNS_STORAGE_KEY}: the in-memory map is
 * hydrated in the constructor and re-serialised on every mutation. The store
 * is intentionally small and synchronous — callers treat it as a cache the
 * sidebar reads from.
 */
export class RunStorageService extends Disposable implements IRunStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns: Event<void> = this._onDidChangeRuns.event;

	private readonly _runs = new Map<string, IRunMetadata>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._load();
	}

	getRuns(): IRunMetadata[] {
		return Array.from(this._runs.values()).sort((a, b) => b.timestamp - a.timestamp);
	}

	getRun(traceId: string): IRunMetadata | undefined {
		return this._runs.get(traceId);
	}

	saveRun(run: IRunMetadata): void {
		this._runs.set(run.traceId, run);
		this._evictOldest();
		this._save();
		this._onDidChangeRuns.fire();
	}

	deleteRun(traceId: string): void {
		if (this._runs.delete(traceId)) {
			this._save();
			this._onDidChangeRuns.fire();
		}
	}

	clear(): void {
		if (this._runs.size === 0) {
			return;
		}
		this._runs.clear();
		this._save();
		this._onDidChangeRuns.fire();
	}

	/** Evict the oldest runs until the map is within {@link MAX_RUNS}. */
	private _evictOldest(): void {
		if (this._runs.size <= MAX_RUNS) {
			return;
		}
		// Oldest first so we drop the right tail.
		const ordered = Array.from(this._runs.values()).sort((a, b) => a.timestamp - b.timestamp);
		for (const run of ordered) {
			if (this._runs.size <= MAX_RUNS) {
				break;
			}
			this._runs.delete(run.traceId);
		}
	}

	private _load(): void {
		const raw = this._storageService.get(RUNS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const map = JSON.parse(raw) as { [traceId: string]: IRunMetadata };
			for (const traceId of Object.keys(map)) {
				const run = map[traceId];
				if (run && typeof run.traceId === 'string') {
					this._runs.set(run.traceId, run);
				}
			}
			this._logService.trace('[ChipOS] Loaded', this._runs.size, 'run(s) from storage');
		} catch (err) {
			this._logService.warn('[ChipOS] Failed to parse persisted runs, starting empty:', err);
		}
	}

	private _save(): void {
		const map: { [traceId: string]: IRunMetadata } = {};
		for (const [traceId, run] of this._runs) {
			map[traceId] = run;
		}
		this._storageService.store(RUNS_STORAGE_KEY, JSON.stringify(map), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
