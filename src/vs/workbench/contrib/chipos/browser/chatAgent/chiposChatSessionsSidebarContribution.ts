/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ChatViewId } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatViewPane } from '../../../../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';

/**
 * Sessions sidebar default width — kept in sync with
 * `ChatViewPane.SESSIONS_SIDEBAR_DEFAULT_WIDTH` so growing/shrinking
 * the auxiliary bar matches how much horizontal space the embedded
 * sessions sidebar reserves inside the chat panel.
 */
const SESSIONS_SIDEBAR_GROW_WIDTH = 300;

/**
 * Toggle the chipos sessions sidebar from the chat tabs row's `[]` button.
 *
 * Two-step coordinated behavior:
 *   1) Flip the embedded sessions sidebar visibility inside `ChatViewPane`
 *      via `chiposToggleSessionsSidebar()` (controls the per-pane override
 *      flag).
 *   2) Grow / shrink the auxiliary bar's width by ~300px in step with the
 *      toggle. This way the sessions sidebar appears as an ADDITIONAL
 *      column rather than stealing horizontal space from the chat widget
 *      — the chat panel's own content stays at the width the user had
 *      before.
 *
 * If the chat view isn't currently realized (no `getActiveViewWithId`
 * result), reveal it first via `openView`, then perform the same toggle
 * once the pane has mounted.
 */
CommandsRegistry.registerCommand('chipos.toggleChatSessionsSidebar', accessor => {
	const viewsService = accessor.get(IViewsService);
	const layoutService = accessor.get(IWorkbenchLayoutService);

	const applyToggle = (view: ChatViewPane) => {
		// Snapshot intended new visibility BEFORE flipping (the method has
		// no return value, so derive from current state).
		const willShow = !view.chiposIsSessionsSidebarVisible();

		// Grow / shrink the auxiliary bar so the sessions sidebar lands
		// as an additional column instead of compressing chat content.
		// `getSize` returns { width, height } at the part level.
		const currentSize = layoutService.getSize(Parts.AUXILIARYBAR_PART);
		const targetWidth = Math.max(
			0,
			willShow ? currentSize.width + SESSIONS_SIDEBAR_GROW_WIDTH : currentSize.width - SESSIONS_SIDEBAR_GROW_WIDTH
		);
		layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: targetWidth, height: currentSize.height });

		view.chiposToggleSessionsSidebar();
	};

	const view = viewsService.getActiveViewWithId<ChatViewPane>(ChatViewId);
	if (view) {
		applyToggle(view);
		return;
	}
	// Chat view not active — reveal it first, then toggle once it's mounted.
	viewsService.openView<ChatViewPane>(ChatViewId)?.then(opened => {
		if (opened) {
			applyToggle(opened);
		}
	});
});
