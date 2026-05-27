/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8c — ConversationAssembler unit tests.
 *
 * Covers all Anthropic-shape invariants the assembler enforces (PHASE-0-
 * PROTOCOL-SPEC §2 + ADR-017 §11.2):
 *   - empty input rejection (mirrors P0-2)
 *   - role=user leading turn requirement
 *   - tool_use/tool_result pairing (immediate-next + id match)
 *   - compact summary marker preservation
 *   - chiposLangGraphState most-recent extraction
 *   - JSONL defensive parsing (bad lines skipped, not thrown)
 */

import assert from 'assert';
import {
	ChatSessionRecord,
	ConversationAssembler,
	ConversationAssemblyError,
} from '../conversationAssembler.js';
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../types.js';

suite('ConversationAssembler', () => {

	let assembler: ConversationAssembler;
	let warnSpy: { calls: string[]; restore: () => void };

	setup(() => {
		assembler = new ConversationAssembler();
		// Capture console.warn so the JSONL defensive-parsing tests can
		// assert that bad lines were warned about rather than thrown.
		const original = console.warn;
		const calls: string[] = [];
		console.warn = (...args: unknown[]) => {
			calls.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
		};
		warnSpy = {
			calls,
			restore: () => { console.warn = original; },
		};
	});

	teardown(() => {
		warnSpy.restore();
	});

	// ─── 1 ──────────────────────────────────────────────────────────────────

	test('empty records throws ConversationAssemblyError', () => {
		assert.throws(
			() => assembler.assemble([]),
			(err: unknown) => err instanceof ConversationAssemblyError && (err as ConversationAssemblyError).cause === 'empty_records',
		);
	});

	// ─── 2 ──────────────────────────────────────────────────────────────────

	test('single user text message round-trips', () => {
		const result = assembler.assemble([{ role: 'user', content: 'hi' }]);
		assert.deepStrictEqual(result, {
			messages: [{ role: 'user', content: 'hi' }],
			langgraph_state_blob: null,
		});
	});

	// ─── 3 ──────────────────────────────────────────────────────────────────

	test('alternating user/assistant text ping-pong (4 messages)', () => {
		const result = assembler.assemble([
			{ role: 'user', content: 'q1' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'user', content: 'q2' },
			{ role: 'assistant', content: 'a2' },
		]);
		assert.deepStrictEqual(result, {
			messages: [
				{ role: 'user', content: 'q1' },
				{ role: 'assistant', content: 'a1' },
				{ role: 'user', content: 'q2' },
				{ role: 'assistant', content: 'a2' },
			],
			langgraph_state_blob: null,
		});
	});

	// ─── 4 ──────────────────────────────────────────────────────────────────

	test('first message assistant throws', () => {
		assert.throws(
			() => assembler.assemble([
				{ role: 'assistant', content: 'I should never be first' },
				{ role: 'user', content: 'hello' },
			]),
			(err: unknown) => err instanceof ConversationAssemblyError && (err as ConversationAssemblyError).cause === 'first_message_not_user',
		);
	});

	// ─── 5 ──────────────────────────────────────────────────────────────────

	test('tool_use pairs with following tool_result (correct ContentBlock shape, no throw)', () => {
		const result = assembler.assemble([
			{ role: 'user', content: 'review alu.v' },
			{
				role: 'assistant',
				toolUse: { id: 'toolu_01ABC', name: 'read_file', input: { path: 'alu.v' } },
			},
			{
				role: 'user',
				toolResult: { tool_use_id: 'toolu_01ABC', content: 'module alu(...);' },
			},
		]);
		assert.strictEqual(result.messages.length, 3);
		assert.strictEqual(result.messages[1].role, 'assistant');
		const assistantBlocks = result.messages[1].content as ContentBlock[];
		assert.strictEqual(assistantBlocks.length, 1);
		const useBlock = assistantBlocks[0] as ToolUseBlock;
		assert.deepStrictEqual(useBlock, {
			type: 'tool_use',
			id: 'toolu_01ABC',
			name: 'read_file',
			input: { path: 'alu.v' },
		});
		assert.strictEqual(result.messages[2].role, 'user');
		const userBlocks = result.messages[2].content as ContentBlock[];
		const resultBlock = userBlocks[0] as ToolResultBlock;
		assert.deepStrictEqual(resultBlock, {
			type: 'tool_result',
			tool_use_id: 'toolu_01ABC',
			content: 'module alu(...);',
		});
	});

	// ─── 6 ──────────────────────────────────────────────────────────────────

	test('tool_use unmatched (next user is plain text, not tool_result) throws', () => {
		assert.throws(
			() => assembler.assemble([
				{ role: 'user', content: 'review alu.v' },
				{
					role: 'assistant',
					toolUse: { id: 'toolu_01X', name: 'read_file', input: { path: 'alu.v' } },
				},
				// Next user message is text, not tool_result → broken pairing.
				{ role: 'user', content: 'actually wait, cancel that' },
			]),
			(err: unknown) => err instanceof ConversationAssemblyError && /tool_use/.test((err as Error).message),
		);
	});

	// ─── 7 ──────────────────────────────────────────────────────────────────

	test('compact summary record emits both marker fields', () => {
		const result = assembler.assemble([
			{ isCompactSummary: true, content: '## Summary\n1. ...\n2. ...' },
			{ role: 'user', content: 'continue please' },
		]);
		assert.deepStrictEqual(result.messages[0], {
			role: 'user',
			content: '## Summary\n1. ...\n2. ...',
			is_compact_summary: true,
			is_visible_in_transcript_only: true,
		});
		assert.deepStrictEqual(result.messages[1], { role: 'user', content: 'continue please' });
	});

	// ─── 8 ──────────────────────────────────────────────────────────────────

	test('langgraph_state_blob picks the most recent value across records', () => {
		const result = assembler.assemble([
			{ role: 'user', content: 'q1', chiposLangGraphState: 'BLOB_v1' },
			{ role: 'assistant', content: 'a1', chiposLangGraphState: 'BLOB_v2' },
			{ role: 'user', content: 'q2', chiposLangGraphState: 'BLOB_v3_latest' },
		]);
		assert.strictEqual(result.langgraph_state_blob, 'BLOB_v3_latest');
	});

	// ─── 9 ──────────────────────────────────────────────────────────────────

	test('langgraph_state_blob is null when no record carries one', () => {
		const result = assembler.assemble([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'a' },
		]);
		assert.strictEqual(result.langgraph_state_blob, null);
	});

	// ─── 10 ─────────────────────────────────────────────────────────────────

	test('assembleFromJsonl parses line by line', () => {
		const jsonl = [
			JSON.stringify({ role: 'user', content: 'hi' }),
			JSON.stringify({ role: 'assistant', content: 'hello' }),
			JSON.stringify({ role: 'user', content: 'bye' }),
		].join('\n');
		const result = assembler.assembleFromJsonl(jsonl);
		assert.deepStrictEqual(result.messages, [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
			{ role: 'user', content: 'bye' },
		]);
		assert.strictEqual(result.langgraph_state_blob, null);
	});

	// ─── 11 ─────────────────────────────────────────────────────────────────

	test('assembleFromJsonl skips bad lines, warns, continues with the rest', () => {
		const jsonl = [
			JSON.stringify({ role: 'user', content: 'first' }),
			'{"role":"assistant","content":"truncated...', // bad JSON
			JSON.stringify({ role: 'user', content: 'third' }),
			'',                                            // empty line, silent skip
			'42',                                          // valid JSON but not an object
			JSON.stringify({ role: 'assistant', content: 'fifth' }),
		].join('\n');
		const result = assembler.assembleFromJsonl(jsonl);
		assert.deepStrictEqual(result.messages, [
			{ role: 'user', content: 'first' },
			{ role: 'user', content: 'third' },
			{ role: 'assistant', content: 'fifth' },
		]);
		// Two warns: one for the bad JSON, one for the `42` non-object.
		// (Empty line is silent.)
		assert.strictEqual(warnSpy.calls.length, 2, `expected 2 warns, got: ${warnSpy.calls.join(' | ')}`);
		assert.ok(warnSpy.calls.some(c => c.includes('unparseable')), 'first warn should mention unparseable');
		assert.ok(warnSpy.calls.some(c => c.includes('not a JSON object')), 'second warn should mention not-an-object');
	});

	// ─── 12 ─────────────────────────────────────────────────────────────────

	test('tool_result with string content is preserved as-is (Anthropic accepts both string and TextBlock[])', () => {
		// String form
		const stringFormResult = assembler.assemble([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', toolUse: { id: 'toolu_S', name: 'bash', input: { cmd: 'ls' } } },
			{ role: 'user', toolResult: { tool_use_id: 'toolu_S', content: 'file1\nfile2' } },
		]);
		const stringBlock = (stringFormResult.messages[2].content as ContentBlock[])[0] as ToolResultBlock;
		assert.strictEqual(typeof stringBlock.content, 'string');
		assert.strictEqual(stringBlock.content, 'file1\nfile2');
		assert.strictEqual(stringBlock.is_error, undefined, 'is_error must be absent (not false) when not set');

		// TextBlock[] form via explicit content (caller pre-built the blocks)
		const blockFormResult = assembler.assemble([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', toolUse: { id: 'toolu_B', name: 'bash', input: { cmd: 'ls' } } },
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_B',
						content: [{ type: 'text', text: 'file1' }, { type: 'text', text: 'file2' }],
						is_error: false,
					} as ToolResultBlock,
				],
			},
		]);
		const arrBlock = (blockFormResult.messages[2].content as ContentBlock[])[0] as ToolResultBlock;
		assert.ok(Array.isArray(arrBlock.content), 'TextBlock[] form preserved as array');
		assert.strictEqual((arrBlock.content as Array<{ text: string }>).length, 2);
	});

	// ─── Bonus 13: is_error=true preserved via shorthand ──────────────────

	test('tool_result with is_error=true sets the flag on the emitted block', () => {
		const result = assembler.assemble([
			{ role: 'user', content: 'do it' },
			{ role: 'assistant', toolUse: { id: 'toolu_E', name: 'bash', input: { cmd: 'false' } } },
			{
				role: 'user',
				toolResult: { tool_use_id: 'toolu_E', content: 'exit 1', is_error: true },
			},
		]);
		const block = (result.messages[2].content as ContentBlock[])[0] as ToolResultBlock;
		assert.strictEqual(block.is_error, true);
	});

	// ─── Bonus 14: meta-only record (just langgraph state) is skipped from messages but contributes blob ──

	test('meta-only record carrying only chiposLangGraphState is skipped from messages but its blob is captured', () => {
		const result = assembler.assemble([
			{ role: 'user', content: 'q' },
			{ chiposLangGraphState: 'BLOB_META' }, // no role, no content → meta
			{ role: 'assistant', content: 'a' },
		]);
		assert.deepStrictEqual(result.messages, [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'a' },
		]);
		assert.strictEqual(result.langgraph_state_blob, 'BLOB_META');
	});

	// ─── Bonus 15: tool_use_id mismatch in following tool_result throws ───

	test('tool_use_id mismatched with following tool_result throws', () => {
		assert.throws(
			() => assembler.assemble([
				{ role: 'user', content: 'go' },
				{ role: 'assistant', toolUse: { id: 'toolu_AAA', name: 'bash', input: {} } },
				{ role: 'user', toolResult: { tool_use_id: 'toolu_DIFFERENT', content: 'oops' } },
			]),
			(err: unknown) => err instanceof ConversationAssemblyError && (err as ConversationAssemblyError).cause === 'tool_use_unmatched_id',
		);
	});
});

// Type-only smoke test — assert ChatSessionRecord re-export
void (null as unknown as ChatSessionRecord);
