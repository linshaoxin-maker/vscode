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
 * Subagents tab (FEAT-005) spec for the generic {@link ResourceListTab}:
 * workspace + user-global `.chipos/agents/*.md` (+ Claude `.claude/agents/`). Each
 * file is a subagent definition (frontmatter name/description/mode/tools + an
 * instructions body that becomes the sub-role's system prompt).
 *
 * Runtime dispatch is LIVE (Stage B): typing `@<name>` in chat routes the turn to an
 * isolated sub-role (reasoner `invoke_user_subagent`). `mode: subagent` in the
 * frontmatter selects isolation — the +New template seeds it.
 */
export const AGENTS_RESOURCE_SPEC: ResourceTabSpec = {
	kind: 'agents',
	icon: 'organization',
	title: localize('chipos.agents.title', 'Subagents'),
	description: localize('chipos.agents.desc', 'Subagents are loaded from .chipos/agents/ (project) or ~/.chipos/agents/ (global). Each .md file is a subagent: frontmatter (name / description / mode: subagent / optional tools:) + an instructions body that becomes its system prompt. Type @<name> in chat to run a turn as that isolated subagent — fresh context, no parent conversation. (mode: subagent is required for isolation.)'),
	newLabel: localize('chipos.agents.newAgent', '+ New Subagent'),
	emptyMessage: localize('chipos.agents.empty', 'No subagents yet. Click "+ New Subagent" to define one (.chipos/agents/<name>.md), then type @<name> in chat to run it.'),
	importFilter: { name: localize('chipos.agents.filter', 'Subagent files'), extensions: ['md'] },

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		const parsed = parseRuleFile((await fileService.readFile(r.editFile)).value.toString());
		return parsed.description || localize('chipos.agents.noDesc', 'subagent');
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
		const template = `---\nname: ${id}\ndescription: One-line summary of what this subagent specializes in.\nmode: subagent\n---\n# ${id}\n\nDescribe this subagent's role and instructions here — this body becomes the subagent's system prompt.\n\nType \`@${id}\` in chat to run an isolated turn as this subagent (fresh context; add \`tools:\` to restrict its tools).\n`;
		if (await fileService.exists(file)) { throw new Error(localize('chipos.agents.exists', 'A resource with that name already exists — choose a different name.')); }
		await fileService.writeFile(file, VSBuffer.fromString(template));
		return file;
	},
};
