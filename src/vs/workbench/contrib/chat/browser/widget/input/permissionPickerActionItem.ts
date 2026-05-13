/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { ChatConfiguration, ChatPermissionLevel } from '../../../common/constants.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import Severity from '../../../../../../base/common/severity.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';

// Track whether warnings have been shown this VS Code session
const shownWarnings = new Set<ChatPermissionLevel>();

function hasShownElevatedWarning(level: ChatPermissionLevel): boolean {
	if (shownWarnings.has(level)) {
		return true;
	}
	// Autopilot is stricter than AutoApprove, so confirming Autopilot
	// implies the user already accepted the AutoApprove risks.
	if (level === ChatPermissionLevel.AutoApprove && shownWarnings.has(ChatPermissionLevel.Autopilot)) {
		return true;
	}
	return false;
}

export interface IPermissionPickerDelegate {
	readonly currentPermissionLevel: IObservable<ChatPermissionLevel>;
	readonly setPermissionLevel: (level: ChatPermissionLevel) => void;
}

export class PermissionPickerActionItem extends ChatInputPickerActionViewItem {
	constructor(
		action: MenuItemAction,
		private readonly delegate: IPermissionPickerDelegate,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		const isAutoApprovePolicyRestricted = () => configurationService.inspect<boolean>(ChatConfiguration.GlobalAutoApprove).policyValue === false;
		const isAutopilotEnabled = () => configurationService.getValue<boolean>(ChatConfiguration.AutopilotEnabled) !== false;
		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => {
				const currentLevel = delegate.currentPermissionLevel.get();
				const policyRestricted = isAutoApprovePolicyRestricted();
				const actions: IActionWidgetDropdownAction[] = [
					{
						...action,
						id: 'chat.permissions.default',
						label: localize('permissions.default', "Default"),
						description: localize('permissions.default.subtext', "Use rules; ask before risky actions"),
						icon: ThemeIcon.fromId(Codicon.shield.id),
						checked: currentLevel === ChatPermissionLevel.Default,
						tooltip: '',
						hover: {
							content: localize('permissions.default.description', "Apply the 5-layer PermissionGate; show a 4-button card when a tool needs approval."),
							position: pickerOptions.hoverPosition
						},
						run: async () => {
							delegate.setPermissionLevel(ChatPermissionLevel.Default);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction,
					{
						...action,
						id: 'chat.permissions.autoApprove',
						label: localize('permissions.autoApprove', "Auto-Run"),
						description: localize('permissions.autoApprove.subtext', "Auto-approve all tools within a turn; stop after each turn"),
						icon: ThemeIcon.fromId(Codicon.warning.id),
						checked: currentLevel === ChatPermissionLevel.AutoApprove,
						enabled: !policyRestricted,
						tooltip: policyRestricted ? localize('permissions.autoApprove.policyDisabled', "Disabled by enterprise policy") : '',
						hover: {
							content: policyRestricted
								? localize('permissions.autoApprove.policyDescription', "Disabled by enterprise policy")
								: localize('permissions.autoApprove.description', "Skip every approval card within a turn. The agent still stops after each turn so you can decide what to do next."),
							position: pickerOptions.hoverPosition
						},
						run: async () => {
							if (!hasShownElevatedWarning(ChatPermissionLevel.AutoApprove)) {
								const result = await this.dialogService.prompt({
									type: Severity.Warning,
									message: localize('permissions.autoApprove.warning.title', "Enable Auto-Run?"),
									buttons: [
										{
											label: localize('permissions.autoApprove.warning.confirm', "Enable"),
											run: () => true
										},
										{
											label: localize('permissions.autoApprove.warning.cancel', "Cancel"),
											run: () => false
										},
									],
									custom: {
										icon: Codicon.warning,
										markdownDetails: [{
											markdown: new MarkdownString(localize('permissions.autoApprove.warning.detail', "Auto-Run will auto-approve every tool call within a turn — file edits, terminal commands, and external tools — without asking for confirmation. The agent still stops after each turn so you can decide what to do next.")),
										}],
									},
								});
								if (result.result !== true) {
									return;
								}
								shownWarnings.add(ChatPermissionLevel.AutoApprove);
							}
							delegate.setPermissionLevel(ChatPermissionLevel.AutoApprove);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction,
				];
				if (isAutopilotEnabled()) {
					actions.push({
						...action,
						id: 'chat.permissions.autopilot',
						label: localize('permissions.autopilot', "Full Auto"),
						description: localize('permissions.autopilot.subtext', "Auto-approve and auto-continue across turns until the task is done"),
						icon: ThemeIcon.fromId(Codicon.rocket.id),
						checked: currentLevel === ChatPermissionLevel.Autopilot,
						enabled: !policyRestricted,
						tooltip: policyRestricted ? localize('permissions.autopilot.policyDisabled', "Disabled by enterprise policy") : '',
						hover: {
							content: policyRestricted
								? localize('permissions.autopilot.policyDescription', "Disabled by enterprise policy")
								: localize('permissions.autopilot.description', "Auto-approve every tool call AND automatically continue working across turns until the task is done."),
							position: pickerOptions.hoverPosition
						},
						run: async () => {
							if (!hasShownElevatedWarning(ChatPermissionLevel.Autopilot)) {
								const result = await this.dialogService.prompt({
									type: Severity.Warning,
									message: localize('permissions.autopilot.warning.title', "Enable Full Auto?"),
									buttons: [
										{
											label: localize('permissions.autopilot.warning.confirm', "Enable"),
											run: () => true
										},
										{
											label: localize('permissions.autopilot.warning.cancel', "Cancel"),
											run: () => false
										},
									],
									custom: {
										icon: Codicon.rocket,
										markdownDetails: [{
											markdown: new MarkdownString(localize('permissions.autopilot.warning.detail', "Full Auto will auto-approve every tool call AND automatically continue working across turns until the task is done. The agent will make decisions on your behalf without asking for confirmation, and will not stop after each turn.\n\nYou can stop the agent at any time by clicking the stop button. This applies to the current session only.")),
										}],
									},
								});
								if (result.result !== true) {
									return;
								}
								shownWarnings.add(ChatPermissionLevel.Autopilot);
							}
							delegate.setPermissionLevel(ChatPermissionLevel.Autopilot);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction);
				}
				return actions;
			}
		};

		super(action, {
			actionProvider,
			reporter: { id: 'ChatPermissionPicker', name: 'ChatPermissionPicker', includeOptions: true },
			listOptions: { descriptionBelow: true, minWidth: 255 },
		}, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);

		const level = this.delegate.currentPermissionLevel.get();
		let icon: ThemeIcon;
		let label: string;
		switch (level) {
			case ChatPermissionLevel.Autopilot:
				icon = Codicon.rocket;
				label = localize('permissions.autopilot.label', "Full Auto");
				break;
			case ChatPermissionLevel.AutoApprove:
				icon = Codicon.warning;
				label = localize('permissions.autoApprove.label', "Auto-Run");
				break;
			default:
				icon = Codicon.shield;
				label = localize('permissions.default.label', "Default");
				break;
		}

		const labelElements = [];
		labelElements.push(...renderLabelWithIcons(`$(${icon.id})`));
		labelElements.push(dom.$('span.chat-input-picker-label', undefined, label));
		labelElements.push(...renderLabelWithIcons(`$(chevron-down)`));

		dom.reset(element, ...labelElements);
		element.classList.toggle('warning', level === ChatPermissionLevel.Autopilot);
		element.classList.toggle('info', level === ChatPermissionLevel.AutoApprove);
		return null;
	}

	public refresh(): void {
		if (this.element) {
			this.renderLabel(this.element);
		}
	}
}
