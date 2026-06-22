/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Workspace-scoped storage key holding the `{ [key]: IPpaSnapshot }` map. */
const PPA_STORAGE_KEY = 'chipos.ppa';

/** Hard cap on retained PPA snapshots — the oldest are evicted past this. */
const MAX_PPA = 200;

// ── Data model ─────────────────────────────────────────────────────────────

/**
 * A single PPA (Power / Performance / Area) measurement vector. Mirrors the
 * shape of `IChatEdaPpaMetrics` but is deliberately re-declared here so the
 * snapshot stays self-contained and JSON-serialisable.
 */
export interface IPpaMetrics {
	readonly area?: number;
	readonly delay_ns?: number;
	readonly power_w?: number;
	readonly wns?: number;
	readonly tns?: number;
}

/**
 * Persisted record for a single captured PPA optimization step. This is the
 * canonical record the PPA sidebar list and the PPA detail dashboard render; it
 * is intentionally a plain, JSON-serialisable shape so it round-trips through
 * `IStorageService` (note we do not import `IChatEdaPpaReport` here — this
 * snapshot is decoupled from the wire/chat types on purpose).
 */
export interface IPpaSnapshot {
	readonly traceId: string;
	readonly round?: number;
	readonly stage: string;
	readonly strategy?: string;
	readonly timestamp: number;
	readonly current?: IPpaMetrics;
	readonly baseline?: IPpaMetrics;
	readonly best?: IPpaMetrics;
	readonly improvement?: Record<string, number>;
}

// ── Service ────────────────────────────────────────────────────────────────

export const IPpaStorageService = createDecorator<IPpaStorageService>('chiposPpaStorageService');

export interface IPpaStorageService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the persisted PPA set changes (save/clear). */
	readonly onDidChange: Event<void>;

	/** All retained PPA snapshots, most-recent first. */
	getReports(): IPpaSnapshot[];

	/** Look up a single snapshot by its `${traceId}#${round ?? 0}` key. */
	getReport(key: string): IPpaSnapshot | undefined;

	/** Insert or replace a snapshot (keyed by `${traceId}#${round ?? 0}`) and persist. */
	savePpa(snapshot: IPpaSnapshot): void;

	/** Drop every retained snapshot and persist the empty set. */
	clear(): void;
}

/** Build the stable map key for a snapshot. */
function snapshotKey(snapshot: IPpaSnapshot): string {
	return `${snapshot.traceId}#${snapshot.round ?? 0}`;
}

/**
 * Workspace-scoped, machine-local store for captured PPA snapshots. Backed by
 * {@link IStorageService} under {@link PPA_STORAGE_KEY}: the in-memory map is
 * hydrated in the constructor and re-serialised on every mutation. The store
 * is intentionally small and synchronous — callers treat it as a cache the
 * sidebar reads from.
 */
export class PpaStorageService extends Disposable implements IPpaStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _reports = new Map<string, IPpaSnapshot>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._load();
	}

	getReports(): IPpaSnapshot[] {
		return Array.from(this._reports.values()).sort((a, b) => b.timestamp - a.timestamp);
	}

	getReport(key: string): IPpaSnapshot | undefined {
		return this._reports.get(key);
	}

	savePpa(snapshot: IPpaSnapshot): void {
		this._reports.set(snapshotKey(snapshot), snapshot);
		this._evictOldest();
		this._save();
		this._onDidChange.fire();
	}

	clear(): void {
		if (this._reports.size === 0) {
			return;
		}
		this._reports.clear();
		this._save();
		this._onDidChange.fire();
	}

	/** Evict the oldest snapshots until the map is within {@link MAX_PPA}. */
	private _evictOldest(): void {
		if (this._reports.size <= MAX_PPA) {
			return;
		}
		// Oldest first so we drop the right tail.
		const ordered = Array.from(this._reports.values()).sort((a, b) => a.timestamp - b.timestamp);
		for (const snapshot of ordered) {
			if (this._reports.size <= MAX_PPA) {
				break;
			}
			this._reports.delete(snapshotKey(snapshot));
		}
	}

	private _load(): void {
		const raw = this._storageService.get(PPA_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const map = JSON.parse(raw) as { [key: string]: IPpaSnapshot };
			for (const key of Object.keys(map)) {
				const snapshot = map[key];
				if (snapshot && typeof snapshot.traceId === 'string' && typeof snapshot.stage === 'string') {
					this._reports.set(snapshotKey(snapshot), snapshot);
				}
			}
			this._logService.trace('[ChipOS] Loaded', this._reports.size, 'PPA snapshot(s) from storage');
		} catch (err) {
			this._logService.warn('[ChipOS] Failed to parse persisted PPA snapshots, starting empty:', err);
		}
	}

	private _save(): void {
		const map: { [key: string]: IPpaSnapshot } = {};
		for (const [key, snapshot] of this._reports) {
			map[key] = snapshot;
		}
		this._storageService.store(PPA_STORAGE_KEY, JSON.stringify(map), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
