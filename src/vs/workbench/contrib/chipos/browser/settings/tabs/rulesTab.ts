/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';

export class RulesTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private _rulesListContainer: HTMLElement | undefined;
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IEditorService private readonly _editorService: IEditorService,
		@IContextViewService contextViewService: IContextViewService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
		this._render();
	}

	private _render(): void {
		// ── Section: Project Rules ──
		const projectSection = dom.append(this._container, dom.$('.chipos-settings-section'));

		const projectHeader = dom.append(projectSection, dom.$('.chipos-settings-section-header'));
		dom.append(projectHeader, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.rules.project', 'Project Rules')));

		const newRuleBtn = dom.append(projectHeader, dom.$('button.chipos-btn-secondary'));
		newRuleBtn.textContent = localize('chipos.rules.newRule', '+ New Rule');
		this._disposables.add(dom.addDisposableListener(newRuleBtn, 'click', () => {
			this._createNewRule();
		}));

		dom.append(projectSection, dom.$('.chipos-setting-description', undefined,
			localize('chipos.rules.project.desc', 'Project-level rules are loaded from .chipos/rules/ in your workspace. These rules provide context and instructions to the AI agent for this specific project.')));

		this._rulesListContainer = dom.append(projectSection, dom.$('.chipos-rules-list'));
		this._detectProjectRules(this._rulesListContainer);

		// ── Section: Global Rules ──
		const globalSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(globalSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.rules.global', 'Global Rules')));

		const globalRow = dom.append(globalSection, dom.$('.chipos-setting-row'));
		dom.append(globalRow, dom.$('.chipos-setting-label', undefined,
			localize('chipos.rules.globalFile', 'Global Rules File')));
		dom.append(globalRow, dom.$('.chipos-setting-description', undefined,
			localize('chipos.rules.globalFile.desc', 'Path to a global rules file that applies to all projects. Supports .md and .txt files.')));

		const inputContainer = dom.append(globalRow, dom.$('.chipos-setting-input-container'));
		const globalInput = this._disposables.add(new InputBox(inputContainer, this._contextViewProvider, {
			placeholder: '~/.chipos/global-rules.md',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		globalInput.value = this._configurationService.getValue<string>('chipos.rules.globalFile') || '';

		this._disposables.add(globalInput.onDidChange(value => {
			this._configurationService.updateValue('chipos.rules.globalFile', value || undefined, ConfigurationTarget.USER);
		}));

		// ── Section: Hook Files (Coming Soon) ──
		const hookSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(hookSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.rules.hooks', 'Hook Files')));

		const hookRow = dom.append(hookSection, dom.$('.chipos-setting-row.greyed-out'));
		dom.append(hookRow, dom.$('.chipos-setting-label', undefined,
			localize('chipos.rules.hookFiles', 'Hook Configuration Files')));
		dom.append(hookRow, dom.$('.chipos-setting-description', undefined,
			localize('chipos.rules.hookFiles.desc', 'Define custom shell commands to execute at strategic points in the agent workflow. Configure paths to hook files.')));
	}

	private async _createNewRule(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const rulesDir = URI.joinPath(folders[0].uri, '.chipos', 'rules');
		const fileName = `rule-${Date.now()}.md`;
		const fileUri = URI.joinPath(rulesDir, fileName);
		const template = `# New Rule\n\nDescribe your rule here. The AI agent will follow these instructions.\n`;

		try {
			await this._fileService.writeFile(fileUri, VSBuffer.fromString(template));
			await this._editorService.openEditor({ resource: fileUri });
			// Guard against tab dispose during the await above.
			if (this._rulesListContainer?.isConnected) {
				dom.clearNode(this._rulesListContainer);
				this._detectProjectRules(this._rulesListContainer);
			}
		} catch { /* ignore */ }
	}

	private async _detectProjectRules(container: HTMLElement): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.rules.noWorkspace', 'No workspace open. Open a folder to see project rules.')));
			return;
		}

		const rulesDir = URI.joinPath(folders[0].uri, '.chipos', 'rules');
		try {
			const stat = await this._fileService.resolve(rulesDir);
			if (stat.children && stat.children.length > 0) {
				for (const child of stat.children) {
					if (!child.isDirectory) {
						this._renderRuleRow(container, child.resource, child.name);
					}
				}
			} else {
				dom.append(container, dom.$('.chipos-setting-description', undefined,
					localize('chipos.rules.empty', 'No rules files found in .chipos/rules/. Create .md files to provide project-specific instructions.')));
			}
		} catch {
			dom.append(container, dom.$('.chipos-setting-description', undefined,
				localize('chipos.rules.noDir', 'No .chipos/rules/ directory found. Create it to add project rules.')));
		}
	}

	private _renderRuleRow(parent: HTMLElement, resource: URI, name: string): void {
		const row = dom.append(parent, dom.$('.chipos-rule-item'));

		const nameEl = dom.append(row, dom.$('.chipos-rule-name'));
		nameEl.textContent = name;

		const actions = dom.append(row, dom.$('.chipos-rule-actions'));

		const editBtn = dom.append(actions, dom.$('button.chipos-btn-secondary'));
		editBtn.textContent = localize('chipos.rules.edit', 'Edit');
		this._disposables.add(dom.addDisposableListener(editBtn, 'click', () => {
			this._editorService.openEditor({ resource });
		}));

		const deleteBtn = dom.append(actions, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
		deleteBtn.textContent = localize('chipos.rules.delete', 'Delete');
		this._disposables.add(dom.addDisposableListener(deleteBtn, 'click', async () => {
			try {
				await this._fileService.del(resource);
				row.remove();
			} catch { /* ignore */ }
		}));
	}
}
