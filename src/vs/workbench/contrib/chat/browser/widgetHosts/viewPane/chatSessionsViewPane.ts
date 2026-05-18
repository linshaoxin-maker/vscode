/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Event } from '../../../../../../base/common/event.js';
import { localize } from '../../../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IViewPaneOptions, ViewPane } from '../../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../common/views.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ACTION_ID_NEW_CHAT } from '../../actions/chatActions.js';
import { AgentSessionsViewerOrientation, AgentSessionsViewerPosition } from '../../agentSessions/agentSessions.js';
import { AgentSessionsControl } from '../../agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../../agentSessions/agentSessionsFilter.js';

/**
 * [ChipOS] Dedicated VS Code ViewPane that hosts the agent-sessions list.
 *
 * Originally the sessions list was rendered INSIDE `ChatViewPane` as a
 * side-by-side or stacked panel — toggling it on would compress the chat
 * widget's width (or push it to the bottom in stacked mode), which felt
 * like the chat panel had been broken. Extracting the list into its own
 * `ViewPane` lets VS Code's view-grid layout handle the column properly:
 * the sessions pane sits as a SIBLING of the chat pane in the same view
 * container, so opening it adds a NEW column rather than stealing space
 * from the chat content.
 *
 * The pane is intentionally minimal — it owns just the search input,
 * the `AgentSessionsControl` (the actual list widget), and the "New
 * Agent" button. Orientation is hard-pinned to `SideBySide` because
 * the pane no longer has a meaningful Stacked mode (the only reason
 * Stacked existed was for the in-pane fallback, which we've removed).
 */
export class ChatSessionsViewPane extends ViewPane {

	static readonly ID = 'chipos.chatSessions';

	private sessionsControl: AgentSessionsControl | undefined;

	private readonly agentSessionsViewerVisibleContext: IContextKey<boolean>;
	private readonly agentSessionsViewerOrientationContext: IContextKey<AgentSessionsViewerOrientation>;
	private readonly agentSessionsViewerPositionContext: IContextKey<AgentSessionsViewerPosition>;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IHostService private readonly hostService: IHostService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.agentSessionsViewerVisibleContext = ChatContextKeys.agentSessionsViewerVisible.bindTo(contextKeyService);
		this.agentSessionsViewerOrientationContext = ChatContextKeys.agentSessionsViewerOrientation.bindTo(contextKeyService);
		this.agentSessionsViewerPositionContext = ChatContextKeys.agentSessionsViewerPosition.bindTo(contextKeyService);

		// Hard-pin orientation/position context keys — the pane no longer
		// participates in stacked-vs-sidebyside switching. Other contribution
		// points that gate on these keys (e.g. the "go back" arrow on the
		// title bar in stacked mode) will simply see the side-by-side branch.
		this.agentSessionsViewerOrientationContext.set(AgentSessionsViewerOrientation.SideBySide);
		this.agentSessionsViewerPositionContext.set(AgentSessionsViewerPosition.Right);

		this._register(this.onDidChangeBodyVisibility(visible => {
			this.agentSessionsViewerVisibleContext.set(visible);
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('agent-sessions-container', 'chipos-chat-sessions-view');

		// Sessions Toolbar (filter submenu etc.) — kept hidden by chipos in
		// MenuId.AgentSessionsToolbar, but we still attach the menu so any
		// extension-contributed actions show up.
		const sessionsTitleContainer = append(container, $('.agent-sessions-title-container'));
		const sessionsTitle = append(sessionsTitleContainer, $('span.agent-sessions-title'));
		sessionsTitle.textContent = localize('sessions', "Sessions");
		sessionsTitle.style.display = 'none'; // [ChipOS] Cursor-style: no big SESSIONS header

		const sessionsToolbarContainer = append(sessionsTitleContainer, $('.agent-sessions-toolbar'));
		const sessionsToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, sessionsToolbarContainer, MenuId.AgentSessionsToolbar, {
			menuOptions: { shouldForwardArgs: true }
		}));

		// Filter (drives grouping)
		const sessionsFilter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewerFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Date,
		}));
		this._register(Event.runAndSubscribe(sessionsFilter.onDidChange, () => {
			sessionsToolbarContainer.classList.toggle('filtered', !sessionsFilter.isDefault());
		}));

		// [ChipOS] Search Agents input — Cursor style
		const searchContainer = append(container, $('.agent-sessions-search-container'));
		const searchInput = append(searchContainer, $('input.agent-sessions-search-input')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = localize('searchAgents', "Search Agents...");
		this._register(addDisposableListener(searchInput, EventType.FOCUS, () => {
			searchInput.blur();
			this.sessionsControl?.openFind();
		}));

		// New Agent Button
		const newSessionButtonContainer = append(container, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		newSessionButton.label = `$(${Codicon.add.id}) ${localize('newAgent', "New Agent")}`;
		this._register(newSessionButton.onDidClick(() => this.commandService.executeCommand(ACTION_ID_NEW_CHAT)));

		// Sessions Control — the real list widget
		const sessionsControlContainer = append(container, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, sessionsControlContainer, {
			source: 'chatSessionsViewPane',
			filter: sessionsFilter,
			overrideStyles: {},
			getHoverPosition: () => HoverPosition.LEFT,
			trackActiveEditorSession: () => true,
		}));
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));

		sessionsToolbar.context = sessionsControl;

		// Refresh sessions when window gets focus (mirrors chatViewPane behavior).
		this._register(this.hostService.onDidChangeFocus(hasFocus => {
			if (hasFocus) {
				sessionsControl.refresh();
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The sessions list takes the full body. We don't size the
		// title/search/button explicitly — they have intrinsic heights from
		// CSS — only ask the list to layout the remainder.
		// `AgentSessionsControl` reads its own container height via
		// `setVisible(true)` → renderer; nothing else to do here.
	}

	override focus(): void {
		super.focus();
		this.sessionsControl?.focus();
	}
}
