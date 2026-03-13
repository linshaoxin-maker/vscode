/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ContextPrioritizer } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextPrioritizer.js';
import { ContextSourceType, type IContextItem } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';
import type { IMentionItem } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

function createItem(source: ContextSourceType, priority: number, content: string): IContextItem {
	return { source, content, priority, tokenEstimate: Math.ceil(content.length / 4) };
}

function createMention(displayName: string, path: string, content?: string): IMentionItem {
	return { path, type: 'file', displayName, content };
}

suite('ContextPrioritizer', () => {

	let prioritizer: ContextPrioritizer;

	setup(() => {
		prioritizer = new ContextPrioritizer();
	});

	// ── Priority sorting ──────────────────────────────────────────────────

	test('sorts items by priority ascending', () => {
		const items: IContextItem[] = [
			createItem(ContextSourceType.Terminal, 6, 'terminal output'),
			createItem(ContextSourceType.Selection, 1, 'selected text'),
			createItem(ContextSourceType.GitDiff, 3, 'diff content'),
		];

		const result = prioritizer.prioritize(items, [], 10_000);

		assert.strictEqual(result.items[0].source, ContextSourceType.Selection);
		assert.strictEqual(result.items[1].source, ContextSourceType.GitDiff);
		assert.strictEqual(result.items[2].source, ContextSourceType.Terminal);
	});

	// ── Token budget trimming ─────────────────────────────────────────────

	test('trims lowest priority items when budget exceeded', () => {
		const items: IContextItem[] = [
			createItem(ContextSourceType.Selection, 1, 'a'.repeat(100)),
			createItem(ContextSourceType.ActiveFile, 2, 'b'.repeat(100)),
			createItem(ContextSourceType.Terminal, 6, 'c'.repeat(400)),
		];
		// total tokens: 25 + 25 + 100 = 150; budget = 60
		const result = prioritizer.prioritize(items, [], 60);

		const sources = result.items.map(i => i.source);
		assert.ok(sources.includes(ContextSourceType.Selection));
		assert.ok(sources.includes(ContextSourceType.ActiveFile));
		assert.ok(result.totalTokens <= 60 + 10); // allow small overshoot from truncation rounding
		assert.ok(result.trimmedSources.includes(ContextSourceType.Terminal));
	});

	// ── @mention items are never trimmed ──────────────────────────────────

	test('never trims @mention items', () => {
		const items: IContextItem[] = [
			createItem(ContextSourceType.Terminal, 6, 'c'.repeat(200)),
		];
		const mentions: IMentionItem[] = [
			createMention('counter.v', '/project/counter.v', 'module counter; endmodule'),
		];
		// Set budget extremely tight — mentions should still be included
		const result = prioritizer.prioritize(items, mentions, 5);

		const mentionItem = result.items.find(i => i.metadata?.mention === true);
		assert.ok(mentionItem, 'Mention item should always be present');
		assert.ok(mentionItem!.content.includes('counter.v'));
	});

	// ── Partial truncation ────────────────────────────────────────────────

	test('truncates individual items for partial fit', () => {
		const items: IContextItem[] = [
			createItem(ContextSourceType.Selection, 1, 'a'.repeat(40)),
			createItem(ContextSourceType.ActiveFile, 2, 'b'.repeat(800)),
		];
		// First item = 10 tokens; second = 200 tokens; budget = 80
		// After first item, 70 tokens remain (> 50 threshold), so second gets truncated
		const result = prioritizer.prioritize(items, [], 80);

		assert.strictEqual(result.items.length, 2);
		const truncatedItem = result.items.find(i => i.metadata?.truncated === true);
		assert.ok(truncatedItem, 'Should have a truncated item');
		assert.ok(truncatedItem!.content.includes('[truncated]'));
		assert.ok(truncatedItem!.content.length < 800);
	});

	// ── All items fit ─────────────────────────────────────────────────────

	test('returns all items when within budget', () => {
		const items: IContextItem[] = [
			createItem(ContextSourceType.Selection, 1, 'short'),
			createItem(ContextSourceType.GitDiff, 3, 'also short'),
		];

		const result = prioritizer.prioritize(items, [], 10_000);

		assert.strictEqual(result.items.length, 2);
		assert.deepStrictEqual(result.trimmedSources, []);
	});

	// ── Empty input ───────────────────────────────────────────────────────

	test('handles empty input', () => {
		const result = prioritizer.prioritize([], [], 1000);

		assert.strictEqual(result.items.length, 0);
		assert.strictEqual(result.totalTokens, 0);
		assert.deepStrictEqual(result.trimmedSources, []);
	});

	// ── Trimmed source reporting ──────────────────────────────────────────

	test('reports trimmed sources', () => {
		const items: IContextItem[] = [
			createItem(ContextSourceType.Selection, 1, 'a'.repeat(40)),
			createItem(ContextSourceType.GitLog, 7, 'x'.repeat(400)),
			createItem(ContextSourceType.ProjectStructure, 8, 'y'.repeat(400)),
		];
		// budget = 15 tokens → first item fits (10 tokens), rest don't
		const result = prioritizer.prioritize(items, [], 15);

		assert.ok(result.trimmedSources.length > 0);
		assert.ok(
			result.trimmedSources.includes(ContextSourceType.ProjectStructure)
			|| result.trimmedSources.includes(ContextSourceType.GitLog),
		);
	});
});
