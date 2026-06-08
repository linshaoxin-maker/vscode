/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChiposHookLogService } from '../chatAgent/chiposHookLogService.js';

const CHIPOS_CATEGORY = localize2('chipos.category', 'ChipOS');

/**
 * FEAT-004 B6 — `ChipOS: Show Hook Execution Log`. Read-only QuickPick of recent
 * executable-hook evaluations (tool · decision · plugin · point · reason · time) —
 * the STRIDE-R audit trail for "what hook blocked/allowed what, when".
 */
export class ShowHookLogAction extends Action2 {
	static readonly ID = 'chipos.showHookLog';

	constructor() {
		super({
			id: ShowHookLogAction.ID,
			title: localize2('chipos.showHookLog', 'Show Hook Execution Log'),
			category: CHIPOS_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const log = accessor.get(IChiposHookLogService);
		const quickInput = accessor.get(IQuickInputService);
		const entries = log.recent();

		const items: IQuickPickItem[] = entries.length
			? entries.map(e => ({
				label: localize('chipos.showHookLog.row', '{0} — {1}', e.toolName, e.decision),
				description: localize('chipos.showHookLog.rowDesc', '{0} · {1}', e.pluginId, e.point),
				detail: (e.reason ? e.reason + ' · ' : '') + new Date(e.at).toLocaleTimeString(),
			}))
			: [{ label: localize('chipos.showHookLog.empty', 'No executable hook runs recorded yet'), description: localize('chipos.showHookLog.emptyHint', 'Trigger a tool while a function hook is active') }];

		await quickInput.pick(items, { placeHolder: localize('chipos.showHookLog.ph', 'Hook Execution Log — {0} recorded', entries.length) });
	}
}
