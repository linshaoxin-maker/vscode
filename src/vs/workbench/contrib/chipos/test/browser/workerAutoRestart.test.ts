/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { planWorkerAutoRestart } from '../../common/workerAutoRestart.js';

/** Self-heal backoff for a dropped local worker (FEAT worker auto-restart). */
suite('workerAutoRestart', () => {

	test('exponential backoff capped at capMs, then gives up at maxAttempts', () => {
		const opts = { baseMs: 1000, capMs: 16000, maxAttempts: 5 };
		assert.deepStrictEqual(
			[0, 1, 2, 3, 4, 5].map(a => planWorkerAutoRestart(a, opts)),
			[
				{ delayMs: 1000, nextAttempt: 1 },
				{ delayMs: 2000, nextAttempt: 2 },
				{ delayMs: 4000, nextAttempt: 3 },
				{ delayMs: 8000, nextAttempt: 4 },
				{ delayMs: 16000, nextAttempt: 5 },   // 1000*2^4 = 16000, hits the cap
				null,                                   // attempt 5 >= maxAttempts 5 → stop, fall back to manual
			],
		);
	});

	test('defaults are 1s base / 16s cap / 5 attempts', () => {
		assert.deepStrictEqual(
			{ first: planWorkerAutoRestart(0), capped: planWorkerAutoRestart(4), exhausted: planWorkerAutoRestart(5) },
			{ first: { delayMs: 1000, nextAttempt: 1 }, capped: { delayMs: 16000, nextAttempt: 5 }, exhausted: null },
		);
	});
});
