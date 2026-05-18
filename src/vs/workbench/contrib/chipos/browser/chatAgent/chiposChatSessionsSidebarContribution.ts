/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ChatSessionsViewPane } from '../../../../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatSessionsViewPane.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';

/**
 * Toggle the chipos sessions sidebar from the chat tabs row's `[]` button.
 *
 * Now that the sessions list lives in its own VS Code `ViewPane`
 * (`ChatSessionsViewPane`), this is just a wrapper around
 * `IViewsService.openView` / `closeView`. The view sits as a sibling of
 * the chat view in the same view container, so showing/hiding it lets
 * VS Code's view-grid lay out an additional column — the chat panel's
 * own width is preserved.
 */
CommandsRegistry.registerCommand('chipos.toggleChatSessionsSidebar', accessor => {
	const viewsService = accessor.get(IViewsService);
	if (viewsService.isViewVisible(ChatSessionsViewPane.ID)) {
		viewsService.closeView(ChatSessionsViewPane.ID);
	} else {
		viewsService.openView(ChatSessionsViewPane.ID, /* focus */ false);
	}
});
