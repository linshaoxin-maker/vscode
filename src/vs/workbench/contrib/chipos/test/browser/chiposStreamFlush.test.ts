/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `ChipOSChatAgent._splitStreamableText` — the helper behind
 * incremental streaming of assistant text in the stateless render path.
 *
 * Background: streamed assistant text used to be accumulated and only painted
 * on a flush boundary (tool call / message_stop), so a plain-text reply stayed
 * blank until the turn ended ("no streaming"). `_splitStreamableText` lets the
 * agent render completed lines as deltas arrive while holding back the trailing
 * partial line — which protects the mandated trailing `建议下一步: …` next-step
 * line (always the LAST line) from being flashed as prose before
 * `flushAssistantText` strips it into the inline card.
 */

import assert from 'assert';
import { ChipOSChatAgent } from '../../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';

suite('ChipOSChatAgent._splitStreamableText', () => {

	test('holds everything when there is no completed line yet', () => {
		const { emit, hold } = ChipOSChatAgent._splitStreamableText('partial line still streaming');
		assert.strictEqual(emit, '', 'nothing is safe to emit without a newline');
		assert.strictEqual(hold, 'partial line still streaming');
	});

	test('emits completed lines and holds the trailing partial line', () => {
		const { emit, hold } = ChipOSChatAgent._splitStreamableText('line one\nline two\npartial');
		assert.strictEqual(emit, 'line one\nline two\n', 'emit up to and including the last newline');
		assert.strictEqual(hold, 'partial', 'hold the trailing partial line');
	});

	test('emit + hold always reconstruct the input exactly (no loss/dup)', () => {
		for (const buf of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '多行\n文本\n结尾']) {
			const { emit, hold } = ChipOSChatAgent._splitStreamableText(buf);
			assert.strictEqual(emit + hold, buf, `round-trip failed for ${JSON.stringify(buf)}`);
		}
	});

	test('streaming a reply never emits the trailing 建议下一步 next-step line', () => {
		// Simulate the live loop: deltas arrive, accumulate into `buf`, split,
		// collect `emit`, keep `hold`. The reply ends with the mandated next-step
		// line (no trailing newline — `_stripNextStepLine` is end-anchored, so the
		// line is always last).
		const deltas = ['第一', '段说明。\n第', '二段说明。\n建议下一', '步: 运行 lint 检查'];
		let buf = '';
		let emitted = '';
		for (const d of deltas) {
			buf += d;
			const { emit, hold } = ChipOSChatAgent._splitStreamableText(buf);
			emitted += emit;
			buf = hold;
		}
		// Body streamed incrementally, line by line.
		assert.strictEqual(emitted, '第一段说明。\n第二段说明。\n');
		// The next-step line is still held back (it becomes the final flush, where
		// `flushAssistantText` strips it into the inline card).
		assert.strictEqual(buf, '建议下一步: 运行 lint 检查');
		assert.ok(!emitted.includes('建议下一步'),
			'the next-step line must never be streamed as prose');
	});

	test('streams progressively — earlier lines emit before the reply completes', () => {
		// After the first newline arrives, the first line is already emittable,
		// proving text no longer waits for the end of the turn.
		const mid = ChipOSChatAgent._splitStreamableText('正在分析时序路径\n继续');
		assert.strictEqual(mid.emit, '正在分析时序路径\n');
		assert.strictEqual(mid.hold, '继续');
	});
});
