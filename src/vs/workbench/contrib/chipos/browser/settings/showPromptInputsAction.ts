/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChiposPromptInputsService } from '../chatAgent/chiposPromptInputsService.js';
import { formatPromptInputs } from '../chatAgent/promptInputsView.js';

const CHIPOS_CATEGORY = localize2('chipos.category', 'ChipOS');

/**
 * FEAT-008 — `ChipOS: Show Prompt Inputs`. Renders the most recent turn's prompt
 * resources (kind/name/source/reason) + omitted (truncation reason) + a summary,
 * as a read-only QuickPick. The observable proof of "which rules/commands the
 * agent actually got" — the acceptance anchor for the Wave-0 rule/command demos.
 */
export class ShowPromptInputsAction extends Action2 {
	static readonly ID = 'chipos.showPromptInputs';

	constructor() {
		super({
			id: ShowPromptInputsAction.ID,
			title: localize2('chipos.showPromptInputs', 'Show Prompt Inputs'),
			category: CHIPOS_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const promptInputs = accessor.get(IChiposPromptInputsService);
		const quickInput = accessor.get(IQuickInputService);

		const last = promptInputs.getLast();
		const view = formatPromptInputs(last?.result);

		const items: (IQuickPickItem | IQuickPickSeparator)[] = [];
		if (view.rows.length) {
			items.push({ type: 'separator', label: localize('chipos.showPromptInputs.attached', 'Attached ({0})', view.rows.length) });
			for (const r of view.rows) {
				items.push({
					label: r.name,
					description: localize('chipos.showPromptInputs.rowDesc', '{0} · {1} · {2}', r.kind, r.source, r.reason),
					detail: r.description || undefined,
				});
			}
		}
		if (view.omitted.length) {
			items.push({ type: 'separator', label: localize('chipos.showPromptInputs.omitted', 'Omitted ({0})', view.omitted.length) });
			for (const o of view.omitted) {
				items.push({ label: o.name, description: localize('chipos.showPromptInputs.omittedReason', 'omitted: {0}', o.reason) });
			}
		}
		if (!items.length) {
			items.push({ label: view.summary, description: localize('chipos.showPromptInputs.empty', 'Send a chat turn first') });
		}

		const placeHolder = last?.activeFile
			? localize('chipos.showPromptInputs.phFile', 'Prompt Inputs — {0} (for {1})', view.summary, last.activeFile)
			: localize('chipos.showPromptInputs.ph', 'Prompt Inputs — {0}', view.summary);
		await quickInput.pick(items, { placeHolder });
	}
}
