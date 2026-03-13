/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DiffComputer } from '../../../../../workbench/contrib/chipos/browser/inlineDiff/diffComputer.js';
import type { IEditOperation } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

suite('DiffComputer', () => {

	// ── applyEdits ────────────────────────────────────────────────────────

	suite('applyEdits', () => {

		test('returns unchanged content when edits are empty', () => {
			const content = 'line1\nline2\nline3';
			assert.strictEqual(DiffComputer.applyEdits(content, []), content);
		});

		test('replaces a single-line range', () => {
			const content = 'aaa\nbbb\nccc';
			const edits: IEditOperation[] = [
				{ range: { startLine: 2, startCol: 1, endLine: 2, endCol: 4 }, newText: 'xxx' },
			];
			assert.strictEqual(DiffComputer.applyEdits(content, edits), 'aaa\nxxx\nccc');
		});

		test('inserts a new line via newText containing newline', () => {
			const content = 'aaa\nccc';
			const edits: IEditOperation[] = [
				{ range: { startLine: 1, startCol: 4, endLine: 1, endCol: 4 }, newText: '\nbbb' },
			];
			assert.strictEqual(DiffComputer.applyEdits(content, edits), 'aaa\nbbb\nccc');
		});

		test('deletes a line by replacing with empty', () => {
			const content = 'aaa\nbbb\nccc';
			const edits: IEditOperation[] = [
				{ range: { startLine: 2, startCol: 1, endLine: 3, endCol: 1 }, newText: '' },
			];
			const result = DiffComputer.applyEdits(content, edits);
			assert.strictEqual(result, 'aaa\nccc');
		});

		test('applies multiple edits in correct order (reverse)', () => {
			const content = 'aaa\nbbb\nccc\nddd';
			const edits: IEditOperation[] = [
				{ range: { startLine: 1, startCol: 1, endLine: 1, endCol: 4 }, newText: 'AAA' },
				{ range: { startLine: 4, startCol: 1, endLine: 4, endCol: 4 }, newText: 'DDD' },
			];
			assert.strictEqual(DiffComputer.applyEdits(content, edits), 'AAA\nbbb\nccc\nDDD');
		});

		test('replaces multi-line range', () => {
			const content = 'aaa\nbbb\nccc\nddd';
			const edits: IEditOperation[] = [
				{ range: { startLine: 2, startCol: 1, endLine: 3, endCol: 4 }, newText: 'XXX' },
			];
			assert.strictEqual(DiffComputer.applyEdits(content, edits), 'aaa\nXXX\nddd');
		});

		test('handles partial-line edits', () => {
			const content = 'hello world';
			const edits: IEditOperation[] = [
				{ range: { startLine: 1, startCol: 6, endLine: 1, endCol: 6 }, newText: ' beautiful' },
			];
			assert.strictEqual(DiffComputer.applyEdits(content, edits), 'hello beautiful world');
		});

		test('skips edits with out-of-range lines', () => {
			const content = 'aaa\nbbb';
			const edits: IEditOperation[] = [
				{ range: { startLine: 10, startCol: 1, endLine: 10, endCol: 1 }, newText: 'xxx' },
			];
			assert.strictEqual(DiffComputer.applyEdits(content, edits), content);
		});
	});

	// ── compute ───────────────────────────────────────────────────────────

	suite('compute', () => {

		test('returns empty array for identical content', () => {
			const content = 'aaa\nbbb\nccc';
			const hunks = DiffComputer.compute(content, content);
			assert.strictEqual(hunks.length, 0);
		});

		test('returns empty array for both empty strings', () => {
			const hunks = DiffComputer.compute('', '');
			assert.strictEqual(hunks.length, 0);
		});

		test('detects a single insert hunk', () => {
			const oldContent = 'aaa\nccc';
			const newContent = 'aaa\nbbb\nccc';
			const hunks = DiffComputer.compute(oldContent, newContent);

			assert.ok(hunks.length >= 1);
			const insertHunk = hunks.find(h => h.type === 'insert' || h.newContent.includes('bbb'));
			assert.ok(insertHunk, 'Should have a hunk containing the inserted line');
		});

		test('detects a single delete hunk', () => {
			const oldContent = 'aaa\nbbb\nccc';
			const newContent = 'aaa\nccc';
			const hunks = DiffComputer.compute(oldContent, newContent);

			assert.ok(hunks.length >= 1);
			const deleteHunk = hunks.find(h => h.type === 'delete' || h.oldContent.includes('bbb'));
			assert.ok(deleteHunk, 'Should have a hunk containing the deleted line');
		});

		test('detects a modify hunk', () => {
			const oldContent = 'aaa\nbbb\nccc';
			const newContent = 'aaa\nBBB\nccc';
			const hunks = DiffComputer.compute(oldContent, newContent);

			assert.strictEqual(hunks.length, 1);
			assert.strictEqual(hunks[0].type, 'modify');
			assert.deepStrictEqual(hunks[0].oldContent, ['bbb']);
			assert.deepStrictEqual(hunks[0].newContent, ['BBB']);
		});

		test('detects multiple hunks', () => {
			const oldContent = 'aaa\nbbb\nccc\nddd';
			const newContent = 'AAA\nbbb\nCCC\nddd';
			const hunks = DiffComputer.compute(oldContent, newContent);

			assert.strictEqual(hunks.length, 2);
			assert.strictEqual(hunks[0].type, 'modify');
			assert.strictEqual(hunks[1].type, 'modify');
		});

		test('all hunks have pending status', () => {
			const hunks = DiffComputer.compute('aaa', 'bbb');
			for (const h of hunks) {
				assert.strictEqual(h.status, 'pending');
			}
		});

		test('all hunks have unique IDs', () => {
			const hunks = DiffComputer.compute('a\nb\nc', 'x\ny\nc');
			const ids = new Set(hunks.map(h => h.id));
			assert.strictEqual(ids.size, hunks.length);
		});

		test('detects old-only (complete deletion)', () => {
			const hunks = DiffComputer.compute('aaa\nbbb', '');
			assert.ok(hunks.length >= 1);
		});

		test('detects new-only (complete insertion)', () => {
			const hunks = DiffComputer.compute('', 'aaa\nbbb');
			assert.ok(hunks.length >= 1);
		});
	});

	// ── applyEdits + compute round-trip ───────────────────────────────────

	suite('round-trip', () => {

		test('apply then compute gives correct diff', () => {
			const oldContent = 'module counter(\n  input clk,\n  input rst\n);';
			const edits: IEditOperation[] = [
				{ range: { startLine: 3, startCol: 3, endLine: 3, endCol: 12 }, newText: 'input rst_n' },
			];
			const newContent = DiffComputer.applyEdits(oldContent, edits);
			const hunks = DiffComputer.compute(oldContent, newContent);

			assert.ok(hunks.length >= 1);
			assert.ok(newContent.includes('rst_n'));
		});
	});
});
