/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * PHASE-1 §2.9 addendum — ORPHAN in-flight turn sweep (startup, model-less).
 *
 * The restore-triggered resume probe (`_maybeProbeInFlightTurn`) only fires when
 * a chat model is CREATED — i.e. when the framework restores the thread. But
 * thread content is persisted only on graceful shutdown (`onWillSaveState` →
 * `saveState`, chatServiceImpl), so after a crash / hard reload the thread never
 * reaches disk, the chat view falls back to a fresh session, no model for the
 * old thread is ever created, and the probe never runs — the user gets ZERO
 * hint that the reasoner is still running their turn.
 *
 * ChipOS's own sessionResource→chat_session_id map however IS durable (written
 * at invoke start via IStorageService, which flushes independently of the chat
 * session store). This module plans a startup sweep over that map: which stored
 * threads deserve a GET /turn_state probe even though no model exists for them.
 *
 * Pure functions (no DI, no I/O) so the selection semantics are unit-testable;
 * the agent supplies snapshots of its runtime state.
 */

import { InFlightTrace } from './types.js';

export interface OrphanSweepCandidate {
	/** `sessionResource.toString()` key as stored in the CSID map. */
	readonly resourceKey: string;
	readonly chatSessionId: string;
}

export interface OrphanSweepInput {
	/** Persisted sessionResource-key → chat_session_id map (survives restarts). */
	readonly storedMap: Readonly<Record<string, string>>;
	/** Threads the restore-triggered probe already handled this run. */
	readonly probedKeys: ReadonlySet<string>;
	/** Resource keys of chat models that exist right now — the framework
	 *  restored (or is showing) these threads, so the model-probe owns them. */
	readonly liveModelKeys: ReadonlySet<string>;
	/** Resource keys with an invoke live in THIS process (never orphans). */
	readonly activeTraceKeys: ReadonlySet<string>;
	/** Probe budget: cap on candidates returned (startup network cost). */
	readonly maxProbes: number;
}

/**
 * Select stored threads that could hold an orphaned in-flight turn: they have a
 * durable chat_session_id but NO live model (so `onDidCreateModel` will not
 * cover them), no live invoke, and were not already probed. Newest first: the
 * map appends at first invoke, so its TAIL holds the most recent threads — the
 * ones most likely to still be in flight — and the probe budget must spend
 * itself on those, not on ancient history. One candidate per chat_session_id
 * (a cs can transiently map from two resource keys, e.g. after a re-point).
 */
export function planOrphanSweep(input: OrphanSweepInput): OrphanSweepCandidate[] {
	const out: OrphanSweepCandidate[] = [];
	const seenSessionIds = new Set<string>();
	for (const [resourceKey, chatSessionId] of Object.entries(input.storedMap).reverse()) {
		if (out.length >= input.maxProbes) {
			break;
		}
		if (!chatSessionId || typeof chatSessionId !== 'string') {
			continue;
		}
		if (seenSessionIds.has(chatSessionId)) {
			continue; // one probe (and at most one prompt) per conversation
		}
		if (input.probedKeys.has(resourceKey)) {
			continue;
		}
		if (input.liveModelKeys.has(resourceKey)) {
			continue; // framework restored it — the model-probe path owns this thread
		}
		if (input.activeTraceKeys.has(resourceKey)) {
			continue; // an invoke is live for it in this very process
		}
		seenSessionIds.add(chatSessionId);
		out.push({ resourceKey, chatSessionId });
	}
	return out;
}

/**
 * From a turn_state response pick the trace worth offering to resume: drop
 * traces the user already discarded (a reasoner may keep reporting them —
 * cancel can fail / a stale replica copy lingers), then take the most recently
 * started. Returns undefined when nothing is offerable. Shared by the
 * restore-triggered probe and the orphan sweep so both paths cannot drift.
 */
export function pickResumableTrace(
	traces: ReadonlyArray<InFlightTrace> | undefined,
	discardedTraceIds: ReadonlySet<string>,
): InFlightTrace | undefined {
	const live = (traces ?? []).filter(t => !discardedTraceIds.has(t.trace_id));
	if (live.length === 0) {
		return undefined;
	}
	return live.reduce((a, b) => (b.started_at >= a.started_at ? b : a));
}
