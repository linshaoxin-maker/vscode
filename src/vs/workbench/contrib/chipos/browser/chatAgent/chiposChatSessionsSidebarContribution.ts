/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';

/**
 * Backwards-compat shim — the previous chipos chat sessions sidebar
 * (a fork of Cursor's history UI built into the chat panel) was reverted
 * because the framework already ships the equivalent
 * `agentSessions.toggleAgentSessionsSidebar` view with archive/status
 * support out of the box. To avoid breaking anything wired up against
 * the old chipos command id, keep the id alive and just dispatch the
 * framework command.
 */
CommandsRegistry.registerCommand('chipos.toggleChatSessionsSidebar', accessor => {
	const commandService = accessor.get(ICommandService);
	return commandService.executeCommand('agentSessions.toggleAgentSessionsSidebar');
});
