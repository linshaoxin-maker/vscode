/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `ChipOSChatAgent._renderConfirmMessage` — the static
 * helper that builds the markdown body for every confirm card.
 *
 * Background (commit `4b232a42`): two card types had their header chip's
 * specifier text repeated inside the body markdown:
 *   - file_edit: header chip falls back to title "File Edit" (now shows
 *     file_path via _cardSpecifier #4b232a42); body used to start with
 *     `**File:** \`<file_path>\`` — duplicate.
 *   - VERIFICATION_HUMAN_CHECK: header chip shows stage name; body used
 *     to start with `**Stage:** \`<stage>\`` — exact duplicate.
 *
 * Without a unit test, a future refactor (e.g. someone splitting card
 * types into separate render modules) could silently re-introduce the
 * duplicate lines. These tests pin the invariant.
 *
 * Note: testing only the BODY (i.e. _renderConfirmMessage output). The
 * header chip text comes from a different helper (`_cardSpecifier`) which
 * is also static in the same class — we cross-reference but don't test
 * specifier here; that's a separate concern.
 */

import assert from 'assert';
import { ChipOSChatAgent } from '../../browser/chatAgent/chipOSChatAgent.js';
import { IConfirmRequestPayload } from '../../browser/eventStream/eventTypes.js';

// Helper: build a minimum-viable IConfirmRequestPayload for the given
// card_type with the supplied card_data. The actual interface (see
// chipos/browser/eventStream/eventTypes.ts) requires only request_id +
// card_type + card_data; everything else is optional. _renderConfirmMessage
// reads only card_type + card_data + message.
function makePayload(card_type: string, card_data: Record<string, unknown>, message?: string): IConfirmRequestPayload {
	return {
		request_id: 'test-req',
		card_type,
		card_data,
		message,
		title: 'test',
	};
}

suite('ChipOSChatAgent._renderConfirmMessage — dedup invariants', () => {

	// ── file_edit ────────────────────────────────────────────────────────

	test('file_edit body does NOT include `**File:** ${file_path}` line', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('file_edit', {
			file_path: '/abs/path/to/alu.v',
			description: 'Fix off-by-one in adder',
			diff: '--- a/alu.v\n+++ b/alu.v\n@@ -10 +10 @@',
		}));
		// The dedup invariant: must NOT contain "**File:**" prefix.
		assert.doesNotMatch(body, /\*\*File:\*\*/, `body unexpectedly contains File label:\n${body}`);
		// But should still contain the other fields:
		assert.match(body, /Fix off-by-one in adder/, 'body must keep description');
		assert.match(body, /```diff/, 'body must keep diff fenced code block');
	});

	test('file_edit body still degrades gracefully when description missing', () => {
		// With only file_path, neither File line nor description, body
		// falls back to the JSON pretty-print. The dedup invariant still
		// holds: file_path must NOT appear as "**File:** ..." even in JSON
		// output (JSON output has "file_path": value, no Markdown bold).
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('file_edit', {
			file_path: '/abs/path/to/alu.v',
		}));
		assert.doesNotMatch(body, /\*\*File:\*\*/, `JSON fallback should not synthesize **File:** label:\n${body}`);
	});

	test('file_edit body with all 3 fields concatenates description + diff (no File: prefix)', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('file_edit', {
			file_path: '/abs/path/to/alu.v',
			description: 'desc',
			diff: 'diff body',
		}));
		// Expected: description + \n\n + ```diff\ndiff body\n```
		// Total sections joined by \n\n; should NOT have a File line as first section.
		const sections = body.split('\n\n');
		assert.strictEqual(sections.length, 2, `expected 2 sections (desc + diff), got ${sections.length}: ${JSON.stringify(sections)}`);
		assert.strictEqual(sections[0], 'desc');
		assert.match(sections[1], /^```diff\n/);
	});

	// ── VERIFICATION_HUMAN_CHECK ─────────────────────────────────────────

	test('VERIFICATION_HUMAN_CHECK body does NOT include `**Stage:** ${stage}` line', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('VERIFICATION_HUMAN_CHECK', {
			stage: 'V2_TagStructureChecker',
			results: [
				{ name: 'tag_count', status: 'fail', message: 'Only 1 FG, expected ≥2' },
			],
		}));
		// Dedup invariant: no "**Stage:**" label.
		assert.doesNotMatch(body, /\*\*Stage:\*\*/, `body unexpectedly contains Stage label:\n${body}`);
		// But should still contain the checker results table:
		assert.match(body, /Checker.*Status.*Message/, 'body must keep results table header');
		assert.match(body, /tag_count/, 'body must keep checker name');
		assert.match(body, /Only 1 FG/, 'body must keep checker message');
	});

	test('VERIFICATION_HUMAN_CHECK body with empty results does not synthesize Stage line', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('VERIFICATION_HUMAN_CHECK', {
			stage: 'V3_CoverageGen',
			results: [],
		}));
		assert.doesNotMatch(body, /\*\*Stage:\*\*/, `body unexpectedly contains Stage label:\n${body}`);
	});

	test('VERIFICATION_HUMAN_CHECK body with no stage at all defaults gracefully', () => {
		// Even if card_data lacks `stage` entirely, the dedup invariant
		// holds (the field is just absent from output, no Stage line emitted).
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('VERIFICATION_HUMAN_CHECK', {
			results: [{ name: 'foo', status: 'pass', message: 'ok' }],
		}));
		assert.doesNotMatch(body, /\*\*Stage:\*\*/, `body unexpectedly contains Stage label:\n${body}`);
		assert.match(body, /Checker/, 'body must still render the table');
	});

	// ── Sanity: other card types still render their content ──────────────

	test('spec_confirm renders the spec_result text (sanity baseline)', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('spec_confirm', {
			spec_result: '# Spec Analysis Result\n\nThe module looks fine.',
		}));
		assert.match(body, /Spec Analysis Result/);
	});

	test('hook_confirm renders Hook + Description + Impact + Command sections', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('hook_confirm', {
			hook_name: 'H14_TagDocCheck',
			description: 'Validates tag document structure',
			impact: 'Blocks downstream V4',
			command: 'python -m chipos.h14',
		}));
		// hook_confirm body should include all 4 fields. It uses **Hook:** label
		// but that's hook_specifier territory (worker-side path), NOT the
		// dedup case — hook cards use _hookSpecifier not _cardSpecifier and
		// the hook header chip shows hook_name verbatim. The body's **Hook:**
		// line was actually intentional pre-2026-05-26 audit (the hook header
		// shows the *hook_name*; body **Hook:** is conventional context).
		// We leave it for now — not in our 4 dedup commits.
		assert.match(body, /Hook/);
		assert.match(body, /Validates tag document structure/);
		assert.match(body, /Blocks downstream V4/);
		assert.match(body, /python -m chipos\.h14/);
	});

	test('agent_ask body renders questions when present', () => {
		const body = ChipOSChatAgent._renderConfirmMessage(makePayload('agent_ask', {
			context: '在开始之前，我需要确认几个设计参数:',
			questions: [
				{ prompt: 'AXI 地址位宽?', options: [{ label: '32-bit', action_id: '32' }] },
			],
		}));
		assert.match(body, /AXI 地址位宽/);
		assert.match(body, /32-bit/);
	});
});
