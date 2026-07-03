/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * §2.9 addendum — orphan in-flight turn sweep. Locks the pure selection
 * semantics: which stored threads get a startup turn_state probe when no chat
 * model exists for them (crash / hard reload lost the un-persisted thread), and
 * which in-flight trace a turn_state response actually offers for resume.
 */

import assert from 'assert';
import { planOrphanSweep, pickResumableTrace } from '../orphanTurnSweep.js';
import type { InFlightTrace } from '../types.js';

const NONE = new Set<string>();

suite('planOrphanSweep', () => {

	test('selects stored threads with no live model, NEWEST first', () => {
		// The map appends at first invoke → tail = most recent thread = the one
		// most likely to still be in flight. It must come out first.
		const out = planOrphanSweep({
			storedMap: { 'res://a': 'cs-a', 'res://b': 'cs-b' },
			probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 8,
		});
		assert.deepStrictEqual(out, [
			{ resourceKey: 'res://b', chatSessionId: 'cs-b' },
			{ resourceKey: 'res://a', chatSessionId: 'cs-a' },
		]);
	});

	test('probe budget spends itself on the newest threads, not ancient history', () => {
		const storedMap: Record<string, string> = {};
		for (let i = 0; i < 12; i++) { storedMap[`res://${i}`] = `cs-${i}`; }
		const out = planOrphanSweep({ storedMap, probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 3 });
		assert.deepStrictEqual(out.map(c => c.chatSessionId), ['cs-11', 'cs-10', 'cs-9']);
	});

	test('dedups by chat_session_id — one prompt per conversation', () => {
		// A cs can transiently map from two resource keys (e.g. after an orphan
		// re-point); probing both would double-prompt the same turn.
		const out = planOrphanSweep({
			storedMap: { 'res://old': 'cs-x', 'res://new': 'cs-x' },
			probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 8,
		});
		assert.deepStrictEqual(out, [{ resourceKey: 'res://new', chatSessionId: 'cs-x' }]);
	});

	test('skips threads the restore probe already handled', () => {
		const out = planOrphanSweep({
			storedMap: { 'res://a': 'cs-a', 'res://b': 'cs-b' },
			probedKeys: new Set(['res://b']), liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 8,
		});
		assert.deepStrictEqual(out.map(c => c.resourceKey), ['res://a']);
	});

	test('skips threads whose model exists — the model-probe path owns them', () => {
		// A gracefully-restored thread fires onDidCreateModel; sweeping it too
		// would double-prompt the user.
		const out = planOrphanSweep({
			storedMap: { 'res://a': 'cs-a', 'res://b': 'cs-b' },
			probedKeys: NONE, liveModelKeys: new Set(['res://b']), activeTraceKeys: NONE, maxProbes: 8,
		});
		assert.deepStrictEqual(out.map(c => c.resourceKey), ['res://a']);
	});

	test('skips threads with a live invoke in this process', () => {
		const out = planOrphanSweep({
			storedMap: { 'res://a': 'cs-a' },
			probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: new Set(['res://a']), maxProbes: 8,
		});
		assert.deepStrictEqual(out, []);
	});

	test('caps candidates at maxProbes (no startup probe storm)', () => {
		const storedMap: Record<string, string> = {};
		for (let i = 0; i < 20; i++) { storedMap[`res://${i}`] = `cs-${i}`; }
		const out = planOrphanSweep({ storedMap, probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 8 });
		assert.strictEqual(out.length, 8);
	});

	test('drops malformed map entries (empty / non-string ids)', () => {
		const out = planOrphanSweep({
			storedMap: { 'res://a': '', 'res://b': 42 as unknown as string, 'res://c': 'cs-c' },
			probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 8,
		});
		assert.deepStrictEqual(out.map(c => c.chatSessionId), ['cs-c']);
	});

	test('empty map → empty plan', () => {
		assert.deepStrictEqual(
			planOrphanSweep({ storedMap: {}, probedKeys: NONE, liveModelKeys: NONE, activeTraceKeys: NONE, maxProbes: 8 }),
			[],
		);
	});
});

suite('pickResumableTrace', () => {

	const t = (id: string, startedAt: number, state: InFlightTrace['state'] = 'running'): InFlightTrace =>
		({ trace_id: id, started_at: startedAt, state });

	test('picks the most recently started trace', () => {
		assert.strictEqual(pickResumableTrace([t('old', 1), t('new', 9), t('mid', 5)], NONE)?.trace_id, 'new');
	});

	test('filters discarded traces — a user "丢弃" must never be re-offered', () => {
		// The reasoner may keep reporting a discarded trace (cancel can fail or a
		// stale replica lingers); re-offering it makes discard feel broken.
		assert.strictEqual(pickResumableTrace([t('a', 1), t('b', 9)], new Set(['b']))?.trace_id, 'a');
		assert.strictEqual(pickResumableTrace([t('b', 9)], new Set(['b'])), undefined);
	});

	test('undefined / empty input → undefined', () => {
		assert.strictEqual(pickResumableTrace(undefined, NONE), undefined);
		assert.strictEqual(pickResumableTrace([], NONE), undefined);
	});

	test('equal started_at ties break toward the later entry (stable reduce)', () => {
		assert.strictEqual(pickResumableTrace([t('first', 5), t('second', 5)], NONE)?.trace_id, 'second');
	});
});
