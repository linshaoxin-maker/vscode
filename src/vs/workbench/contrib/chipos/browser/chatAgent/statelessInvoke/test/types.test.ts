/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8a — type-level + runtime tests for the stateless-invoke schema.
 *
 * 这些 tests 主要做两件事:
 *   1. **Compile-time pinning** — 通过显式 `: Message`, `: InvokeRequest` 等注解,
 *      让 tsc 在字段名 / shape 漂移时立刻报编译错。tsgo 跑过 = 契约对齐成功一半。
 *   2. **Runtime sanity** — 验证 type-guard / round_end helper 行为, 以及 compact
 *      请求/响应 shape 能 JSON-roundtrip (确认没有 class / Symbol 等不可序列化字段)。
 *
 * Source of truth: `backend_v2/packages/shared/src/shared/contracts/invoke.py`
 * Spec:            `document/backend-v2-migration/04-decisions/PHASE-0-PROTOCOL-SPEC.md` §2
 */

import assert from 'assert';
import {
	type CompactRequest,
	type CompactResponse,
	type ContentBlock,
	type InvokeEvent,
	type InvokeRequest,
	type Message,
	isImageBlock,
	isTextBlock,
	isToolResultBlock,
	isToolUseBlock,
	roundEndReason,
} from '../types.js';

suite('statelessInvoke/types — Phase 0 #8a schema contract', () => {

	test('message_content_can_be_string', () => {
		const m: Message = { role: 'user', content: 'hi' };
		assert.strictEqual(m.content, 'hi');
		assert.strictEqual(m.role, 'user');
	});

	test('message_content_can_be_array_of_content_blocks', () => {
		const m: Message = {
			role: 'user',
			content: [{ type: 'text', text: 'hi' }],
		};
		assert.ok(Array.isArray(m.content));
		assert.strictEqual((m.content as ContentBlock[]).length, 1);
		const first = (m.content as ContentBlock[])[0];
		assert.strictEqual(first.type, 'text');
	});

	test('discriminated_union_narrowing', () => {
		const blocks: ContentBlock[] = [
			{ type: 'text', text: 'hello' },
			{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/x' } },
			{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
		];

		// Each branch narrows to its concrete type and exposes its unique fields.
		const collected: string[] = [];
		for (const b of blocks) {
			if (isTextBlock(b)) {
				collected.push(`text:${b.text}`);
			} else if (isToolUseBlock(b)) {
				collected.push(`tool_use:${b.name}:${b.id}`);
			} else if (isToolResultBlock(b)) {
				collected.push(`tool_result:${b.tool_use_id}`);
			} else if (isImageBlock(b)) {
				collected.push(`image:${(b.source as { type: string }).type}`);
			}
		}

		assert.deepStrictEqual(collected, [
			'text:hello',
			'tool_use:read_file:toolu_1',
			'tool_result:toolu_1',
			'image:base64',
		]);
	});

	test('invoke_request_minimum', () => {
		// Only required fields populated — everything else uses spec defaults at
		// the reasoner side (we don't set them here on purpose to pin the
		// minimum surface). Phase 1 (ADR-018 §2 D9) adds `expected_catalog_version`
		// as required — IDE must register tools first and reference the version.
		const req: InvokeRequest = {
			trace_id: 'trace-001',
			chat_session_id: 'sess-abc',
			messages: [{ role: 'user', content: 'hello' }],
			model: 'zhipu/glm-5.1',
			workspace_path: '/Users/me/proj',
			expected_catalog_version: 'test',
		};
		assert.strictEqual(req.messages.length, 1);
		assert.strictEqual(req.model, 'zhipu/glm-5.1');
	});

	test('invoke_request_full', () => {
		// All fields populated — pins every field name and accepted value type
		// for the Phase 1 (ADR-018) schema. Phase 0's `tools[]`,
		// `langgraph_state_blob`, and `langgraph_state_version` are gone:
		// tools live in the long-lived catalog registered via
		// `RegisterToolsRequest`, and reasoner internal state lives reasoner-side
		// in FileStateStore (ADR-018 §2 D8 + D9).
		const req: InvokeRequest = {
			protocol_version: 1,
			trace_id: 'trace-002',
			chat_session_id: 'sess-def',
			messages: [
				{ role: 'system', content: 'be terse' },
				{ role: 'user', content: 'hi' },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'sure' },
						{ type: 'tool_use', id: 'toolu_42', name: 'noop', input: {} },
					],
				},
				{
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'toolu_42', content: 'done', is_error: false }],
					is_compact_summary: false,
					is_visible_in_transcript_only: false,
				},
			],
			system: 'you are a helper',
			mode: 'agent',
			model: 'claude-3.5-sonnet',
			provider: 'auto',
			base_url: 'https://api.anthropic.com',
			api_key_alias: 'default',
			temperature: 0.2,
			max_tokens: 4096,
			thinking: false,
			expected_catalog_version: 'sha256-abc123',
			workspace_path: '/abs/path',
			auto_approve_mode: 'standard',
			workspace_meta: { current_file: '/abs/path/src/main.ts', git_branch: 'main' },
			user: { user_id: 'u1', org_id: 'o1' },
			metadata: { ide_version: '1.0.0' },
			prompt_resource_attachments: [
				{ kind: 'rule', name: 'style', source: 'user', reason: 'always', payload: { body: 'be terse' } },
				{ kind: 'command', name: 'fix-lint', source: 'plugin', source_ref: 'lint-pack', description: 'run linter' },
			],
		};
		assert.strictEqual(req.messages.length, 4);
		assert.strictEqual(req.mode, 'agent');
		assert.strictEqual(req.expected_catalog_version, 'sha256-abc123');
		assert.strictEqual(req.workspace_meta?.current_file, '/abs/path/src/main.ts');
		assert.strictEqual(req.prompt_resource_attachments?.length, 2);
		assert.strictEqual(req.prompt_resource_attachments?.[0].kind, 'rule');
	});

	test('round_end_helper', () => {
		const e: InvokeEvent = {
			type: 'round_end',
			sequence_id: 1,
			data: { reason: 'end_turn' },
		};
		assert.strictEqual(roundEndReason(e), 'end_turn');

		// Non-round_end events return undefined regardless of data.reason content.
		const other: InvokeEvent = {
			type: 'message_delta',
			sequence_id: 2,
			data: { reason: 'should-not-leak' },
		};
		assert.strictEqual(roundEndReason(other), undefined);
	});

	test('compact_request_response_shapes', () => {
		// Canonical CompactRequest models "not set" as omission (M1: base_url
		// null→omit is the one accepted wire delta — pydantic resolves both to
		// None), so unset optional fields are left out instead of null here.
		const req: CompactRequest = {
			protocol_version: 1,
			trace_id: 'compact-001',
			chat_session_id: 'sess-xyz',
			messages: [
				{ role: 'user', content: 'old turn 1' },
				{ role: 'assistant', content: 'old reply 1' },
			],
			model: 'zhipu/glm-5.1',
			provider: 'auto',
			max_summary_tokens: 4000,
		};
		const reqRoundtrip = JSON.parse(JSON.stringify(req)) as CompactRequest;
		assert.deepStrictEqual(reqRoundtrip, req);

		const resp: CompactResponse = {
			summary_message: {
				role: 'user',
				content: 'Summary of prior conversation: ...',
				is_compact_summary: true,
				is_visible_in_transcript_only: true,
			},
			tokens_in: 1234,
			tokens_out: 567,
			cost_usd: 0.0123,
		};
		const respRoundtrip = JSON.parse(JSON.stringify(resp)) as CompactResponse;
		assert.deepStrictEqual(respRoundtrip, resp);
		assert.strictEqual(respRoundtrip.summary_message.is_compact_summary, true);
	});
});
