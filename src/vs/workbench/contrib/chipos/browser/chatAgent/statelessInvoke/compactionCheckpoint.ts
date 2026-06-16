/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import type { Message } from './types.js';

/**
 * A manual-`/compact` checkpoint. `summary` is the `is_compact_summary` Message
 * returned by `/api/v1/compact`; `replacedCount` is how many leading messages of
 * the freshly-assembled (uncompacted) history it stands in for.
 *
 * The stateless reasoner is stateless and the IDE re-walks the framework
 * `IChatModel` into messages every turn, so a one-shot compaction would not
 * survive a turn boundary. The checkpoint is the IDE-side state that makes
 * `/compact` durable: it is replayed on every later turn (see
 * {@link applyCompactionCheckpoint}). History is append-only in normal use, so a
 * positional `replacedCount` stays valid as new turns are added.
 */
export interface CompactionCheckpoint {
	readonly summary: Message;
	readonly replacedCount: number;
}

/**
 * Derive a checkpoint from a `/compact` result.
 *
 * @param fullLength length of the freshly-assembled (uncompacted) history at
 *   compaction time.
 * @param compacted `ConversationCompactor.compact()` output — `[summary,
 *   ...recentKept]` when it summarised something, or the input unchanged (no
 *   leading `is_compact_summary`) when there was nothing old enough to summarise.
 * @returns the checkpoint, or `undefined` when nothing was summarised.
 */
export function deriveCompactionCheckpoint(fullLength: number, compacted: Message[]): CompactionCheckpoint | undefined {
	const summary = compacted[0];
	if (!summary?.is_compact_summary) {
		return undefined;
	}
	const keptRecent = compacted.length - 1;
	const replacedCount = fullLength - keptRecent;
	if (replacedCount <= 0) {
		return undefined;
	}
	return { summary, replacedCount };
}

/**
 * Whether a checkpoint is no longer positionally valid because the history is now
 * shorter than it covered (e.g. the user edited or deleted an earlier turn). The
 * caller should drop a stale checkpoint and send the uncompacted history.
 */
export function isCheckpointStale(cp: CompactionCheckpoint, messagesLength: number): boolean {
	return messagesLength <= cp.replacedCount;
}

/**
 * Apply a (non-stale) checkpoint to a freshly-assembled history: replace the
 * leading `replacedCount` messages with the stored summary, keeping the tail
 * (recent turns + anything appended since). Caller must check
 * {@link isCheckpointStale} first.
 */
export function applyCompactionCheckpoint(cp: CompactionCheckpoint, messages: Message[]): Message[] {
	return [cp.summary, ...messages.slice(cp.replacedCount)];
}
