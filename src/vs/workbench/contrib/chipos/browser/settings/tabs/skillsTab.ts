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
import { parseRuleFile } from '../../resources/frontmatterParser.js';

interface ISkillEntry {
	readonly name: string;
	readonly description: string;
	readonly dir: URI;
	readonly skillMd: URI;
}

/**
 * Skills settings tab (FEAT-003). Lists the workspace skills under
 * `.chipos/skills/<name>/SKILL.md` (the `description` frontmatter is what the
 * agent sees as a menu; the body is lazy-loaded when the agent uses the skill),
 * with New/Edit/Delete. Plugin- and builtin-contributed skills are managed
 * elsewhere (the Plugins tab / shipped with ChipOS).
 */
export class SkillsTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	// Row listeners are re-created on each reload — keep them off the class store.
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
		dom.append(header, dom.$('.chipos-settings-section-title', undefined, localize('chipos.skills.title', 'Skills')));
		const newBtn = dom.append(header, dom.$('button.chipos-btn-secondary'));
		newBtn.textContent = localize('chipos.skills.new', '+ New Skill');
		this._disposables.add(dom.addDisposableListener(newBtn, 'click', () => this._createNew()));

		dom.append(section, dom.$('.chipos-setting-description', undefined,
			localize('chipos.skills.desc', 'Skills are loaded from .chipos/skills/<name>/SKILL.md in your workspace. The frontmatter "description" is shown to the agent as a menu; the body is loaded on demand only when the agent decides to use the skill. Skills from installed plugins appear via the Plugins tab.')));

		this._listContainer = dom.append(section, dom.$('.chipos-rules-list'));
		this._loadList(this._listContainer);
	}

	private _skillsDir(): URI | undefined {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length > 0 ? URI.joinPath(folders[0].uri, '.chipos', 'skills') : undefined;
	}

	private async _loadList(container: HTMLElement): Promise<void> {
		const epoch = ++this._epoch;
		const dir = this._skillsDir();
		const entries: ISkillEntry[] = [];
		if (dir) {
			try {
				const children = (await this._fileService.resolve(dir)).children ?? [];
				for (const child of children) {
					if (!child.isDirectory) {
						continue;
					}
					const skillMd = URI.joinPath(child.resource, 'SKILL.md');
					try {
						const content = (await this._fileService.readFile(skillMd)).value.toString();
						entries.push({ name: child.name, description: parseRuleFile(content).description ?? '', dir: child.resource, skillMd });
					} catch {
						// a directory without a readable SKILL.md — skip it
					}
				}
			} catch {
				// no .chipos/skills/ yet
			}
		}

		if (epoch !== this._epoch || !container.isConnected) {
			return;
		}
		this._listDisposables.clear();
		dom.clearNode(container);

		if (!dir) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.skills.noWorkspace', 'No workspace open. Open a folder to add skills.')));
			return;
		}
		if (entries.length === 0) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.skills.empty', 'No skills yet. Click "+ New Skill" to create one under .chipos/skills/.')));
			return;
		}
		for (const entry of entries) {
			this._renderRow(container, entry);
		}
	}

	private _renderRow(parent: HTMLElement, entry: ISkillEntry): void {
		const row = dom.append(parent, dom.$('.chipos-rule-item'));
		const icon = dom.append(row, dom.$('span.codicon.codicon-lightbulb'));
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
		if (entry.description) {
			const meta = dom.append(nameCell, dom.$('span'));
			meta.style.fontSize = '11px';
			meta.style.color = 'var(--vscode-descriptionForeground)';
			meta.textContent = entry.description;
		}

		const actions = dom.append(row, dom.$('.chipos-rule-actions'));
		const editBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		editBtn.textContent = localize('chipos.skills.edit', 'Edit');
		this._listDisposables.add(dom.addDisposableListener(editBtn, 'click', () => {
			this._editorService.openEditor({ resource: entry.skillMd });
		}));
		const delBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
		delBtn.textContent = localize('chipos.skills.delete', 'Delete');
		this._listDisposables.add(dom.addDisposableListener(delBtn, 'click', async () => {
			try {
				await this._fileService.del(entry.dir, { recursive: true, useTrash: true });
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
		const dir = this._skillsDir();
		if (!dir) {
			return;
		}
		const name = await this._quickInputService.input({
			title: localize('chipos.skills.new.title', 'New Skill'),
			prompt: localize('chipos.skills.new.prompt', 'Skill name (used as the folder under .chipos/skills/)'),
			placeHolder: 'explain-code',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.skills.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		const id = name?.trim();
		if (!id) {
			return;
		}
		const skillMd = URI.joinPath(dir, id, 'SKILL.md');
		const template = `---\ndescription: One-line description the agent sees in its skill menu.\n---\n# ${id}\n\nDescribe what this skill does and how to use it. The agent loads this body\non demand when it decides to use the skill.\n`;
		try {
			await this._fileService.writeFile(skillMd, VSBuffer.fromString(template));
			await this._editorService.openEditor({ resource: skillMd });
			this._refresh();
		} catch { /* ignore */ }
	}
}
