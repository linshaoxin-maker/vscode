/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IModelDiscoveryService } from './modelDiscoveryService.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ShowPromptInputsAction } from './showPromptInputsAction.js';
import { ShowHookLogAction } from './showHookLogAction.js';
import { TestHookFileAction } from './testHookFileAction.js';

const CHIPOS_CATEGORY = localize2('chipos.category', 'ChipOS');

class ToggleThinkingAction extends Action2 {
	static readonly ID = 'chipos.toggleThinking';

	constructor() {
		super({
			id: ToggleThinkingAction.ID,
			title: localize2('chipos.toggleThinking', 'Toggle Thinking'),
			category: CHIPOS_CATEGORY,
			icon: Codicon.lightbulb,
			f1: false,
			toggled: ContextKeyExpr.has('config.chipos.showThinking'),
			menu: [{
				id: MenuId.ChatInput,
				group: 'chipos',
				order: 200,
			}],
		});
	}

	override run(accessor: ServicesAccessor): void {
		const configService = accessor.get(IConfigurationService);
		const current = configService.getValue<boolean>('chipos.showThinking') ?? false;
		configService.updateValue('chipos.showThinking', !current, ConfigurationTarget.USER);
	}
}

class CycleAutoApproveModeAction extends Action2 {
	static readonly ID = 'chipos.cycleAutoApprove';

	private static readonly MODES = ['strict', 'standard', 'full_auto'] as const;

	constructor() {
		super({
			id: CycleAutoApproveModeAction.ID,
			title: localize2('chipos.cycleAutoApprove', 'Cycle Auto-Approve Mode'),
			category: CHIPOS_CATEGORY,
			icon: Codicon.shield,
			f1: false,
			toggled: ContextKeyExpr.notEquals('config.chipos.autoApproveMode', 'strict'),
			menu: [{
				id: MenuId.ChatInput,
				group: 'chipos',
				order: 201,
			}],
		});
	}

	override run(accessor: ServicesAccessor): void {
		const configService = accessor.get(IConfigurationService);
		const current = configService.getValue<string>('chipos.autoApproveMode') ?? 'standard';
		const idx = CycleAutoApproveModeAction.MODES.indexOf(current as typeof CycleAutoApproveModeAction.MODES[number]);
		const next = CycleAutoApproveModeAction.MODES[(idx + 1) % CycleAutoApproveModeAction.MODES.length];
		configService.updateValue('chipos.autoApproveMode', next, ConfigurationTarget.USER);
	}
}

class ModelPickerAction extends Action2 {
	static readonly ID = 'chipos.pickModel';

	constructor() {
		super({
			id: ModelPickerAction.ID,
			title: localize2('chipos.pickModel', 'Select Model'),
			category: CHIPOS_CATEGORY,
			icon: Codicon.symbolClass,
			f1: false,
			menu: [{
				id: MenuId.ChatInput,
				group: 'chipos',
				order: 202,
			}],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const modelDiscoveryService = accessor.get(IModelDiscoveryService);

		const currentModel = configService.getValue<string>('chipos.model') || '';
		const currentProvider = configService.getValue<string>('chipos.provider') || 'zhipu';
		const apiKey = configService.getValue<string>('chipos.apiKey') || '';

		const models = await modelDiscoveryService.fetchModels(currentProvider, apiKey);

		const items: (IQuickPickItem | IQuickPickSeparator)[] = [];
		items.push({ type: 'separator', label: currentProvider.toUpperCase() });
		for (const m of models) {
			items.push({
				label: m.displayName,
				description: m.id === currentModel ? '$(check) current' : m.description,
				id: m.id,
				picked: m.id === currentModel,
			} as IQuickPickItem);
		}

		const picked = await quickInputService.pick(items, {
			placeHolder: localize('chipos.pickModel.placeholder', 'Select a model...'),
			canPickMany: false,
		});

		if (picked && 'id' in picked && picked.id) {
			await configService.updateValue('chipos.model', picked.id, ConfigurationTarget.USER);
		}
	}
}

export function registerChipOSQuickToggles(): void {
	registerAction2(ToggleThinkingAction);
	registerAction2(CycleAutoApproveModeAction);
	registerAction2(ModelPickerAction);
	registerAction2(ShowPromptInputsAction); // FEAT-008
	registerAction2(ShowHookLogAction); // FEAT-004 B6
	registerAction2(TestHookFileAction); // FEAT-004 B6
}
