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
import { IProgressService, ProgressLocation } from '../../../../../../platform/progress/common/progress.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { ChiposPluginsService, PluginContributionSummary } from '../../resources/chiposPluginsService.js';
import { ChiposPluginCatalogService, CatalogEntry } from '../../resources/catalogClient.js';
import { renderCatalogBrowser } from '../components/catalogBrowser.js';

/**
 * Plugins settings tab (FEAT-002a). Lists the agent plugins installed under
 * `~/.chipos/plugins/` with a summary of the rules/commands/skills each
 * contributes, plus an "Install from Local…" action wired to the
 * `chipos.plugins.installFromLocal` command. Agent plugins are chipos's own
 * AI-capability bundle format — NOT VS Code extensions (.vsix / Open VSX).
 */
export class PluginsTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	// Listeners for the installed-list rows live here and are cleared on every
	// reload — the rows are re-created on each refresh, so registering their
	// listeners on the class-level store would leak them until the tab closes.
	private readonly _listDisposables = this._register(new DisposableStore());
	// Monotonic token so a slower reload that resolves after a newer one can't
	// append stale rows (the scan is async — fast refreshes would otherwise
	// duplicate rows).
	private _listEpoch = 0;
	private _listContainer: HTMLElement | undefined;
	private _catalogContainer: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IProgressService private readonly _progressService: IProgressService,
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
			localize('chipos.plugins.desc', 'Agent plugins are AI-capability bundles installed under ~/.chipos/plugins/. Each plugin can contribute rules, commands and skills to the agent. This is separate from VS Code extensions.')));

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
		renderCatalogBrowser(container, entries, { install: e => this._installCatalogEntry(e) }, this._disposables);
	}

	/** FEAT-002b install of a catalog entry — confirm (trust gate) then git-clone. */
	private async _installCatalogEntry(entry: CatalogEntry): Promise<void> {
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
			const result = await this._progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('chipos.plugins.catalog.installing', 'Installing "{0}" from the catalog…', entry.name),
					cancellable: false,
				},
				() => this._service().installFromGit(entry.repo),
			);
			this._notificationService.info(localize('chipos.plugins.catalog.done', 'Installed plugin "{0}".', result.manifest.name));
		} catch (err) {
			this._notificationService.error(localize('chipos.plugins.catalog.failed', 'Could not install "{0}": {1}', entry.name, err instanceof Error ? err.message : String(err)));
		}
		this._refresh();
	}

	private _refresh(): void {
		// _loadPlugins clears the list itself after its async scan (guarded by the
		// epoch token), so two fast refreshes can't append duplicate rows.
		if (this._listContainer?.isConnected) {
			this._loadPlugins(this._listContainer);
		}
	}

	private async _loadPlugins(container: HTMLElement): Promise<void> {
		const epoch = ++this._listEpoch;
		let summaries: PluginContributionSummary[];
		try {
			summaries = await this._service().getInstalledPluginSummaries();
		} catch {
			summaries = [];
		}
		// Bail if a newer reload started while we awaited (else fast refreshes
		// duplicate rows), or the tab was disposed.
		if (epoch !== this._listEpoch || !container.isConnected) {
			return;
		}
		// Latest reload wins: dispose the previous rows' listeners + clear the DOM.
		this._listDisposables.clear();
		dom.clearNode(container);
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

		const icon = dom.append(row, dom.$('span.codicon.codicon-package'));
		icon.style.fontSize = '16px';
		icon.style.flexShrink = '0';
		icon.style.color = 'var(--vscode-textLink-foreground)';

		const nameCell = dom.append(row, dom.$('.chipos-rule-name'));
		nameCell.style.display = 'flex';
		nameCell.style.flexDirection = 'column';
		nameCell.style.gap = '2px';
		nameCell.style.minWidth = '0';
		const nameEl = dom.append(nameCell, dom.$('span'));
		nameEl.style.fontWeight = '600';
		nameEl.textContent = summary.manifest.name;

		const meta = dom.append(nameCell, dom.$('span'));
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
		this._listDisposables.add(dom.addDisposableListener(toggleBtn, 'click', async () => {
			try {
				await this._service().setPluginEnabled(summary.manifest.id, !summary.enabled);
				// FEAT-011b: enable/disable changes the plugin's contributed worker MCP
				// servers — reconcile now rather than waiting for the EDA Tools tab to reopen.
				await this._service().reconcileWorkerMcp();
			} catch (err) {
				this._notificationService.error(localize('chipos.plugins.toggleFailed', 'Could not update plugin: {0}', String(err)));
			}
			this._refresh();
		}));

		const uninstallBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
		uninstallBtn.textContent = localize('chipos.plugins.uninstall', 'Uninstall');
		this._listDisposables.add(dom.addDisposableListener(uninstallBtn, 'click', async () => {
			const confirmed = await this._dialogService.confirm({
				message: localize('chipos.plugins.uninstall.confirm', 'Uninstall plugin "{0}"?', summary.manifest.name),
				detail: localize('chipos.plugins.uninstall.detail', 'This permanently deletes the plugin folder under ~/.chipos/plugins/. This cannot be undone.'),
				primaryButton: localize('chipos.plugins.uninstall.button', 'Uninstall'),
				type: 'warning',
			});
			if (!confirmed.confirmed) {
				return;
			}
			try {
				await this._service().uninstall(summary.manifest.id);
				await this._service().reconcileWorkerMcp();
				this._notificationService.info(localize('chipos.plugins.uninstall.done', 'Uninstalled plugin "{0}".', summary.manifest.name));
			} catch (err) {
				this._notificationService.error(localize('chipos.plugins.uninstall.failed', 'Could not uninstall plugin: {0}', String(err)));
			}
			this._refresh();
		}));
	}
}
