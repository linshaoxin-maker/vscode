/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ADR-018 resume-from-break — locks the resumability→button-variant mapping
 * that decides whether a terminal stateless failure offers a PRIMARY
 * "继续 (从中断处)" (continue, true) or only a "Retry"/resend (false).
 *
 * The function is pure (no DI, no I/O); these tests traverse every verdict the
 * chipOSChatAgent.ts retryLoop catch can hand it.
 */

import assert from 'assert';
import { isStatelessTurnResumable } from '../statelessResumability.js';

suite('isStatelessTurnResumable', () => {

	test('resumable cases — continue-from-break offered', () => {
		// surface-other (unknown / network shape) → optimistic continue.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-other' }), true);
		// auto-resume exhausted its transient retries → turn likely still live.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'replay' }), true);
		// surface-http 5xx → transient server fault.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-http', httpStatus: 500 }), true);
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-http', httpStatus: 502 }), true);
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-http', httpStatus: 503 }), true);
	});

	test('non-resumable cases — resend only', () => {
		// 410 buffer expired (top-level or during resume) → cannot continue.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-replay-expired' }), false);
		// /resume 404 — turn is gone server-side.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'replay', resumeNotFound: true }), false);
		// surface-http 4xx → deterministic client/protocol error.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-http', httpStatus: 400 }), false);
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-http', httpStatus: 409 }), false);
		// missing status defaults to non-resumable.
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'surface-http' }), false);
	});

	test('404 marker overrides an otherwise-resumable replay verdict', () => {
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'replay', resumeNotFound: false }), true);
		assert.strictEqual(isStatelessTurnResumable({ verdict: 'replay', resumeNotFound: true }), false);
	});
});
