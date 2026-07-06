/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { planWorkerAutoRestart, shouldRecycleWorker } from '../../common/workerAutoRestart.js';

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

	test('defaults are patient: 2s base / 30s cap / 10 attempts', () => {
		assert.deepStrictEqual(
			{ first: planWorkerAutoRestart(0), capped: planWorkerAutoRestart(4), exhausted: planWorkerAutoRestart(10) },
			{ first: { delayMs: 2000, nextAttempt: 1 }, capped: { delayMs: 30000, nextAttempt: 5 }, exhausted: null },
		);
	});
});

/** ①a worker 健康换新 decision (long-running / churned + idle → recycle). */
suite('shouldRecycleWorker', () => {
	const T = { maxUptimeMs: 4 * 3600_000, maxDisconnectCount: 20 };
	const decide = (snap: Parameters<typeof shouldRecycleWorker>[0], t?: Parameters<typeof shouldRecycleWorker>[1]): 'recycle' | null =>
		shouldRecycleWorker(snap, t) === null ? null : 'recycle';

	test('recycles old/idle, churned/idle or stdio-exhausted/idle; never a busy worker; honours disable knobs', () => {
		assert.deepStrictEqual(
			[
				decide({ uptimeMs: 5 * 3600_000, runningTasks: 0 }, T),                        // old + idle → uptime
				decide({ uptimeMs: 60_000, runningTasks: 0 }, T),                              // young + idle
				decide({ uptimeMs: 99 * 3600_000, runningTasks: 1, disconnectCount: 999 }, T), // busy (idle gate)
				decide({ uptimeMs: 60_000, runningTasks: 0, disconnectCount: 25 }, T),         // churned + idle → disconnect
				decide({ uptimeMs: 60_000, runningTasks: 0, disconnectCount: 5 }, T),          // under disconnect threshold
				decide({ uptimeMs: 60_000, runningTasks: 0 }, T),                              // missing count → treated as 0
				decide({ uptimeMs: 68 * 60_000, runningTasks: 0, disconnectCount: 0, mcpStdioExhaustedCount: 1 }, T), // ①c live mode: young + 0 disconnects + exhausted → recycle
				decide({ uptimeMs: 60_000, runningTasks: 1, mcpStdioExhaustedCount: 9 }, T),   // exhausted but busy (idle gate)
				decide({ uptimeMs: 60_000, runningTasks: 0, disconnectCount: 0 }, T),          // missing exhausted count → treated as 0
				decide({ uptimeMs: 99 * 3600_000, runningTasks: 0 }, { maxUptimeMs: 0, maxDisconnectCount: 20 }),                  // uptime disabled
				decide({ uptimeMs: 60_000, runningTasks: 0, disconnectCount: 999 }, { maxUptimeMs: 4 * 3600_000, maxDisconnectCount: 0 }), // disconnect disabled
				decide({ uptimeMs: 60_000, runningTasks: 0, mcpStdioExhaustedCount: 9 }, { maxMcpStdioExhausted: 0 }),             // stdio-exhaustion disabled
			],
			['recycle', null, null, 'recycle', null, null, 'recycle', null, null, null, null, null],
		);
	});

	test('default thresholds: 4h uptime / 20 reconnects / 1 stdio-exhaustion', () => {
		assert.deepStrictEqual(
			{
				youngIdle: shouldRecycleWorker({ uptimeMs: 60_000, runningTasks: 0 }),
				old: shouldRecycleWorker({ uptimeMs: 5 * 3600_000, runningTasks: 0 }) !== null,
				churned: shouldRecycleWorker({ uptimeMs: 60_000, runningTasks: 0, disconnectCount: 20 }) !== null,
				stdioExhausted: shouldRecycleWorker({ uptimeMs: 60_000, runningTasks: 0, mcpStdioExhaustedCount: 1 }) !== null,
			},
			{ youngIdle: null, old: true, churned: true, stdioExhausted: true },
		);
	});
});
