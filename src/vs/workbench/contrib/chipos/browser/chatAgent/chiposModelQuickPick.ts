/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IModelDiscoveryService, ModelInfo } from '../settings/modelDiscoveryService.js';

/**
 * Command: `chipos.pickChatModel`
 *
 * The chat input toolbar's model chip (patched in chatModelPicker.ts) dispatches
 * this command when chipos.model is set. It shows a quickPick listing every
 * model exposed by the current provider's IModelDiscoveryService, with the
 * currently-active model pre-selected. Picking writes back to chipos.model so
 * the chat agent immediately starts routing through the new model — same
 * round-trip the Settings → Models tab provides, but reachable from the chat
 * input without leaving the conversation.
 *
 * An "Open Model Settings…" escape hatch sits at the bottom for users who
 * need to change provider or API key (which the chip-level picker can't do).
 */
export const CHIPOS_PICK_CHAT_MODEL_COMMAND_ID = 'chipos.pickChatModel';

const OPEN_SETTINGS_ITEM_ID = '__open_settings__';

CommandsRegistry.registerCommand(CHIPOS_PICK_CHAT_MODEL_COMMAND_ID, async accessor => {
	const configurationService = accessor.get(IConfigurationService);
	const quickInputService = accessor.get(IQuickInputService);
	const modelDiscoveryService = accessor.get(IModelDiscoveryService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);

	const provider = configurationService.getValue<string>('chipos.provider') ?? '';
	const apiKey = configurationService.getValue<string>('chipos.apiKey') ?? '';
	const baseUrl = configurationService.getValue<string>('chipos.apiBaseUrl') ?? '';
	const currentModel = configurationService.getValue<string>('chipos.model') ?? '';

	if (!provider) {
		// No provider configured — quickPick has nothing useful to show.
		// Route to settings where the user can fill in provider + key first.
		commandService.executeCommand('chipos.openSettings', 'models');
		return;
	}

	let models: ModelInfo[] = [];
	try {
		models = await modelDiscoveryService.fetchModels(provider, apiKey, baseUrl);
	} catch (err) {
		// Discovery failures fall through with an empty list — the
		// settings escape hatch is still useful to fix the credentials.
		notificationService.notify({
			severity: Severity.Warning,
			message: localize(
				'chipos.pickChatModel.discoveryFailed',
				'Could not list models from "{0}". Open Model Settings to check API key.',
				provider,
			),
		});
	}

	const modelItems: IQuickPickItem[] = models.map(m => ({
		id: m.id,
		label: m.displayName || m.id,
		description: m.displayName && m.displayName !== m.id ? m.id : undefined,
		picked: m.id === currentModel,
	}));

	const separator: IQuickPickSeparator = { type: 'separator' };
	const settingsItem: IQuickPickItem = {
		id: OPEN_SETTINGS_ITEM_ID,
		label: localize('chipos.pickChatModel.openSettings', '$(gear) Open Model Settings…'),
	};

	const placeHolder = currentModel
		? localize('chipos.pickChatModel.placeholder', 'Pick a model for ChipOS chat — current: {0}', currentModel)
		: localize('chipos.pickChatModel.placeholderEmpty', 'Pick a model for ChipOS chat');

	const picked = await quickInputService.pick(
		[...modelItems, separator, settingsItem],
		{ placeHolder, canPickMany: false },
	);

	if (!picked) {
		return;
	}
	if (picked.id === OPEN_SETTINGS_ITEM_ID) {
		commandService.executeCommand('chipos.openSettings', 'models');
		return;
	}
	if (picked.id && picked.id !== currentModel) {
		await configurationService.updateValue('chipos.model', picked.id, ConfigurationTarget.USER);
	}
});
