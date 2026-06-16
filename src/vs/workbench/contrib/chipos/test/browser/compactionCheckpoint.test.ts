/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	applyCompactionCheckpoint,
	deriveCompactionCheckpoint,
	isCheckpointStale,
} from '../../../../../workbench/contrib/chipos/browser/chatAgent/statelessInvoke/compactionCheckpoint.js';
import type { Message } from '../../../../../workbench/contrib/chipos/browser/chatAgent/statelessInvoke/types.js';

suite('CompactionCheckpoint — /compact persistence math', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const user = (content: string): Message => ({ role: 'user', content });
	const asst = (content: string): Message => ({ role: 'assistant', content });
	const summary = (content = 'summary'): Message => ({ role: 'user', content, is_compact_summary: true });

	test('derive: summarised result → checkpoint with replacedCount = full - kept', () => {
		// Full history had 5 messages; compact kept the last 2 and made a summary.
		const compacted = [summary(), user('q3'), asst('a3')];
		const cp = deriveCompactionCheckpoint(5, compacted);
		assert.ok(cp);
		assert.strictEqual(cp.replacedCount, 3); // 5 full - 2 kept
		assert.strictEqual(cp.summary.is_compact_summary, true);
	});

	test('derive: nothing summarised (no leading summary) → undefined', () => {
		const compacted = [user('q1'), asst('a1')]; // compact() returned input unchanged
		assert.strictEqual(deriveCompactionCheckpoint(2, compacted), undefined);
	});

	test('derive: non-positive replacedCount → undefined (guard)', () => {
		// kept >= full would replace nothing — must not yield a checkpoint.
		const compacted = [summary(), user('q1'), asst('a1')]; // kept = 2
		assert.ok(deriveCompactionCheckpoint(3, compacted));         // 3 - 2 = 1 > 0 → valid
		assert.strictEqual(deriveCompactionCheckpoint(2, compacted), undefined); // 2 - 2 = 0
		assert.strictEqual(deriveCompactionCheckpoint(1, compacted), undefined); // 1 - 2 < 0
	});

	test('apply: replaces leading replacedCount messages with the summary', () => {
		const cp = { summary: summary('S'), replacedCount: 3 };
		const messages = [user('q1'), asst('a1'), user('q2'), asst('a2'), user('q3')];
		const out = applyCompactionCheckpoint(cp, messages);
		assert.deepStrictEqual(out.map(m => m.content), ['S', 'a2', 'q3']);
		assert.strictEqual(out[0].is_compact_summary, true);
	});

	test('stale: history shorter than the summary covers → stale', () => {
		const cp = { summary: summary(), replacedCount: 3 };
		assert.strictEqual(isCheckpointStale(cp, 2), true);
		assert.strictEqual(isCheckpointStale(cp, 3), true);  // == replacedCount: nothing left to keep
		assert.strictEqual(isCheckpointStale(cp, 4), false); // one recent message survives
	});

	test('round-trip: append-only growth keeps the checkpoint valid', () => {
		// /compact time: full history of 5; keep last 2; summarise the first 3.
		const fullAtCompact = [user('q1'), asst('a1'), user('q2'), asst('a2'), user('q3')];
		const compacted = [summary('S'), asst('a2'), user('q3')]; // compactor kept last 2
		const cp = deriveCompactionCheckpoint(fullAtCompact.length, compacted);
		assert.ok(cp);
		assert.strictEqual(cp.replacedCount, 3);

		// A later turn: history grew append-only by 2 messages.
		const grown = [...fullAtCompact, asst('a3'), user('q4')];
		assert.strictEqual(isCheckpointStale(cp, grown.length), false);
		const sent = applyCompactionCheckpoint(cp, grown);
		// Effective context = summary + everything after the summarised prefix.
		assert.deepStrictEqual(sent.map(m => m.content), ['S', 'a2', 'q3', 'a3', 'q4']);
	});
});
