/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChiposHookLogService, HookLogEntry } from '../chiposHookLogService.js';

/** FEAT-004 B6 — the executable-hook audit-trail ring buffer. */
suite('ChiposHookLogService (FEAT-004 B6)', () => {

	const entry = (over: Partial<HookLogEntry>): HookLogEntry => ({
		at: 1, pluginId: 'p', point: 'tool.before_dispatch', toolName: 'ls', decision: 'deny', ...over,
	});

	test('records newest-first and starts empty', () => {
		const svc = new ChiposHookLogService();
		const before = svc.recent().length;
		svc.record(entry({ at: 1, toolName: 'a' }));
		svc.record(entry({ at: 2, toolName: 'b' }));
		assert.deepStrictEqual(
			{ before, order: svc.recent().map(e => e.toolName) },
			{ before: 0, order: ['b', 'a'] },
		);
	});

	test('caps at 200 (oldest dropped)', () => {
		const svc = new ChiposHookLogService();
		for (let i = 0; i < 205; i++) {
			svc.record(entry({ at: i, toolName: `t${i}` }));
		}
		const recent = svc.recent();
		assert.deepStrictEqual(
			{ len: recent.length, newest: recent[0].toolName, oldestKept: recent[recent.length - 1].toolName },
			{ len: 200, newest: 't204', oldestKept: 't5' },
		);
	});
});
