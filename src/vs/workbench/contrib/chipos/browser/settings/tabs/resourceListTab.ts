/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IDialogService, IFileDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IProgressService, ProgressLocation } from '../../../../../../platform/progress/common/progress.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import {
	ResourceKind, ResourceScope, RESOURCE_LAYOUTS, ScannedResource,
	workspaceResourceDir, userGlobalResourceDir, scanResourcePlane,
	isResourceEnabled, setResourceEnabled, findImportableResources, copyResourceEntry,
} from '../../resources/chiposResourceScopes.js';
import { isAllowedGitUrl, cloneGitRepo } from '../../resources/gitImport.js';

/**
 * Per-kind behavior the generic {@link ResourceListTab} needs. Everything else
 * (header buttons, scope chooser, import, list rendering, enable/disable, badges,
 * active count, disposable/epoch hygiene) is shared, so the four resource tabs
 * can't drift.
 */
export interface ResourceTabSpec {
	readonly kind: ResourceKind;
	/** Codicon name without the `codicon-` prefix (e.g. `lightbulb`). */
	readonly icon: string;
	readonly title: string;
	readonly description: string;
	readonly newLabel: string;
	readonly emptyMessage: string;
	/** File picker filter for "Import from Local…" (flat kinds only; skills pick a folder). */
	readonly importFilter?: { readonly name: string; readonly extensions: string[] };
	/** Dimmed meta line for a row (may read the file); `''` for none. */
	metaForRow(fileService: IFileService, r: ScannedResource): Promise<string>;
	/** Prompt + write a new skeleton in `destDir`; return the file URI to open, or `undefined` to cancel. */
	createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined>;
}

interface RowModel extends ScannedResource {
	readonly enabled: boolean;
	readonly meta: string;
}

/**
 * Generic settings tab for a `.chipos/` resource kind (rules / commands / skills
 * / hooks). Lists both the project plane (`.chipos/<kind>/`) and the user-global
 * plane (`~/.chipos-ide/<kind>/`) with a scope badge + per-row enable/disable +
 * an active count, and offers New / Import-from-Local / Import-from-Git (each
 * choosing Project vs User scope first). Disabling a row writes the
 * scope-qualified id to `chipos.<kind>.disabled` so it drops from the agent.
 */
export class ResourceListTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	// Row listeners are re-created on each reload — keep them off the class store.
	private readonly _listDisposables = this._register(new DisposableStore());
	private _epoch = 0;
	private _listContainer: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		private readonly _spec: ResourceTabSpec,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));

		const header = dom.append(section, dom.$('.chipos-settings-section-header'));
		const titleWrap = dom.append(header, dom.$('.chipos-settings-section-title'));
		titleWrap.textContent = this._spec.title;
		this._countEl = dom.append(titleWrap, dom.$('span'));
		this._countEl.style.marginLeft = '8px';
		this._countEl.style.fontSize = '11px';
		this._countEl.style.fontWeight = '400';
		this._countEl.style.color = 'var(--vscode-descriptionForeground)';

		const actions = dom.append(header, dom.$('.chipos-rule-actions'));
		const newBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		newBtn.textContent = this._spec.newLabel;
		this._disposables.add(dom.addDisposableListener(newBtn, 'click', () => this._createNew()));
		const importBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		importBtn.textContent = localize('chipos.resource.importLocal', 'Import from Local…');
		this._disposables.add(dom.addDisposableListener(importBtn, 'click', () => this._importFromLocal()));
		const gitBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		gitBtn.textContent = localize('chipos.resource.importGit', 'Import from Git…');
		this._disposables.add(dom.addDisposableListener(gitBtn, 'click', () => this._importFromGit()));

		dom.append(section, dom.$('.chipos-setting-description', undefined, this._spec.description));

		this._listContainer = dom.append(section, dom.$('.chipos-rules-list'));
		this._loadList(this._listContainer);
	}

	// --- planes ---------------------------------------------------------------

	private _workspaceFolder(): URI | undefined {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private async _destDir(scope: ResourceScope): Promise<URI | undefined> {
		if (scope === 'user') {
			return userGlobalResourceDir(this._pathService, this._spec.kind);
		}
		const folder = this._workspaceFolder();
		return folder ? workspaceResourceDir(folder, this._spec.kind) : undefined;
	}

	/** QuickPick: Project (.chipos/<kind>/) vs User (global). Returns undefined on cancel. */
	private async _pickScope(): Promise<ResourceScope | undefined> {
		const hasWorkspace = !!this._workspaceFolder();
		const picked = await this._quickInputService.pick([
			{ label: localize('chipos.resource.scope.project', 'Project'), description: localize('chipos.resource.scope.projectDesc', 'Stored in .chipos/{0}/ — shared with this workspace', this._spec.kind), id: 'workspace' as const },
			{ label: localize('chipos.resource.scope.user', 'User (all projects)'), description: localize('chipos.resource.scope.userDesc', 'Stored in ~/.chipos-ide/{0}/ — available in every project', this._spec.kind), id: 'user' as const },
		].filter(o => o.id === 'user' || hasWorkspace), {
			title: localize('chipos.resource.scope.title', 'Where should this go?'),
		});
		return picked?.id;
	}

	// --- list -----------------------------------------------------------------

	private async _loadList(container: HTMLElement): Promise<void> {
		const epoch = ++this._epoch;
		const folder = this._workspaceFolder();
		const planes: { dir: URI; scope: ResourceScope }[] = [];
		if (folder) {
			planes.push({ dir: workspaceResourceDir(folder, this._spec.kind), scope: 'workspace' });
		}
		planes.push({ dir: await userGlobalResourceDir(this._pathService, this._spec.kind), scope: 'user' });

		const rows: RowModel[] = [];
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS[this._spec.kind]);
			for (const r of scanned) {
				const enabled = isResourceEnabled(this._configurationService, this._spec.kind, r.scope, r.name);
				let meta = '';
				try {
					meta = await this._spec.metaForRow(this._fileService, r);
				} catch {
					// best-effort meta
				}
				rows.push({ ...r, enabled, meta });
			}
		}

		if (epoch !== this._epoch || !container.isConnected) {
			return;
		}
		this._listDisposables.clear();
		dom.clearNode(container);

		const activeCount = rows.filter(r => r.enabled).length;
		if (this._countEl) {
			this._countEl.textContent = rows.length === 0 ? '' : localize('chipos.resource.count', '{0} active / {1}', activeCount, rows.length);
		}

		if (rows.length === 0) {
			dom.append(container, dom.$('.chipos-setting-description', undefined, this._spec.emptyMessage));
			return;
		}
		for (const row of rows) {
			this._renderRow(container, row);
		}
	}

	private _renderRow(parent: HTMLElement, row: RowModel): void {
		const el = dom.append(parent, dom.$('.chipos-rule-item'));
		if (!row.enabled) {
			el.style.opacity = '0.55';
		}

		const icon = dom.append(el, dom.$(`span.codicon.codicon-${this._spec.icon}`));
		icon.style.fontSize = '16px';
		icon.style.flexShrink = '0';
		icon.style.color = 'var(--vscode-textLink-foreground)';

		const nameCell = dom.append(el, dom.$('.chipos-rule-name'));
		nameCell.style.display = 'flex';
		nameCell.style.flexDirection = 'column';
		nameCell.style.gap = '2px';
		nameCell.style.minWidth = '0';

		const titleLine = dom.append(nameCell, dom.$('span'));
		titleLine.style.display = 'flex';
		titleLine.style.alignItems = 'center';
		titleLine.style.gap = '6px';
		const nameEl = dom.append(titleLine, dom.$('span'));
		nameEl.style.fontWeight = '600';
		nameEl.textContent = row.name;
		this._appendScopeBadge(titleLine, row.scope);

		if (row.meta) {
			const meta = dom.append(nameCell, dom.$('span'));
			meta.style.fontSize = '11px';
			meta.style.color = 'var(--vscode-descriptionForeground)';
			meta.textContent = row.meta;
		}

		const actions = dom.append(el, dom.$('.chipos-rule-actions'));
		const toggleBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		toggleBtn.textContent = row.enabled ? localize('chipos.resource.disable', 'Disable') : localize('chipos.resource.enable', 'Enable');
		this._listDisposables.add(dom.addDisposableListener(toggleBtn, 'click', async () => {
			try {
				await setResourceEnabled(this._configurationService, this._spec.kind, row.scope, row.name, !row.enabled);
			} catch (err) {
				this._notificationService.error(localize('chipos.resource.toggleFailed', 'Could not update: {0}', String(err)));
			}
			this._refresh();
		}));
		const editBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		editBtn.textContent = localize('chipos.resource.edit', 'Edit');
		this._listDisposables.add(dom.addDisposableListener(editBtn, 'click', () => {
			this._editorService.openEditor({ resource: row.editFile });
		}));
		const delBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
		delBtn.textContent = localize('chipos.resource.delete', 'Delete');
		this._listDisposables.add(dom.addDisposableListener(delBtn, 'click', async () => {
			const confirmed = await this._dialogService.confirm({
				message: localize('chipos.resource.confirmDelete', 'Delete "{0}"?', row.name),
				detail: row.editFile.fsPath,
				primaryButton: localize('chipos.resource.delete', 'Delete'),
				type: 'warning',
			});
			if (!confirmed.confirmed) {
				return;
			}
			try {
				await this._fileService.del(row.entry, { recursive: RESOURCE_LAYOUTS[this._spec.kind].shape === 'skill', useTrash: true });
			} catch { /* ignore */ }
			this._refresh();
		}));
	}

	private _appendScopeBadge(parent: HTMLElement, scope: ResourceScope): void {
		const badge = dom.append(parent, dom.$('span'));
		badge.textContent = scope === 'workspace'
			? localize('chipos.resource.badge.workspace', 'Workspace')
			: localize('chipos.resource.badge.global', 'Global');
		badge.style.fontSize = '10px';
		badge.style.padding = '1px 6px';
		badge.style.borderRadius = '4px';
		badge.style.flexShrink = '0';
		badge.style.background = 'var(--vscode-badge-background)';
		badge.style.color = 'var(--vscode-badge-foreground)';
	}

	private _refresh(): void {
		if (this._listContainer?.isConnected) {
			this._loadList(this._listContainer);
		}
	}

	// --- create / import ------------------------------------------------------

	private async _createNew(): Promise<void> {
		const scope = await this._pickScope();
		if (!scope) {
			return;
		}
		const destDir = await this._destDir(scope);
		if (!destDir) {
			return;
		}
		try {
			const file = await this._spec.createNew(this._fileService, this._quickInputService, destDir);
			if (file) {
				await this._editorService.openEditor({ resource: file });
				this._refresh();
			}
		} catch (err) {
			this._notificationService.error(localize('chipos.resource.createFailed', 'Could not create: {0}', String(err)));
		}
	}

	private async _importFromLocal(): Promise<void> {
		const scope = await this._pickScope();
		if (!scope) {
			return;
		}
		const destDir = await this._destDir(scope);
		if (!destDir) {
			return;
		}
		const layout = RESOURCE_LAYOUTS[this._spec.kind];
		const picks = await this._fileDialogService.showOpenDialog({
			title: localize('chipos.resource.importTitle', 'Import {0}', this._spec.title),
			canSelectFiles: layout.shape === 'flat',
			canSelectFolders: layout.shape === 'skill',
			canSelectMany: true,
			filters: layout.shape === 'flat' && this._spec.importFilter ? [this._spec.importFilter] : undefined,
		});
		if (!picks || picks.length === 0) {
			return;
		}
		// flat: the picked files ARE the resources; skill: each picked folder may hold one or more skills.
		const sources: URI[] = [];
		for (const pick of picks) {
			if (layout.shape === 'flat') {
				sources.push(pick);
			} else {
				sources.push(...await findImportableResources(this._fileService, pick, layout));
			}
		}
		await this._copyAll(sources, destDir, scope);
	}

	private async _importFromGit(): Promise<void> {
		const url = await this._quickInputService.input({
			title: localize('chipos.resource.importGitTitle', 'Import {0} from Git', this._spec.title),
			prompt: localize('chipos.resource.importGitPrompt', 'https Git URL to clone (only trusted hosts)'),
			placeHolder: 'https://github.com/owner/repo.git',
		});
		const trimmed = url?.trim();
		if (!trimmed) {
			return;
		}
		const allowed = this._allowedGitDomains();
		if (!isAllowedGitUrl(trimmed, allowed)) {
			this._notificationService.error(localize('chipos.resource.gitUntrusted', 'Refusing to clone from an untrusted host. Allowed: {0}.', allowed.join(', ')));
			return;
		}
		const confirmed = await this._dialogService.confirm({
			message: localize('chipos.resource.gitConfirm', 'Import {0} from {1}?', this._spec.title, trimmed),
			detail: localize('chipos.resource.gitConfirmDetail', 'Only import from sources you trust.'),
			primaryButton: localize('chipos.resource.importBtn', 'Import'),
			type: 'warning',
		});
		if (!confirmed.confirmed) {
			return;
		}
		const scope = await this._pickScope();
		if (!scope) {
			return;
		}
		const destDir = await this._destDir(scope);
		if (!destDir) {
			return;
		}
		await this._progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('chipos.resource.gitCloning', 'Cloning {0}…', trimmed), cancellable: false },
			async () => {
				const tempDir = await this._cloneToTemp(trimmed);
				try {
					const sources = await findImportableResources(this._fileService, tempDir, RESOURCE_LAYOUTS[this._spec.kind]);
					await this._copyAll(sources, destDir, scope);
				} finally {
					try {
						await this._fileService.del(tempDir, { recursive: true, useTrash: false });
					} catch { /* best-effort cleanup */ }
				}
			});
	}

	private _allowedGitDomains(): string[] {
		const raw = this._configurationService.getValue<string[]>('chipos.plugins.allowedGitDomains');
		return Array.isArray(raw) && raw.length > 0 ? raw : ['github.com'];
	}

	private async _cloneToTemp(url: string): Promise<URI> {
		const home = await this._pathService.userHome();
		const parent = URI.joinPath(home, '.chipos-ide', '.cache', 'resource-clones');
		await this._fileService.createFolder(parent);
		const tempDir = URI.joinPath(parent, generateUuid());
		await cloneGitRepo(url, tempDir.fsPath, { timeoutMs: 60000 });
		try {
			await this._fileService.del(URI.joinPath(tempDir, '.git'), { recursive: true, useTrash: false });
		} catch { /* best-effort */ }
		return tempDir;
	}

	/** Copy each source into destDir, confirming overwrite on collision; report a toast. */
	private async _copyAll(sources: URI[], destDir: URI, scope: ResourceScope): Promise<void> {
		if (sources.length === 0) {
			this._notificationService.info(localize('chipos.resource.importNone', 'No {0} found to import.', this._spec.title));
			return;
		}
		const layout = RESOURCE_LAYOUTS[this._spec.kind];
		const imported: string[] = [];
		let skipped = 0;
		for (const src of sources) {
			try {
				imported.push(await copyResourceEntry(this._fileService, src, layout, destDir, false));
			} catch {
				// collision (or copy error) → ask to overwrite
				const base = src.path.split('/').filter(Boolean).pop() ?? src.path;
				const confirmed = await this._dialogService.confirm({
					message: localize('chipos.resource.overwrite', '"{0}" already exists in {1}. Overwrite?', base, scope === 'workspace' ? 'Workspace' : 'Global'),
					primaryButton: localize('chipos.resource.overwriteBtn', 'Overwrite'),
					type: 'warning',
				});
				if (confirmed.confirmed) {
					try {
						imported.push(await copyResourceEntry(this._fileService, src, layout, destDir, true));
					} catch {
						skipped++;
					}
				} else {
					skipped++;
				}
			}
		}
		if (imported.length > 0) {
			this._notificationService.info(localize('chipos.resource.imported', 'Imported {0} {1}{2}.', imported.length, this._spec.title, skipped > 0 ? localize('chipos.resource.importedSkipped', ' ({0} skipped)', skipped) : ''));
		} else if (skipped > 0) {
			this._notificationService.info(localize('chipos.resource.importSkippedAll', 'Nothing imported ({0} skipped).', skipped));
		}
		this._refresh();
	}
}
