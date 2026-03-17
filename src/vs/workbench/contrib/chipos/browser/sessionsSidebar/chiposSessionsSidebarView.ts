/*---------------------------------------------------------------------------------------------
 *  ChipOS — Sessions Sidebar View (Cursor-style)
 *  Registers a standalone Sessions list in the left Sidebar, reusing the
 *  framework's AgentSessionsControl for rendering.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { AgentSessionsControl, IAgentSessionsControlOptions } from '../../../chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter } from '../../../chat/browser/agentSessions/agentSessionsFilter.js';
import { defaultListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import * as dom from '../../../../../base/browser/dom.js';

export const SESSIONS_SIDEBAR_VIEW_ID = 'chipos.sessionsSidebar';

export class ChipOSSessionsSidebarView extends ViewPane {

	private sessionsControl: AgentSessionsControl | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const wrapper = dom.$('.chipos-sessions-sidebar');
		container.appendChild(wrapper);

		// Sessions list
		const listContainer = dom.append(wrapper, dom.$('.chipos-sessions-list'));

		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {}));

		const controlOptions: IAgentSessionsControlOptions = {
			overrideStyles: defaultListStyles,
			filter,
			source: 'sidebar',
			getHoverPosition: () => HoverPosition.RIGHT,
			trackActiveEditorSession: () => true,
		};

		this.sessionsControl = this._register(
			this.instantiationService.createInstance(AgentSessionsControl, listContainer, controlOptions)
		);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.sessionsControl?.layout(height, width);
	}

	override focus(): void {
		super.focus();
		this.sessionsControl?.focus();
	}
}
