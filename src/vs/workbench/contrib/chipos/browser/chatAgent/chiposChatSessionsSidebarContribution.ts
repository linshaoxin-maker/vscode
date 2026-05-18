/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ChatViewId } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatViewPane } from '../../../../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';

/**
 * Toggle the ChipOS sessions sidebar from the chat tabs row's `[]` button.
 *
 * Implementation note: the framework also ships
 * `agentSessions.toggleAgentSessionsSidebar`, but that command cycles
 * the sessions-viewer **orientation enum** (`Stacked` ↔ `SideBySide`).
 * Our chipos chatViewPane patch force-pins orientation to `SideBySide`
 * to avoid the auto-stacking "chat falls to the bottom" UX trap, which
 * makes the framework toggle a no-op. Reach into `ChatViewPane`'s
 * `chiposToggleSessionsSidebar()` instead — it flips the visibility
 * override flag and re-layouts.
 */
CommandsRegistry.registerCommand('chipos.toggleChatSessionsSidebar', accessor => {
	const viewsService = accessor.get(IViewsService);
	const view = viewsService.getActiveViewWithId<ChatViewPane>(ChatViewId);
	if (!view) {
		// View not focused / not realized. Best-effort: ask viewsService to open it,
		// then toggle on the next macrotask after the view-pane has mounted.
		viewsService.openView<ChatViewPane>(ChatViewId)?.then(opened => {
			opened?.chiposToggleSessionsSidebar();
		});
		return;
	}
	view.chiposToggleSessionsSidebar();
});
