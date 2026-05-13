/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ChatConfiguration, ChatPermissionLevel } from '../../../../workbench/contrib/chat/common/constants.js';
import Severity from '../../../../base/common/severity.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';

// Track whether warnings have been shown this VS Code session
const shownWarnings = new Set<ChatPermissionLevel>();

interface IPermissionItem {
	readonly level: ChatPermissionLevel;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly checked: boolean;
}

/**
 * A permission picker for the new-session welcome view.
 *
 * Shows three Approval Modes:
 *   - Default   — use rules; ask before risky actions (5-layer PermissionGate)
 *   - Auto-Run  — auto-approve all tools within a turn; stop after each turn
 *   - Full Auto — auto-approve AND auto-continue across turns until done
 *
 * Renamed 2026-05-13 (was: Default Approvals / Bypass Approvals / Autopilot
 * Preview). The internal `ChatPermissionLevel` enum and the backend-side
 * `CHIPOS_APPROVAL_MODE` env value are unchanged for backward-compat — only
 * the UI labels move. See document/handbook/06-ide/11-mode-and-model-picker.md
 * for the rename rationale.
 */
export class NewChatPermissionPicker extends Disposable {

	private readonly _onDidChangeLevel = this._register(new Emitter<ChatPermissionLevel>());
	readonly onDidChangeLevel: Event<ChatPermissionLevel> = this._onDidChangeLevel.event;

	private _currentLevel: ChatPermissionLevel = ChatPermissionLevel.Default;
	private _triggerElement: HTMLElement | undefined;
	private _container: HTMLElement | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	get permissionLevel(): ChatPermissionLevel {
		return this._currentLevel;
	}

	constructor(
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
	}

	render(container: HTMLElement): HTMLElement {
		this._renderDisposables.clear();

		const slot = dom.append(container, dom.$('.sessions-chat-picker-slot'));
		this._container = slot;
		this._renderDisposables.add({ dispose: () => slot.remove() });

		const trigger = dom.append(slot, dom.$('a.action-label'));
		trigger.tabIndex = 0;
		trigger.role = 'button';
		this._triggerElement = trigger;

		this._updateTriggerLabel(trigger);

		this._renderDisposables.add(dom.addDisposableListener(trigger, dom.EventType.CLICK, (e) => {
			dom.EventHelper.stop(e, true);
			this.showPicker();
		}));

		this._renderDisposables.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				this.showPicker();
			}
		}));

		return slot;
	}

	setVisible(visible: boolean): void {
		if (this._container) {
			this._container.style.display = visible ? '' : 'none';
		}
	}

	showPicker(): void {
		if (!this._triggerElement || this.actionWidgetService.isVisible) {
			return;
		}

		const policyRestricted = this.configurationService.inspect<boolean>(ChatConfiguration.GlobalAutoApprove).policyValue === false;
		const isAutopilotEnabled = this.configurationService.getValue<boolean>(ChatConfiguration.AutopilotEnabled) !== false;

		const items: IActionListItem<IPermissionItem>[] = [
			{
				kind: ActionListItemKind.Action,
				group: { kind: ActionListItemKind.Header, title: '', icon: Codicon.shield },
				item: {
					level: ChatPermissionLevel.Default,
					label: localize('permissions.default', "Default"),
					icon: Codicon.shield,
					checked: this._currentLevel === ChatPermissionLevel.Default,
				},
				label: localize('permissions.default', "Default"),
				description: localize('permissions.default.subtext', "Use rules; ask before risky actions"),
				disabled: false,
			},
			{
				kind: ActionListItemKind.Action,
				group: { kind: ActionListItemKind.Header, title: '', icon: Codicon.warning },
				item: {
					level: ChatPermissionLevel.AutoApprove,
					label: localize('permissions.autoApprove', "Auto-Run"),
					icon: Codicon.warning,
					checked: this._currentLevel === ChatPermissionLevel.AutoApprove,
				},
				label: localize('permissions.autoApprove', "Auto-Run"),
				description: localize('permissions.autoApprove.subtext', "Auto-approve all tools within a turn; stop after each turn"),
				disabled: policyRestricted,
			},
		];

		if (isAutopilotEnabled) {
			items.push({
				kind: ActionListItemKind.Action,
				group: { kind: ActionListItemKind.Header, title: '', icon: Codicon.rocket },
				item: {
					level: ChatPermissionLevel.Autopilot,
					label: localize('permissions.autopilot', "Full Auto"),
					icon: Codicon.rocket,
					checked: this._currentLevel === ChatPermissionLevel.Autopilot,
				},
				label: localize('permissions.autopilot', "Full Auto"),
				description: localize('permissions.autopilot.subtext', "Auto-approve and auto-continue across turns until the task is done"),
				disabled: policyRestricted,
			});
		}

		const triggerElement = this._triggerElement;
		const delegate: IActionListDelegate<IPermissionItem> = {
			onSelect: async (item) => {
				this.actionWidgetService.hide();
				await this._selectLevel(item.level);
			},
			onHide: () => { triggerElement.focus(); },
		};

		this.actionWidgetService.show<IPermissionItem>(
			'permissionPicker',
			false,
			items,
			delegate,
			this._triggerElement,
			undefined,
			[],
			{
				getAriaLabel: (item) => item.label ?? '',
				getWidgetAriaLabel: () => localize('permissionPicker.ariaLabel', "Permission Picker"),
			},
		);
	}

	private async _selectLevel(level: ChatPermissionLevel): Promise<void> {
		if (level === ChatPermissionLevel.AutoApprove && !shownWarnings.has(ChatPermissionLevel.AutoApprove)) {
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

		if (level === ChatPermissionLevel.Autopilot && !shownWarnings.has(ChatPermissionLevel.Autopilot)) {
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

		this._currentLevel = level;
		this._updateTriggerLabel(this._triggerElement);
		this._onDidChangeLevel.fire(level);
	}

	private _updateTriggerLabel(trigger: HTMLElement | undefined): void {
		if (!trigger) {
			return;
		}

		dom.clearNode(trigger);
		let icon: ThemeIcon;
		let label: string;
		switch (this._currentLevel) {
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

		dom.append(trigger, renderIcon(icon));
		const labelSpan = dom.append(trigger, dom.$('span.sessions-chat-dropdown-label'));
		labelSpan.textContent = label;
		dom.append(trigger, renderIcon(Codicon.chevronDown));
	}
}
