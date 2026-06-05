/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { ChiposPluginsService, PluginContributionSummary } from '../../resources/chiposPluginsService.js';
import { ChiposPluginCatalogService, CatalogEntry } from '../../resources/catalogClient.js';

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
	private _catalogContainer: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._render();
	}

	/** A fresh service instance — cheap; it only injects file/path/config. */
	private _service(): ChiposPluginsService {
		return this._instantiationService.createInstance(ChiposPluginsService);
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

		const gitBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		gitBtn.textContent = localize('chipos.plugins.importFromGit', 'Import from Git URL…');
		this._disposables.add(dom.addDisposableListener(gitBtn, 'click', async () => {
			await this._commandService.executeCommand('chipos.plugins.installFromGit');
			this._refresh();
		}));

		dom.append(section, dom.$('.chipos-setting-description', undefined,
			localize('chipos.plugins.desc', 'Agent plugins are AI-capability bundles installed under ~/.chipos-ide/plugins/. Each plugin can contribute rules, commands and skills to the agent. This is separate from VS Code extensions.')));

		this._listContainer = dom.append(section, dom.$('.chipos-plugins-list'));
		this._loadPlugins(this._listContainer);

		// ── Browse Catalog (FEAT-002d) ──
		const catalogSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(catalogSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.plugins.catalog', 'Browse Catalog')));
		dom.append(catalogSection, dom.$('.chipos-setting-description', undefined,
			localize('chipos.plugins.catalog.desc', 'Curated agent plugins from the ChipOS catalog. Installing clones the plugin from its Git repository (host-checked + confirmed).')));
		this._catalogContainer = dom.append(catalogSection, dom.$('.chipos-plugins-catalog-list'));
		this._loadCatalog(this._catalogContainer);
	}

	private async _loadCatalog(container: HTMLElement): Promise<void> {
		let entries: CatalogEntry[];
		let offline = false;
		try {
			const result = await this._instantiationService.createInstance(ChiposPluginCatalogService).getCatalog(CancellationToken.None);
			entries = result.entries;
			offline = result.offline;
		} catch {
			if (container.isConnected) {
				dom.append(container, dom.$('.chipos-setting-description', undefined,
					localize('chipos.plugins.catalog.unavailable', 'Catalog is unavailable (offline with no cached copy).')));
			}
			return;
		}
		if (!container.isConnected) {
			return;
		}
		if (offline) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.plugins.catalog.offline', 'Showing a cached catalog (offline).')));
		}
		if (entries.length === 0) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.plugins.catalog.empty', 'No plugins in the catalog yet.')));
			return;
		}
		for (const entry of entries) {
			this._renderCatalogRow(container, entry);
		}
	}

	private _renderCatalogRow(parent: HTMLElement, entry: CatalogEntry): void {
		const row = dom.append(parent, dom.$('.chipos-rule-item'));

		const nameCell = dom.append(row, dom.$('.chipos-rule-name'));
		dom.append(nameCell, dom.$('span', undefined, entry.name));
		const meta = dom.append(nameCell, dom.$('span'));
		meta.style.marginLeft = '8px';
		meta.style.fontSize = '11px';
		meta.style.color = 'var(--vscode-descriptionForeground)';
		const parts: string[] = [];
		if (entry.author) {
			parts.push(localize('chipos.plugins.catalog.by', 'by {0}', entry.author));
		}
		if (entry.verified) {
			parts.push(localize('chipos.plugins.catalog.verified', 'verified'));
		}
		if (entry.description) {
			parts.push(entry.description);
		}
		meta.textContent = parts.join(' · ');

		const actions = dom.append(row, dom.$('.chipos-rule-actions'));
		const installBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		installBtn.textContent = localize('chipos.plugins.catalog.install', 'Install');
		this._disposables.add(dom.addDisposableListener(installBtn, 'click', async () => {
			const confirmed = await this._dialogService.confirm({
				message: localize('chipos.plugins.catalog.confirm', 'Install "{0}" from the catalog?', entry.name),
				detail: localize('chipos.plugins.catalog.confirmDetail', '{0}\n\nThis clones the plugin from its Git repository. Only install plugins you trust.', entry.repo),
				primaryButton: localize('chipos.plugins.catalog.confirmButton', 'Clone & Install'),
				type: 'warning',
			});
			if (!confirmed.confirmed) {
				return;
			}
			try {
				const result = await this._service().installFromGit(entry.repo);
				this._notificationService.info(localize('chipos.plugins.catalog.done', 'Installed plugin "{0}".', result.manifest.name));
			} catch (err) {
				this._notificationService.error(localize('chipos.plugins.catalog.failed', 'Could not install "{0}": {1}', entry.name, err instanceof Error ? err.message : String(err)));
			}
			this._refresh();
		}));
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
			summaries = await this._service().getInstalledPluginSummaries();
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
		const row = dom.append(parent, dom.$('.chipos-rule-item'));
		// Disabled plugins are dimmed but still actionable (so they can be
		// re-enabled), so use inline opacity rather than the `.greyed-out` class
		// (which also kills pointer events and appends a "(Coming Soon)" suffix).
		if (!summary.enabled) {
			row.style.opacity = '0.55';
		}

		const nameCell = dom.append(row, dom.$('.chipos-rule-name'));
		dom.append(nameCell, dom.$('span', undefined, summary.manifest.name));

		const meta = dom.append(nameCell, dom.$('span'));
		meta.style.marginLeft = '8px';
		meta.style.fontSize = '11px';
		meta.style.color = 'var(--vscode-descriptionForeground)';
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
		if (!summary.enabled) {
			parts.push(localize('chipos.plugins.disabledTag', 'disabled'));
		}
		meta.textContent = parts.join(' · ');

		const actions = dom.append(row, dom.$('.chipos-rule-actions'));

		const toggleBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		toggleBtn.textContent = summary.enabled
			? localize('chipos.plugins.disable', 'Disable')
			: localize('chipos.plugins.enable', 'Enable');
		this._disposables.add(dom.addDisposableListener(toggleBtn, 'click', async () => {
			try {
				await this._service().setPluginEnabled(summary.manifest.id, !summary.enabled);
			} catch (err) {
				this._notificationService.error(localize('chipos.plugins.toggleFailed', 'Could not update plugin: {0}', String(err)));
			}
			this._refresh();
		}));

		const uninstallBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
		uninstallBtn.textContent = localize('chipos.plugins.uninstall', 'Uninstall');
		this._disposables.add(dom.addDisposableListener(uninstallBtn, 'click', async () => {
			const confirmed = await this._dialogService.confirm({
				message: localize('chipos.plugins.uninstall.confirm', 'Uninstall plugin "{0}"?', summary.manifest.name),
				detail: localize('chipos.plugins.uninstall.detail', 'This permanently deletes the plugin folder under ~/.chipos-ide/plugins/. This cannot be undone.'),
				primaryButton: localize('chipos.plugins.uninstall.button', 'Uninstall'),
				type: 'warning',
			});
			if (!confirmed.confirmed) {
				return;
			}
			try {
				await this._service().uninstall(summary.manifest.id);
				this._notificationService.info(localize('chipos.plugins.uninstall.done', 'Uninstalled plugin "{0}".', summary.manifest.name));
			} catch (err) {
				this._notificationService.error(localize('chipos.plugins.uninstall.failed', 'Could not uninstall plugin: {0}', String(err)));
			}
			this._refresh();
		}));
	}
}
