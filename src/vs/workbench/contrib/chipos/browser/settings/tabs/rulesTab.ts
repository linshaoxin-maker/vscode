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

export class RulesTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) {
		super();
		this._render();
	}

	private _render(): void {
		// ── Section: Project Rules ──
		const projectSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(projectSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.rules.project', 'Project Rules')));

		dom.append(projectSection, dom.$('.chipos-setting-description', undefined,
			localize('chipos.rules.project.desc', 'Project-level rules are loaded from .chipos/rules/ in your workspace. These rules provide context and instructions to the AI agent for this specific project.')));

		// Show detected rules files
		const rulesListContainer = dom.append(projectSection, dom.$('.chipos-rules-list'));
		this._detectProjectRules(rulesListContainer);

		// ── Section: Global Rules ──
		const globalSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(globalSection, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.rules.global', 'Global Rules')));

		const globalRow = dom.append(globalSection, dom.$('.chipos-setting-row'));
		dom.append(globalRow, dom.$('.chipos-setting-label', undefined,
			localize('chipos.rules.globalFile', 'Global Rules File')));
		dom.append(globalRow, dom.$('.chipos-setting-description', undefined,
			localize('chipos.rules.globalFile.desc', 'Path to a global rules file that applies to all projects. Supports .md and .txt files.')));

		const globalInput = dom.append(globalRow, dom.$<HTMLInputElement>('input.chipos-setting-input'));
		globalInput.type = 'text';
		globalInput.placeholder = '~/.chipos/global-rules.md';
		globalInput.value = this._configurationService.getValue<string>('chipos.rules.globalFile') || '';

		this._disposables.add(dom.addDisposableListener(globalInput, 'change', () => {
			this._configurationService.updateValue('chipos.rules.globalFile', globalInput.value || undefined, ConfigurationTarget.USER);
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
				const list = dom.append(container, dom.$('ul.chipos-rules-list'));
				for (const child of stat.children) {
					if (!child.isDirectory) {
						const li = dom.append(list, dom.$('li'));
						li.textContent = child.name;
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
}
