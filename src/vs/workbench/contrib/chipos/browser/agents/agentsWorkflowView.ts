/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { IViewletViewOptions } from '../../../../../workbench/browser/parts/views/viewsViewlet.js';
import { ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IAgentActivity, IAgentActivityStore, IAgentRun } from './agentActivityStore.js';
import './media/agentsWorkflow.css';

/** View id for the multi-agent workflow panel inside the ChipOS Tools container. */
export const AGENTS_WORKFLOW_VIEW_ID = 'chipos.agentsWorkflow';

const $ = dom.$;

/**
 * A custom {@link ViewPane} that renders the current turn's delegated sub-agents
 * as a rich-card "workflow" overview — one card per role (the orchestrated
 * sub-agent) showing its status and its tool activities as chips. Unlike the
 * in-chat sub-agent cards (which interleave with the conversation), this is a
 * consolidated panel that lives alongside Skill Tree / Worker Tools / Module
 * Hierarchy in the ChipOS Tools container and re-renders live from the in-memory
 * {@link IAgentActivityStore}.
 */
export class AgentsWorkflowViewPane extends ViewPane {

	private _content: HTMLElement | undefined;

	constructor(
		options: IViewletViewOptions,
		@IAgentActivityStore private readonly _activityStore: IAgentActivityStore,
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

		this._register(this._activityStore.onDidChange(() => this._render()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = dom.append(container, $('.chipos-agents-workflow'));
		this._render();
	}

	private _render(): void {
		if (!this._content) {
			return;
		}
		dom.clearNode(this._content);

		const runs = this._activityStore.getRuns();
		if (runs.length === 0) {
			const empty = dom.append(this._content, $('.chipos-agents-empty'));
			empty.textContent = localize('chipos.agentsWorkflow.empty', "No sub-agents active. Run a task that delegates to a sub-agent (e.g. a lint-fix or PPA loop) to see the workflow here.");
			return;
		}

		for (const run of runs) {
			this._renderRunCard(this._content, run);
		}
	}

	private _renderRunCard(parent: HTMLElement, run: IAgentRun): void {
		const running = run.status === 'running';
		const card = dom.append(parent, $(running ? '.chipos-agent-card.running' : '.chipos-agent-card.done'));

		const head = dom.append(card, $('.chipos-agent-card-head'));
		const icon = dom.append(head, $('span.codicon'));
		icon.classList.add(running ? 'codicon-loading' : 'codicon-pass');
		if (running) {
			icon.classList.add('codicon-modifier-spin');
		}
		const name = dom.append(head, $('span.chipos-agent-role'));
		name.textContent = run.role;
		const badge = dom.append(head, $('span.chipos-agent-badge'));
		badge.textContent = running
			? localize('chipos.agentsWorkflow.running', "running")
			: localize('chipos.agentsWorkflow.done', "done");
		const count = dom.append(head, $('span.chipos-agent-count'));
		count.textContent = localize('chipos.agentsWorkflow.actions', "{0} actions", run.activities.length);

		const body = dom.append(card, $('.chipos-agent-card-body'));
		if (run.activities.length === 0) {
			const idle = dom.append(body, $('span.chipos-agent-chip.idle'));
			idle.textContent = localize('chipos.agentsWorkflow.starting', "starting…");
			return;
		}
		for (const activity of run.activities) {
			this._renderActivityChip(body, activity);
		}
	}

	private _renderActivityChip(parent: HTMLElement, activity: IAgentActivity): void {
		const chip = dom.append(parent, $(activity.done ? 'span.chipos-agent-chip.done' : 'span.chipos-agent-chip.pending'));
		// Full "tool — result" on hover; the inline result is terse + truncated.
		chip.title = activity.result ? `${activity.toolName} — ${activity.result}` : activity.toolName;
		const mark = dom.append(chip, $('span.codicon'));
		mark.classList.add(activity.done ? 'codicon-check' : 'codicon-loading');
		if (!activity.done) {
			mark.classList.add('codicon-modifier-spin');
		}
		const tool = dom.append(chip, $('span.chipos-agent-chip-tool'));
		tool.textContent = activity.toolName;
		if (activity.result) {
			const result = dom.append(chip, $('span.chipos-agent-chip-result'));
			result.textContent = activity.result;
		}
	}
}
