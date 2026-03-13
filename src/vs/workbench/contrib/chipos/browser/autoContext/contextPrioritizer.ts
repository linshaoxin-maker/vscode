/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import type { IMentionItem } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { ContextSourceType, IContextItem, IContextCollectionResult } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const CHARS_PER_TOKEN = 4;

/** Lower number = higher priority. Mention content is injected at priority 0. */
const SOURCE_PRIORITY: Record<string, number> = {
	[ContextSourceType.Selection]: 1,
	[ContextSourceType.ActiveFile]: 2,
	[ContextSourceType.GitDiff]: 3,
	[ContextSourceType.Linter]: 4,
	[ContextSourceType.RecentEdit]: 5,
	[ContextSourceType.Terminal]: 6,
	[ContextSourceType.GitLog]: 7,
	[ContextSourceType.ProjectStructure]: 8,
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function mentionToContextItem(item: IMentionItem): IContextItem {
	const content = item.content
		? `@${item.displayName}\n${item.content}`
		: `@${item.displayName} (${item.path})`;
	return {
		source: ContextSourceType.Selection,
		content,
		priority: 0, // never trimmed
		tokenEstimate: estimateTokens(content),
		metadata: { mention: true, path: item.path },
	};
}

export class ContextPrioritizer {

	prioritize(
		items: IContextItem[],
		mentionItems: IMentionItem[],
		tokenBudget: number,
	): IContextCollectionResult {
		const mentionContextItems = mentionItems.map(mentionToContextItem);
		const allItems = [...mentionContextItems, ...items];

		allItems.sort((a, b) => {
			const pa = a.priority !== undefined ? a.priority : (SOURCE_PRIORITY[a.source] ?? 99);
			const pb = b.priority !== undefined ? b.priority : (SOURCE_PRIORITY[b.source] ?? 99);
			return pa - pb;
		});

		const accepted: IContextItem[] = [];
		const trimmedSources = new Set<ContextSourceType>();
		let totalTokens = 0;

		for (const item of allItems) {
			const isMention = item.priority === 0 && item.metadata?.mention;

			if (isMention) {
				accepted.push(item);
				totalTokens += item.tokenEstimate;
				continue;
			}

			if (totalTokens + item.tokenEstimate <= tokenBudget) {
				accepted.push(item);
				totalTokens += item.tokenEstimate;
			} else {
				const remaining = tokenBudget - totalTokens;
				if (remaining > 50) {
					const truncatedContent = item.content.slice(0, remaining * CHARS_PER_TOKEN);
					const truncated: IContextItem = {
						source: item.source,
						content: truncatedContent + '\n... [truncated]',
						priority: item.priority,
						tokenEstimate: estimateTokens(truncatedContent),
						metadata: { ...item.metadata, truncated: true },
					};
					accepted.push(truncated);
					totalTokens += truncated.tokenEstimate;
					trimmedSources.add(item.source);
				} else {
					trimmedSources.add(item.source);
				}
			}
		}

		return {
			items: accepted,
			totalTokens,
			trimmedSources: [...trimmedSources],
		};
	}
}
