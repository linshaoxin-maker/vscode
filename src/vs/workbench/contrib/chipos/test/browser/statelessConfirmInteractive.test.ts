/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `ChipOSChatAgent._extractInteractiveAskQuestions` — the
 * static helper that decides whether a stateless confirm card renders the
 * interactive radio FORM (vs. falling back to markdown).
 *
 * Background (ADR-018 stateless migration, owner-audit item ④): the stateless
 * handler used to gate the radio form on `card_type === 'agent_ask'`. But a
 * stateless confirm card is the LLM emitting a `chipos_user_confirm` tool whose
 * `card_type` it picks ad-hoc — so any other label carrying the same
 * questions[] shape degraded to plain markdown. The fix makes detection
 * card-type-AGNOSTIC: it keys on the SHAPE of card_data. These tests pin that
 * the helper (a) fires for a non-`agent_ask` label with well-formed questions,
 * (b) still fires for `agent_ask` (no regression), (c) returns undefined for
 * cards with no questions (permission_ask / generic) so they keep their
 * structured / markdown rendering, and (d) filters mal-shaped questions.
 */

import assert from 'assert';
import { ChipOSChatAgent } from '../../browser/chatAgent/chipOSChatAgent.js';

const WELL_FORMED_QUESTIONS = [
	{
		question_id: 'data_width',
		prompt: 'AXI data width?',
		options: [
			{ action_id: 'w32', label: '32-bit' },
			{ action_id: 'w64', label: '64-bit' },
		],
	},
];

suite('ChipOSChatAgent._extractInteractiveAskQuestions — card-type-agnostic interactive form', () => {

	test('NON-agent_ask label with well-formed questions[] → interactive (the generalization)', () => {
		// The core regression this fix closes: a card the stateless LLM labelled
		// anything other than "agent_ask" must STILL render the radio form when
		// it carries well-formed questions.
		for (const cardTypeNoLongerSpecial of ['generic', 'coverage_confirm', 'negotiation_confirm', 'design_confirm']) {
			const out = ChipOSChatAgent._extractInteractiveAskQuestions({
				card_type: cardTypeNoLongerSpecial,
				questions: WELL_FORMED_QUESTIONS,
			});
			assert.ok(out !== undefined, `${cardTypeNoLongerSpecial} should be interactive`);
			assert.deepStrictEqual(out, WELL_FORMED_QUESTIONS, `${cardTypeNoLongerSpecial} normalized shape`);
		}
	});

	test('agent_ask with well-formed questions[] → interactive (no regression)', () => {
		const out = ChipOSChatAgent._extractInteractiveAskQuestions({ questions: WELL_FORMED_QUESTIONS });
		assert.deepStrictEqual(out, WELL_FORMED_QUESTIONS);
	});

	test('card with NO questions[] → undefined (permission_ask / generic stay non-form)', () => {
		// A worker permission_ask card carries options/payload but no questions —
		// it must NOT be treated as a radio form (it renders structured fields).
		const permissionAsk = ChipOSChatAgent._extractInteractiveAskQuestions({
			tool: 'run_in_terminal',
			payload: 'rm -rf build/',
			options: [{ action_id: 'allow_once', label: '允许一次' }],
		});
		assert.strictEqual(permissionAsk, undefined);
		// A generic card with only a message likewise has no questions.
		assert.strictEqual(ChipOSChatAgent._extractInteractiveAskQuestions({ message: 'proceed?' }), undefined);
	});

	test('mal-shaped questions are filtered; all-bad → undefined (falls back to markdown)', () => {
		// Missing question_id, empty options, and options without action_id are
		// all dropped. If nothing well-formed survives, return undefined.
		const out = ChipOSChatAgent._extractInteractiveAskQuestions({
			questions: [
				{ prompt: 'no id', options: [{ action_id: 'a', label: 'A' }] },   // no question_id → dropped
				{ question_id: 'q2', options: [] },                                // empty options → dropped
				{ question_id: 'q3', options: [{ label: 'no action_id' }] },       // option lacks action_id → options empty → dropped
			],
		});
		assert.strictEqual(out, undefined);
	});

	test('keeps only well-formed questions when mixed with bad ones', () => {
		const out = ChipOSChatAgent._extractInteractiveAskQuestions({
			questions: [
				{ question_id: 'bad', options: [] },
				...WELL_FORMED_QUESTIONS,
			],
		});
		assert.deepStrictEqual(out, WELL_FORMED_QUESTIONS);
	});

	test('normalization: prompt defaults to question_id, option label defaults to action_id', () => {
		const out = ChipOSChatAgent._extractInteractiveAskQuestions({
			questions: [
				{ question_id: 'fifo_depth', options: [{ action_id: 'd16' }] },   // no prompt, no label
			],
		});
		assert.deepStrictEqual(out, [
			{ question_id: 'fifo_depth', prompt: 'fifo_depth', options: [{ action_id: 'd16', label: 'd16' }] },
		]);
	});

	test('non-array questions field → undefined', () => {
		assert.strictEqual(ChipOSChatAgent._extractInteractiveAskQuestions({ questions: 'not-an-array' }), undefined);
		assert.strictEqual(ChipOSChatAgent._extractInteractiveAskQuestions({}), undefined);
	});
});
