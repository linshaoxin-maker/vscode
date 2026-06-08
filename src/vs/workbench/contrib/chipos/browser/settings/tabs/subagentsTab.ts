/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { parseRuleFile } from '../../resources/frontmatterParser.js';
import { ScannedResource } from '../../resources/chiposResourceScopes.js';
import { ResourceTabSpec } from './resourceListTab.js';

/**
 * Subagents tab (FEAT-005 Stage A) spec for the generic {@link ResourceListTab}:
 * workspace + user-global `.chipos/agents/*.md` (+ Claude `.claude/agents/`). Each
 * file is a subagent definition (frontmatter name/description + instructions).
 *
 * STAGED: this is the authoring + listing surface only — runtime dispatch (routing
 * `@agent` to the subagent) is Stage B (user-subagent contract + M1 bridge). The
 * staged posture is called out in the tab description so users aren't surprised that
 * an authored subagent doesn't run yet.
 */
export const AGENTS_RESOURCE_SPEC: ResourceTabSpec = {
	kind: 'agents',
	icon: 'organization',
	title: localize('chipos.agents.title', 'Subagents'),
	description: localize('chipos.agents.desc', '⚠️ Staged (FEAT-005 Stage A): subagents are authored and listed here from .chipos/agents/ (project) or ~/.chipos-ide/agents/ (global). Each file is a subagent definition (frontmatter name/description + instructions). Runtime dispatch — routing @agent to the subagent — arrives in Stage B; for now this is authoring + management only.'),
	newLabel: localize('chipos.agents.newAgent', '+ New Subagent'),
	emptyMessage: localize('chipos.agents.empty', 'No subagents yet. Click "+ New Subagent" to define one (.chipos/agents/<name>.md). Note: runtime dispatch is staged (Stage B).'),
	importFilter: { name: localize('chipos.agents.filter', 'Subagent files'), extensions: ['md'] },

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		const parsed = parseRuleFile((await fileService.readFile(r.editFile)).value.toString());
		return parsed.description || localize('chipos.agents.noDesc', 'subagent (staged)');
	},

	async createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined> {
		const name = await quickInput.input({
			title: localize('chipos.agents.new.title', 'New Subagent'),
			prompt: localize('chipos.agents.new.prompt', 'Subagent name (the .md file name)'),
			placeHolder: 'code-reviewer',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.agents.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		const id = name?.trim();
		if (!id) {
			return undefined;
		}
		const file = URI.joinPath(destDir, /\.md$/i.test(id) ? id : `${id}.md`);
		const template = `---\nname: ${id}\ndescription: One-line summary of what this subagent specializes in.\n---\n# ${id}\n\nDescribe this subagent's role, scope, and instructions here.\n\nRuntime dispatch is staged: Stage B will route \`@${id}\` to this subagent.\n`;
		await fileService.writeFile(file, VSBuffer.fromString(template));
		return file;
	},
};
