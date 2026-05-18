/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILifecycleService, LifecyclePhase } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';

/**
 * ChipOS Startup Focus contribution — after the workbench has restored
 * its layout, put keyboard focus on the chat panel's input editor.
 * Mirrors Cursor's behaviour: launch the IDE → cursor is already in the
 * chat composer, user can start typing immediately.
 *
 * Implementation notes:
 *   - We wait for `LifecyclePhase.Restored` so the chat view pane has
 *     definitely had a chance to render its widget.
 *   - We then poll a couple of times (with short backoff) because chat
 *     widget registration can lag the lifecycle phase by a microtask or
 *     two on some startup paths.
 *   - Once we successfully focus once, we stop — we don't keep stealing
 *     focus from the user if they've moved on to another control.
 */
export class ChipOSStartupFocusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.startupFocus';

	constructor(
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._lifecycleService.when(LifecyclePhase.Restored).then(() => this._tryFocus(0));
	}

	private _tryFocus(attempt: number): void {
		const widget = this._chatWidgetService.lastFocusedWidget
			?? this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat).find(w => w.viewModel)
			?? this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0];

		if (widget) {
			try {
				widget.focusInput();
				this._logService.trace('[ChipOS StartupFocus] focused chat input');
			} catch (err) {
				this._logService.warn('[ChipOS StartupFocus] focusInput failed', err);
			}
			return;
		}

		// No chat widget yet — back off and retry up to ~1s total.
		if (attempt >= 4) {
			this._logService.trace('[ChipOS StartupFocus] gave up after ' + (attempt + 1) + ' attempts');
			return;
		}
		setTimeout(() => this._tryFocus(attempt + 1), 200);
	}
}

registerWorkbenchContribution2(ChipOSStartupFocusContribution.ID, ChipOSStartupFocusContribution, WorkbenchPhase.AfterRestored);
