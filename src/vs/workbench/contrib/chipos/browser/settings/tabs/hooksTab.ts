/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { parseHookFileContent } from '../../resources/chiposHooksService.js';

interface IHookFileEntry {
	readonly name: string;
	readonly file: URI;
	/** Human summary of each valid hook the file defines (e.g. "deny run_in_terminal @ tool.before_dispatch"). */
	readonly summaries: string[];
}

/**
 * Hooks settings tab (FEAT-004). Lists the workspace hook files under
 * `.chipos/hooks/*.json` and what each one does, so the user can see how many
 * hooks are active and edit/add them. A hook is `{ point, action, tool_name?,
 * reason? }`; a `deny` at `tool.before_dispatch` blocks the matching tool.
 */
export class HooksTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private readonly _listDisposables = this._register(new DisposableStore());
	private _epoch = 0;
	private _listContainer: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IEditorService private readonly _editorService: IEditorService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));

		const header = dom.append(section, dom.$('.chipos-settings-section-header'));
		dom.append(header, dom.$('.chipos-settings-section-title', undefined, localize('chipos.hooks.title', 'Hooks')));
		const newBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		newBtn.textContent = localize('chipos.hooks.new', '+ New Hook');
		this._disposables.add(dom.addDisposableListener(newBtn, 'click', () => this._createNew()));

		dom.append(section, dom.$('.chipos-setting-description', undefined,
			localize('chipos.hooks.desc', 'Hooks are loaded from .chipos/hooks/*.json in your workspace. Each hook is { point, action, tool_name?, reason? }. A "deny" at tool.before_dispatch blocks the matching tool before it runs; "observe" just records. Points include tool.before_dispatch, tool.after_result, turn.before_start, turn.after_end.')));

		this._listContainer = dom.append(section, dom.$('.chipos-rules-list'));
		this._loadList(this._listContainer);
	}

	private _hooksDir(): URI | undefined {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length > 0 ? URI.joinPath(folders[0].uri, '.chipos', 'hooks') : undefined;
	}

	private async _loadList(container: HTMLElement): Promise<void> {
		const epoch = ++this._epoch;
		const dir = this._hooksDir();
		const entries: IHookFileEntry[] = [];
		if (dir) {
			try {
				const children = (await this._fileService.resolve(dir)).children ?? [];
				for (const child of children) {
					if (child.isDirectory || !/\.json$/i.test(child.name)) {
						continue;
					}
					let summaries: string[] = [];
					try {
						const content = (await this._fileService.readFile(child.resource)).value.toString();
						summaries = parseHookFileContent(content, child.name).map(h =>
							`${h.action} ${h.tool_name ?? '*'} @ ${h.point}`);
					} catch {
						// malformed file — still list it (so it can be fixed), with no summary
					}
					entries.push({ name: child.name, file: child.resource, summaries });
				}
			} catch {
				// no .chipos/hooks/ yet
			}
		}

		if (epoch !== this._epoch || !container.isConnected) {
			return;
		}
		this._listDisposables.clear();
		dom.clearNode(container);

		if (!dir) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.hooks.noWorkspace', 'No workspace open. Open a folder to add hooks.')));
			return;
		}
		if (entries.length === 0) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.hooks.empty', 'No hooks yet. Click "+ New Hook" to create one under .chipos/hooks/.')));
			return;
		}
		for (const entry of entries) {
			this._renderRow(container, entry);
		}
	}

	private _renderRow(parent: HTMLElement, entry: IHookFileEntry): void {
		const row = dom.append(parent, dom.$('.chipos-rule-item'));
		const icon = dom.append(row, dom.$('span.codicon.codicon-shield'));
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
		nameEl.textContent = entry.name;
		const meta = dom.append(nameCell, dom.$('span'));
		meta.style.fontSize = '11px';
		meta.style.color = 'var(--vscode-descriptionForeground)';
		meta.textContent = entry.summaries.length > 0
			? entry.summaries.join(' · ')
			: localize('chipos.hooks.invalid', 'no valid hook (check the JSON)');

		const actions = dom.append(row, dom.$('.chipos-rule-actions'));
		const editBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		editBtn.textContent = localize('chipos.hooks.edit', 'Edit');
		this._listDisposables.add(dom.addDisposableListener(editBtn, 'click', () => {
			this._editorService.openEditor({ resource: entry.file });
		}));
		const delBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
		delBtn.textContent = localize('chipos.hooks.delete', 'Delete');
		this._listDisposables.add(dom.addDisposableListener(delBtn, 'click', async () => {
			try {
				await this._fileService.del(entry.file, { useTrash: true });
			} catch { /* ignore */ }
			this._refresh();
		}));
	}

	private _refresh(): void {
		if (this._listContainer?.isConnected) {
			this._loadList(this._listContainer);
		}
	}

	private async _createNew(): Promise<void> {
		const dir = this._hooksDir();
		if (!dir) {
			return;
		}
		const name = await this._quickInputService.input({
			title: localize('chipos.hooks.new.title', 'New Hook'),
			prompt: localize('chipos.hooks.new.prompt', 'File name (created under .chipos/hooks/, .json added if omitted)'),
			placeHolder: 'no-terminal',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.hooks.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		let id = name?.trim();
		if (!id) {
			return;
		}
		if (!/\.json$/i.test(id)) {
			id = `${id}.json`;
		}
		const file = URI.joinPath(dir, id);
		const template = JSON.stringify({
			point: 'tool.before_dispatch',
			action: 'deny',
			tool_name: 'run_in_terminal',
			reason: 'Blocked by a workspace hook.',
		}, null, 2) + '\n';
		try {
			await this._fileService.writeFile(file, VSBuffer.fromString(template));
			await this._editorService.openEditor({ resource: file });
			this._refresh();
		} catch { /* ignore */ }
	}
}
