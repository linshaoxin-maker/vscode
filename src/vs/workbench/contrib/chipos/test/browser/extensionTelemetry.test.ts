/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildExtensionTelemetry } from '../../common/extensionTelemetry.js';

/** FEAT-006c — telemetry is count/bytes/status only, never capability content. */
suite('extensionTelemetry', () => {

	test('reduces raw inputs (with content) to a numeric payload — no content leaks', () => {
		const SECRET = 'SECRET_RULE_BODY_must_never_appear';
		const payload = buildExtensionTelemetry({
			attachments: [{ content: SECRET }, { content: 'abc' }],
			autoContext: [{ content: 'hello' }],
			hooks: [{ status: 'ok' }, { status: 'deny' }, { status: 'error' }],
			cacheCreationTokens: 120,
			cacheReadTokens: 4096,
		});
		assert.deepStrictEqual(payload, {
			attachmentCount: 2,
			attachmentBytes: SECRET.length + 3,   // ASCII → byteLength === char count
			autoContextCount: 1,
			autoContextBytes: 5,
			hookTriggers: 3,
			hookDenied: 1,
			cacheCreationTokens: 120,
			cacheReadTokens: 4096,
		});
		// Security contract: the emitted payload carries ZERO capability content.
		assert.ok(!JSON.stringify(payload).includes('SECRET'), 'telemetry payload leaked content');
	});

	test('empty/garbage inputs → all-zero payload (no NaN, no negatives)', () => {
		assert.deepStrictEqual(
			buildExtensionTelemetry({ cacheCreationTokens: -5, cacheReadTokens: NaN }),
			{ attachmentCount: 0, attachmentBytes: 0, autoContextCount: 0, autoContextBytes: 0, hookTriggers: 0, hookDenied: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
		);
	});
});
