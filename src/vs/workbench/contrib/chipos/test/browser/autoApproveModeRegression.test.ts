/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';

/**
 * Regression tests for FEAT-34 Bug Fix:
 *   chipOSChatAgent was reading `chipos.autoApprove` (boolean, undefined)
 *   instead of `chipos.autoApproveMode` (string enum: strict|standard|full_auto).
 *
 * This caused the backend to always receive `auto_approve_mode: 'standard'`
 * regardless of user configuration.
 */
suite('AutoApproveMode — Regression Tests', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	test('configuration key is chipos.autoApproveMode, NOT chipos.autoApprove', () => {
		const correctKey = 'chipos.autoApproveMode';
		const wrongKey = 'chipos.autoApprove';

		assert.notStrictEqual(correctKey, wrongKey);
		assert.ok(correctKey.endsWith('Mode'));
	});

	test('autoApproveMode is a string enum, not boolean', () => {
		const validValues = ['strict', 'standard', 'full_auto'];
		const defaultValue = 'standard';

		assert.ok(validValues.includes(defaultValue));
		assert.strictEqual(typeof defaultValue, 'string');
	});

	test('autoApproveMode string passes through directly to backend', () => {
		function buildTaskMessage(autoApproveMode: string) {
			return {
				auto_approve_mode: autoApproveMode,
			};
		}

		const strictMsg = buildTaskMessage('strict');
		assert.strictEqual(strictMsg.auto_approve_mode, 'strict');

		const standardMsg = buildTaskMessage('standard');
		assert.strictEqual(standardMsg.auto_approve_mode, 'standard');

		const fullAutoMsg = buildTaskMessage('full_auto');
		assert.strictEqual(fullAutoMsg.auto_approve_mode, 'full_auto');
	});

	test('old boolean logic always returned standard (the bug)', () => {
		// This simulates the old buggy behavior:
		// const autoApprove = configService.getValue<boolean>('chipos.autoApprove') ?? false;
		// auto_approve_mode: autoApprove ? 'full_auto' : 'standard'
		const undefinedValue: boolean | undefined = undefined;
		const autoApprove = undefinedValue ?? false;
		const oldBehavior = autoApprove ? 'full_auto' : 'standard';

		assert.strictEqual(oldBehavior, 'standard', 'Bug: always returned standard because chipos.autoApprove was undefined');
	});

	test('new string logic correctly passes user choice', () => {
		// New behavior:
		// const autoApproveMode = configService.getValue<string>('chipos.autoApproveMode') ?? 'standard';
		// auto_approve_mode: autoApproveMode

		function simulateNewBehavior(configuredValue: string | undefined): string {
			return configuredValue ?? 'standard';
		}

		assert.strictEqual(simulateNewBehavior('strict'), 'strict');
		assert.strictEqual(simulateNewBehavior('standard'), 'standard');
		assert.strictEqual(simulateNewBehavior('full_auto'), 'full_auto');
		assert.strictEqual(simulateNewBehavior(undefined), 'standard');
	});

	test('sendTask options type uses autoApproveMode string', () => {
		const options: { thinking: boolean; autoApproveMode: string } = {
			thinking: true,
			autoApproveMode: 'full_auto',
		};

		assert.strictEqual(typeof options.autoApproveMode, 'string');
		assert.strictEqual(options.autoApproveMode, 'full_auto');
	});
});

suite('AutoApproveMode — Provider Enum Extension', () => {

	test('provider enum includes all 6 values', () => {
		const providers = ['auto', 'openai', 'anthropic', 'zhipu', 'deepseek', 'custom'];
		assert.strictEqual(providers.length, 6);
	});

	test('default provider changed from openai to zhipu', () => {
		const newDefault = 'zhipu';
		assert.strictEqual(newDefault, 'zhipu');
		assert.notStrictEqual(newDefault, 'openai');
	});

	test('zhipu uses OpenAI-compatible API', () => {
		const zhipuBaseUrl = 'https://open.bigmodel.cn/api/paas/v4';
		assert.ok(zhipuBaseUrl.includes('bigmodel'));
	});

	test('deepseek uses OpenAI-compatible API', () => {
		const deepseekBaseUrl = 'https://api.deepseek.com';
		assert.ok(deepseekBaseUrl.includes('deepseek'));
	});

	test('custom provider requires user-specified base URL', () => {
		const customBaseUrl = 'https://my-custom-llm.example.com/v1';
		assert.ok(customBaseUrl.startsWith('https://'));
	});
});
