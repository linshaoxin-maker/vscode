/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CollectResult } from '../resources/promptResourceAttachmentCollector.js';

/**
 * FEAT-008 — Show Prompt Inputs (GAP-20 observability).
 *
 * Pure formatter: turns the most recent per-turn {@link CollectResult} (the prompt
 * resources actually attached to the last stateless invoke) into a display model
 * for the "ChipOS: Show Prompt Inputs" command. Kept dependency-free (no VS Code
 * imports) so it unit-tests in node and the command stays a thin renderer.
 *
 * Shows name/kind/source/reason only — NOT the rule/command body (avoids leaking
 * content + matches the lazy-load contract; a body detail view is a follow-up).
 */

export interface PromptInputRow {
	readonly kind: string;
	readonly name: string;
	readonly source: string;
	readonly reason: string;
	readonly description: string;
}

export interface PromptInputsView {
	readonly rows: readonly PromptInputRow[];
	readonly omitted: readonly { readonly name: string; readonly reason: string }[];
	readonly summary: string;
}

/**
 * Format the last collected prompt resources for display. `undefined` (no turn
 * sent yet) and an empty attachment set both render an explicit empty state.
 */
export function formatPromptInputs(result: CollectResult | undefined): PromptInputsView {
	const attachments = result?.attachments ?? [];
	const omitted = result?.omitted ?? [];

	if (attachments.length === 0) {
		return {
			rows: [],
			omitted,
			summary: omitted.length ? `本轮无注入；${omitted.length} 项被省略` : '本轮无 prompt 资源',
		};
	}

	const rows: PromptInputRow[] = attachments.map(a => ({
		kind: a.kind,
		name: a.name,
		source: a.source ?? '',
		reason: a.reason ?? '',
		description: a.description ?? '',
	}));
	const summary = omitted.length ? `${rows.length} 注入 / ${omitted.length} 省略` : `${rows.length} 注入`;
	return { rows, omitted, summary };
}
