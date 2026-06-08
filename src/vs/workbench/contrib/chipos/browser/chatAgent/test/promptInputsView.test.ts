/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { formatPromptInputs } from '../promptInputsView.js';
import { CollectResult } from '../../resources/promptResourceAttachmentCollector.js';
import { PromptResourceAttachment } from '../statelessInvoke/types.js';

/**
 * FEAT-008 — unit tests for the pure {@link formatPromptInputs} display formatter.
 * No VS Code / DOM dependency: drives every render branch from a CollectResult.
 */
suite('formatPromptInputs (FEAT-008 Show Prompt Inputs)', () => {

	function att(over: Partial<PromptResourceAttachment>): PromptResourceAttachment {
		return {
			kind: 'rule', name: 'r', description: '', source: 'workspace',
			source_ref: '', reason: 'always', priority: 0, payload: { body: '' },
			...over,
		};
	}

	test('maps attachments to rows (name/kind/source/reason) + counts omitted', () => {
		const result: CollectResult = {
			attachments: [
				att({ name: 'style', source: 'user', reason: 'always', description: 'house style' }),
				att({ name: 'api', source: 'workspace', reason: 'glob:src/**' }),
			],
			omitted: [{ name: 'big', reason: 'maxBytes' }],
		};

		assert.deepStrictEqual(formatPromptInputs(result), {
			rows: [
				{ kind: 'rule', name: 'style', source: 'user', reason: 'always', description: 'house style' },
				{ kind: 'rule', name: 'api', source: 'workspace', reason: 'glob:src/**', description: '' },
			],
			omitted: [{ name: 'big', reason: 'maxBytes' }],
			summary: '2 注入 / 1 省略',
		} satisfies ReturnType<typeof formatPromptInputs>);
	});

	test('empty result → empty view + 本轮无 prompt 资源', () => {
		assert.deepStrictEqual(formatPromptInputs({ attachments: [], omitted: [] }), {
			rows: [], omitted: [], summary: '本轮无 prompt 资源',
		} satisfies ReturnType<typeof formatPromptInputs>);
	});

	test('undefined (no turn sent yet) → empty view + 本轮无 prompt 资源', () => {
		assert.deepStrictEqual(formatPromptInputs(undefined), {
			rows: [], omitted: [], summary: '本轮无 prompt 资源',
		} satisfies ReturnType<typeof formatPromptInputs>);
	});

	test('only omitted (all truncated) → summary discloses the omission', () => {
		assert.deepStrictEqual(formatPromptInputs({ attachments: [], omitted: [{ name: 'a', reason: 'maxCount' }, { name: 'b', reason: 'maxCount' }] }), {
			rows: [], omitted: [{ name: 'a', reason: 'maxCount' }, { name: 'b', reason: 'maxCount' }], summary: '本轮无注入；2 项被省略',
		} satisfies ReturnType<typeof formatPromptInputs>);
	});
});
