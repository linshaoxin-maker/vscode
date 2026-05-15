/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IModelDiscoveryService, ModelInfo } from '../settings/modelDiscoveryService.js';

/**
 * Command: `chipos.pickChatModel`
 *
 * Invoked from the chat input's model chip (patched in chatModelPicker.ts).
 * The chip passes its DOM element as the anchor so the dropdown opens
 * right next to it — matching the framework model picker's positioning
 * rather than the Command-Palette-style centered quickPick.
 *
 * Behavior:
 *   - Lists every model exposed by the current chipos provider's
 *     IModelDiscoveryService.fetchModels with a checkmark on the active one.
 *   - Picking writes back to chipos.model (ConfigurationTarget.USER) so the
 *     chat agent immediately routes through the new choice.
 *   - Bottom item "Open Model Settings…" is an escape hatch for users who
 *     need to change provider / API key (which this chip can't do).
 *   - Discovery failures fire a Warning notification but still surface the
 *     settings escape hatch.
 *   - When no anchor is provided (programmatic invoke), falls back to
 *     opening settings directly.
 */
export const CHIPOS_PICK_CHAT_MODEL_COMMAND_ID = 'chipos.pickChatModel';

type ChipOSModelPick =
	| { readonly kind: 'model'; readonly id: string }
	| { readonly kind: 'open-settings' };

CommandsRegistry.registerCommand(CHIPOS_PICK_CHAT_MODEL_COMMAND_ID, async (accessor, anchor?: HTMLElement) => {
	const configurationService = accessor.get(IConfigurationService);
	const actionWidgetService = accessor.get(IActionWidgetService);
	const modelDiscoveryService = accessor.get(IModelDiscoveryService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);

	if (!anchor) {
		// No anchor — caller didn't go through the chip path. Route to the
		// full settings page rather than rendering the dropdown at (0,0).
		commandService.executeCommand('chipos.openSettings', 'models');
		return;
	}

	const provider = configurationService.getValue<string>('chipos.provider') ?? '';
	const apiKey = configurationService.getValue<string>('chipos.apiKey') ?? '';
	const baseUrl = configurationService.getValue<string>('chipos.apiBaseUrl') ?? '';
	const currentModel = configurationService.getValue<string>('chipos.model') ?? '';

	if (!provider) {
		// Nothing useful to show in the dropdown — push the user to settings
		// to configure provider + key first.
		commandService.executeCommand('chipos.openSettings', 'models');
		return;
	}

	let models: ModelInfo[] = [];
	try {
		models = await modelDiscoveryService.fetchModels(provider, apiKey, baseUrl);
	} catch {
		notificationService.notify({
			severity: Severity.Warning,
			message: localize(
				'chipos.pickChatModel.discoveryFailed',
				'Could not list models from "{0}". Open Model Settings to check API key.',
				provider,
			),
		});
	}

	const items: IActionListItem<ChipOSModelPick>[] = models.map(m => {
		const checked = m.id === currentModel;
		return {
			item: { kind: 'model' as const, id: m.id },
			kind: ActionListItemKind.Action,
			label: m.displayName || m.id,
			description: m.displayName && m.displayName !== m.id ? m.id : undefined,
			group: { title: '', icon: ThemeIcon.fromId(checked ? Codicon.check.id : Codicon.blank.id) },
		};
	});

	items.push({ kind: ActionListItemKind.Separator });
	items.push({
		item: { kind: 'open-settings' as const },
		kind: ActionListItemKind.Action,
		label: localize('chipos.pickChatModel.openSettings', 'Open Model Settings…'),
		group: { title: '', icon: ThemeIcon.fromId(Codicon.gear.id) },
	});

	actionWidgetService.show(
		'ChipOSModelPicker',
		false,
		items,
		{
			onSelect: picked => {
				actionWidgetService.hide();
				if (!picked) {
					return;
				}
				if (picked.kind === 'open-settings') {
					commandService.executeCommand('chipos.openSettings', 'models');
					return;
				}
				if (picked.id !== currentModel) {
					// Fire-and-forget — the picker's onSelect is sync.
					configurationService.updateValue('chipos.model', picked.id, ConfigurationTarget.USER);
				}
			},
			onHide: () => { },
		},
		anchor,
		undefined,
		[],
	);
});
