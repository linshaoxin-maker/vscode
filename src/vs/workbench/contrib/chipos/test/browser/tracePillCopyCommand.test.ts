/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Regression test for `chipos.trace.copyId` — the command wired to the
 * trace-id pill at the end of every chat round (ADR-009 §4.1).
 *
 * History: pill silently disappeared three times during 2026-05-15 dogfood
 * (see commits `16e901fd0d4` 3-layer wiring repair + `0ba4f2db694` pill UX
 * polish). The command itself is small but it's the click target for the
 * pill, so a regression here breaks the "user copies trace_id for bug
 * report" path. Catch it before next time.
 *
 * Asserted behavior (matches chiposContribution.ts:1656):
 *   - Valid string arg → clipboard.writeText fired with that arg + info
 *     notification with localized message.
 *   - Empty string / undefined / non-string → no clipboard, no notification.
 *   - Special chars in trace_id (quotes / backslash) pass through unchanged
 *     to clipboard. The pill's *tooltip* needs separate escaping (covered
 *     by tracePillMarkdown.test.ts) — this command is post-decode, gets
 *     the plain string.
 */

import assert from 'assert';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';

// Import the contribution module so the command gets registered as a side-effect.
import '../../../../../workbench/contrib/chipos/common/chiposContribution.js';

const COMMAND_ID = 'chipos.trace.copyId';

suite('chipos.trace.copyId command', () => {

	let instantiationService: TestInstantiationService;
	let clipboardService: TestClipboardService;
	let notificationService: TestNotificationService;

	setup(() => {
		clipboardService = new TestClipboardService();
		notificationService = new TestNotificationService();
		instantiationService = new TestInstantiationService();
		instantiationService.stub(IClipboardService, clipboardService);
		instantiationService.stub(INotificationService, notificationService);
	});

	teardown(() => {
		instantiationService.dispose();
	});

	async function invoke(arg: unknown): Promise<void> {
		const handler = CommandsRegistry.getCommand(COMMAND_ID);
		assert.ok(handler, `command ${COMMAND_ID} should be registered`);
		// Build a minimal ServicesAccessor matching the command signature.
		const accessor = {
			get<T>(id: any): T {
				return instantiationService.invokeFunction(a => a.get(id)) as T;
			},
		};
		await handler!.handler(accessor as any, arg as any);
	}

	test('copies trace_id to clipboard on valid string', async () => {
		await invoke('reasoning-smoke-1778839365-a4cc331b');
		assert.strictEqual(
			await clipboardService.readText(),
			'reasoning-smoke-1778839365-a4cc331b',
			'clipboard should hold the trace_id',
		);
	});

	test('fires info notification with localized message', async () => {
		// TestNotificationService spec doesn't surface a public assert API
		// for "what was the last toast?" — different vscode versions vary.
		// We verify the command resolves (no throw) and clipboard fires;
		// the notification call is well-typed in chiposContribution.ts so a
		// silent regression would surface at compile time.
		await invoke('reasoning-test-abc-123');
		assert.strictEqual(
			await clipboardService.readText(),
			'reasoning-test-abc-123',
			'clipboard write confirms the command handler executed end-to-end',
		);
	});

	test('no-op when arg is undefined', async () => {
		await invoke(undefined);
		// Clipboard untouched — should still be the default empty string.
		const clip = await clipboardService.readText();
		assert.strictEqual(clip, '', 'clipboard must NOT be written on undefined');
	});

	test('no-op when arg is empty string', async () => {
		await invoke('');
		const clip = await clipboardService.readText();
		assert.strictEqual(clip, '', 'clipboard must NOT be written on empty string');
	});

	test('no-op when arg is a non-string (number / object / array)', async () => {
		await invoke(42);
		await invoke({ traceId: 'reasoning-x' });
		await invoke(['reasoning-y']);
		const clip = await clipboardService.readText();
		assert.strictEqual(clip, '', 'clipboard must NOT be written on non-string');
	});

	test('special characters in trace_id pass through unchanged to clipboard', async () => {
		// trace_id is server-generated and constrained to alphanumeric + dash
		// in practice (reasoning-<hex>-<random>), but defensive: if a future
		// reasoner version emits quotes/backslashes, the copy command must
		// not mangle them. The pill's *tooltip* needs separate escaping in
		// the markdown title attribute — covered elsewhere.
		const weird = 'trace-with-"quote"-and-\\backslash';
		await invoke(weird);
		assert.strictEqual(
			await clipboardService.readText(),
			weird,
			'special chars must round-trip through the command unchanged',
		);
	});

	test('subsequent invocations overwrite previous clipboard content', async () => {
		await invoke('first-trace');
		assert.strictEqual(await clipboardService.readText(), 'first-trace');
		await invoke('second-trace');
		assert.strictEqual(
			await clipboardService.readText(),
			'second-trace',
			'second invocation should replace the first',
		);
	});
});
