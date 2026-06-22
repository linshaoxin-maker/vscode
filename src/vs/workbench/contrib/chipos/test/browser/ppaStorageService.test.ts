/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IPpaSnapshot, PpaStorageService } from '../../../../../workbench/contrib/chipos/browser/ppa/ppaStorageService.js';

function snapshot(over: Partial<IPpaSnapshot> & Pick<IPpaSnapshot, 'traceId' | 'stage' | 'timestamp'>): IPpaSnapshot {
	return { strategy: 'pareto-sweep', ...over };
}

suite('PpaStorageService — Phase 6 Timing/PPA view persistence', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('savePpa persists and a fresh instance reloads the snapshot (the load path)', () => {
		const storage = ds.add(new TestStorageService());
		const log = new NullLogService();

		const writer = ds.add(new PpaStorageService(storage, log));
		writer.savePpa(snapshot({
			traceId: 't1', round: 2, stage: 'improved', timestamp: 100,
			baseline: { area: 200, delay_ns: 3.2 }, current: { area: 100, delay_ns: 2.9 }, best: { area: 100, delay_ns: 2.9 },
			improvement: { area: 50 },
		}));

		// A second instance over the SAME storage re-runs `_load()` in its ctor —
		// this is exactly the reboot path that re-populates the view on startup.
		const reader = ds.add(new PpaStorageService(storage, log));
		assert.deepStrictEqual(reader.getReports(), [
			snapshot({
				traceId: 't1', round: 2, stage: 'improved', timestamp: 100,
				baseline: { area: 200, delay_ns: 3.2 }, current: { area: 100, delay_ns: 2.9 }, best: { area: 100, delay_ns: 2.9 },
				improvement: { area: 50 },
			}),
		]);
	});

	test('getReports returns newest-first; per-round snapshots key independently', () => {
		const store = ds.add(new PpaStorageService(ds.add(new TestStorageService()), new NullLogService()));
		store.savePpa(snapshot({ traceId: 't1', round: 0, stage: 'baseline', timestamp: 10 }));
		store.savePpa(snapshot({ traceId: 't1', round: 1, stage: 'eval_round', timestamp: 30 }));
		store.savePpa(snapshot({ traceId: 't1', round: 2, stage: 'improved', timestamp: 20 }));

		assert.deepStrictEqual(store.getReports().map(r => ({ round: r.round, ts: r.timestamp })), [
			{ round: 1, ts: 30 },
			{ round: 2, ts: 20 },
			{ round: 0, ts: 10 },
		]);
	});

	test('clear empties the store and the persisted backing', () => {
		const storage = ds.add(new TestStorageService());
		const log = new NullLogService();
		const store = ds.add(new PpaStorageService(storage, log));
		store.savePpa(snapshot({ traceId: 't1', round: 0, stage: 'baseline', timestamp: 10 }));
		store.clear();

		assert.deepStrictEqual(store.getReports(), []);
		assert.deepStrictEqual(ds.add(new PpaStorageService(storage, log)).getReports(), []);
	});
});
