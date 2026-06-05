/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ChiposPluginsService, PluginContributionSummary } from '../../resources/chiposPluginsService.js';

/**
 * Plugins settings tab (FEAT-002a). Lists the agent plugins installed under
 * `~/.chipos-ide/plugins/` with a summary of the rules/commands/skills each
 * contributes, plus an "Install from Local…" action wired to the
 * `chipos.plugins.installFromLocal` command. Agent plugins are chipos's own
 * AI-capability bundle format — NOT VS Code extensions (.vsix / Open VSX).
 */
export class PluginsTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private _listContainer: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));

		const header = dom.append(section, dom.$('.chipos-settings-section-header'));
		dom.append(header, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.plugins.installed', 'Installed Plugins')));

		const installBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		installBtn.textContent = localize('chipos.plugins.installFromLocal', 'Install from Local…');
		this._disposables.add(dom.addDisposableListener(installBtn, 'click', async () => {
			await this._commandService.executeCommand('chipos.plugins.installFromLocal');
			this._refresh();
		}));

		dom.append(section, dom.$('.chipos-setting-description', undefined,
			localize('chipos.plugins.desc', 'Agent plugins are AI-capability bundles installed under ~/.chipos-ide/plugins/. Each plugin can contribute rules, commands and skills to the agent. This is separate from VS Code extensions.')));

		this._listContainer = dom.append(section, dom.$('.chipos-plugins-list'));
		this._loadPlugins(this._listContainer);
	}

	private _refresh(): void {
		// Guard against tab dispose between the install await and the re-render.
		if (this._listContainer?.isConnected) {
			dom.clearNode(this._listContainer);
			this._loadPlugins(this._listContainer);
		}
	}

	private async _loadPlugins(container: HTMLElement): Promise<void> {
		let summaries: PluginContributionSummary[];
		try {
			summaries = await this._instantiationService.createInstance(ChiposPluginsService).getInstalledPluginSummaries();
		} catch {
			summaries = [];
		}
		// The scan above is async — the tab may have been disposed meanwhile.
		if (!container.isConnected) {
			return;
		}
		if (summaries.length === 0) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.plugins.empty', 'No plugins installed. Use "Install from Local…" to add one from a folder.')));
			return;
		}
		for (const summary of summaries) {
			this._renderPluginRow(container, summary);
		}
	}

	private _renderPluginRow(parent: HTMLElement, summary: PluginContributionSummary): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, summary.manifest.name));

		const parts: string[] = [localize('chipos.plugins.version', 'v{0}', summary.manifest.version)];

		const contributions: string[] = [];
		if (summary.ruleCount > 0) {
			contributions.push(localize('chipos.plugins.ruleCount', '{0} rules', summary.ruleCount));
		}
		if (summary.commandCount > 0) {
			contributions.push(localize('chipos.plugins.commandCount', '{0} commands', summary.commandCount));
		}
		if (summary.skillCount > 0) {
			contributions.push(localize('chipos.plugins.skillCount', '{0} skills', summary.skillCount));
		}
		parts.push(contributions.length > 0
			? contributions.join(', ')
			: localize('chipos.plugins.noContributions', 'no contributions'));

		if (summary.manifest.source === 'cursor') {
			parts.push(localize('chipos.plugins.cursorSource', 'imported from Cursor'));
		}

		dom.append(row, dom.$('.chipos-setting-description', undefined, parts.join(' · ')));
	}
}
