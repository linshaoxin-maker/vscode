/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for ChatModelToRecordsAdapter — Phase 0 #8e Step 0.5.
 *
 * We fake IChatModel / IChatRequestModel / IChatResponseModel via plain
 * objects matching the structural shapes the adapter reads. The adapter
 * itself only reads fields via property access, no runtime type checks,
 * so structural fakes are honoured at runtime (tsgo cast required).
 */

import assert from 'assert';

import { ChatModelToRecordsAdapter } from '../chatModelAdapter.js';
import { ChatSessionRecord } from '../conversationAssembler.js';

// ── Fake builders ───────────────────────────────────────────────────────

/**
 * Build a minimal fake IChatRequestModel that exposes only the fields
 * the adapter reads. Returns `unknown` so tsgo doesn't complain when we
 * skip rare fields we don't exercise; the adapter is purely structural.
 */
function fakeReq(opts: {
	message?: string;
	confirmation?: string;
	response?: { parts: unknown[] };
}): unknown {
	const resp = opts.response
		? {
			id: 'r' + Math.random().toString(36).slice(2, 8),
			entireResponse: { value: opts.response.parts },
		}
		: undefined;
	return {
		message: opts.message !== undefined ? { text: opts.message } : undefined,
		confirmation: opts.confirmation,
		response: resp,
	};
}

function fakeModel(requests: unknown[]): unknown {
	return { getRequests: () => requests };
}

// Cast helper so the test bodies can pass our fakes without `as unknown as`.
type FakeModel = Parameters<ChatModelToRecordsAdapter['fromChatModel']>[0];

suite('ChatModelToRecordsAdapter', () => {
	let adapter: ChatModelToRecordsAdapter;
	setup(() => { adapter = new ChatModelToRecordsAdapter(); });

	test('empty model → empty records', () => {
		const out = adapter.fromChatModel(fakeModel([]) as FakeModel);
		assert.deepStrictEqual(out, []);
	});

	test('single user text round-trips', () => {
		const out = adapter.fromChatModel(fakeModel([fakeReq({ message: 'hello' })]) as FakeModel);
		assert.deepStrictEqual(out, [{ role: 'user', content: 'hello' }]);
	});

	test('user + assistant text pair', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'ask',
				response: { parts: [{ kind: 'markdownContent', content: { value: 'reply' } }] },
			}),
		]) as FakeModel);
		assert.deepStrictEqual(out, [
			{ role: 'user', content: 'ask' },
			{ role: 'assistant', content: 'reply' },
		]);
	});

	test('consecutive markdown parts merge into one assistant record', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'q',
				response: {
					parts: [
						{ kind: 'markdownContent', content: { value: 'foo ' } },
						{ kind: 'markdownContent', content: { value: 'bar' } },
					],
				},
			}),
		]) as FakeModel);
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[1].content, 'foo bar');
	});

	test('UI-only parts (thinking / progressMessage / mcpServersStarting / undoStop) are dropped', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'q',
				response: {
					parts: [
						{ kind: 'thinking', value: 'pondering' },
						{ kind: 'markdownContent', content: { value: 'visible' } },
						{ kind: 'progressMessage', content: 'wait' },
						{ kind: 'mcpServersStarting' },
						{ kind: 'undoStop', id: 'u1' },
						{ kind: 'roundProgress', round: 1 },
					],
				},
			}),
		]) as FakeModel);
		// Only the visible text remains as assistant content.
		assert.deepStrictEqual(out, [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'visible' },
		]);
	});

	test('toolInvocationSerialized → assistant tool_use + user tool_result pair (complete)', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'list files',
				response: {
					parts: [{
						kind: 'toolInvocationSerialized',
						toolCallId: 'toolu_abc',
						toolId: 'ls',
						isComplete: true,
						toolSpecificData: { kind: 'input', rawInput: { path: '/tmp' } },
						resultDetails: { output: 'file1\nfile2', isError: false },
					}],
				},
			}),
		]) as FakeModel);

		assert.deepStrictEqual(out, [
			{ role: 'user', content: 'list files' },
			{ role: 'assistant', toolUse: { id: 'toolu_abc', name: 'ls', input: { path: '/tmp' } } },
			{ role: 'user', toolResult: { tool_use_id: 'toolu_abc', content: 'file1\nfile2', is_error: false } },
		]);
	});

	test('incomplete tool_use emits assistant record but no tool_result', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'go',
				response: {
					parts: [{
						kind: 'toolInvocationSerialized',
						toolCallId: 'toolu_xyz',
						toolId: 'pending',
						isComplete: false,
						toolSpecificData: { kind: 'input', rawInput: {} },
					}],
				},
			}),
		]) as FakeModel);

		// Only 2 records — no tool_result.
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[1].role, 'assistant');
		assert.ok(out[1].toolUse);
	});

	test('confirmation card → chipos_user_confirm tool_use + paired tool_result from next request', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'do it',
				response: {
					parts: [{
						kind: 'confirmation',
						title: 'Are you sure?',
						message: 'destructive op',
						data: { requestId: 'confirm-42', card_type: 'agent_ask' },
						buttons: ['yes', 'no'],
					}],
				},
			}),
			fakeReq({
				message: 'reason',
				confirmation: 'yes',
			}),
		]) as FakeModel);

		assert.strictEqual(out.length, 3);
		// out[0] user "do it"
		assert.deepStrictEqual(out[0], { role: 'user', content: 'do it' });
		// out[1] assistant tool_use(chipos_user_confirm)
		assert.strictEqual(out[1].role, 'assistant');
		assert.strictEqual(out[1].toolUse?.name, 'chipos_user_confirm');
		assert.strictEqual(out[1].toolUse?.id, 'confirm-42');
		// out[2] user tool_result with action+comment
		assert.strictEqual(out[2].role, 'user');
		assert.strictEqual(out[2].toolResult?.tool_use_id, 'confirm-42');
		// tool_result.content is `string | TextBlock[]` in the typed shape; in
		// this adapter's emit path it's always a string (JSON-stringified action).
		const trContent = out[2].toolResult!.content;
		assert.strictEqual(typeof trContent, 'string');
		const parsed = JSON.parse(trContent as string);
		assert.strictEqual(parsed.action, 'yes');
		assert.strictEqual(parsed.comment, 'reason');
		// The follow-up request's text should NOT also appear as a fresh user
		// message (it's the confirmation reply, not a new prompt)
		const userPlainCount = out.filter(r => r.role === 'user' && r.content === 'reason').length;
		assert.strictEqual(userPlainCount, 0);
	});

	test('confirmation card without requestId synthesises a stable id', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'go',
				response: {
					parts: [{
						kind: 'confirmation',
						title: 'pick',
						message: '...',
						data: {}, // no requestId
						buttons: ['a', 'b'],
					}],
				},
			}),
		]) as FakeModel);

		// out[1] should be tool_use with synthesised id
		assert.strictEqual(out[1].role, 'assistant');
		const id = out[1].toolUse?.id;
		assert.ok(typeof id === 'string' && id.startsWith('confirm-'));
	});

	test('empty user message (whitespace only) is skipped', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({ message: '   ' }),
		]) as FakeModel);
		assert.deepStrictEqual(out, []);
	});

	test('text mixed with tool_use in same response splits correctly', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'do x',
				response: {
					parts: [
						{ kind: 'markdownContent', content: { value: 'thinking about it...' } },
						{
							kind: 'toolInvocationSerialized',
							toolCallId: 't1', toolId: 'shell',
							isComplete: true,
							toolSpecificData: { kind: 'input', rawInput: { cmd: 'ls' } },
							resultDetails: { output: 'a b c', isError: false },
						},
						{ kind: 'markdownContent', content: { value: 'done' } },
					],
				},
			}),
		]) as FakeModel);

		// Expected: user 'do x', assistant 'thinking about it...', assistant tool_use, user tool_result, assistant 'done'
		assert.strictEqual(out.length, 5);
		assert.strictEqual(out[0].content, 'do x');
		assert.strictEqual(out[1].content, 'thinking about it...');
		assert.strictEqual(out[2].toolUse?.id, 't1');
		assert.strictEqual(out[3].toolResult?.tool_use_id, 't1');
		assert.strictEqual(out[4].content, 'done');
	});

	test('toolSpecificData without input envelope passes whole data dict as input', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'q',
				response: {
					parts: [{
						kind: 'toolInvocationSerialized',
						toolCallId: 't2', toolId: 'terminal',
						isComplete: true,
						// Terminal envelope (not 'input' kind), should be passed verbatim
						toolSpecificData: { kind: 'terminal', commandLine: { original: 'ls' } },
						resultDetails: 'okay',
					}],
				},
			}),
		]) as FakeModel);

		const tu = out.find(r => r.toolUse)!;
		assert.deepStrictEqual(tu.toolUse?.input, { kind: 'terminal', commandLine: { original: 'ls' } });
	});

	test('resultDetails as array of URIs joins fsPath into newline-separated string', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'find',
				response: {
					parts: [{
						kind: 'toolInvocationSerialized',
						toolCallId: 't3', toolId: 'search',
						isComplete: true,
						toolSpecificData: { kind: 'input', rawInput: { q: 'foo' } },
						resultDetails: [{ uri: { fsPath: '/a' } }, { uri: { fsPath: '/b' } }],
					}],
				},
			}),
		]) as FakeModel);

		const tr = out.find(r => r.toolResult)!;
		assert.strictEqual(tr.toolResult?.content, '/a\n/b');
	});

	test('unknown response part kinds are silently dropped (defensive)', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'q',
				response: {
					parts: [
						{ kind: 'futureBlobKind', data: 'whatever' },
						{ kind: 'markdownContent', content: { value: 'still here' } },
					],
				},
			}),
		]) as FakeModel);
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[1].content, 'still here');
	});

	test('result details object with isError:true sets the flag', () => {
		const out = adapter.fromChatModel(fakeModel([
			fakeReq({
				message: 'go',
				response: {
					parts: [{
						kind: 'toolInvocationSerialized',
						toolCallId: 't4', toolId: 'fails',
						isComplete: true,
						toolSpecificData: { kind: 'input', rawInput: {} },
						resultDetails: { output: 'boom', isError: true },
					}],
				},
			}),
		]) as FakeModel);

		const tr = out.find((r: ChatSessionRecord) => r.toolResult)!;
		assert.strictEqual(tr.toolResult?.is_error, true);
		assert.strictEqual(tr.toolResult?.content, 'boom');
	});
});
