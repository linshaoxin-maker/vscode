/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
 * Skills tab (FEAT-003) spec for the generic {@link ResourceListTab}: workspace +
 * user-global `.chipos/skills/<id>/SKILL.md` (the `description` frontmatter is the
 * agent's menu; the body lazy-loads via `read_skill_body`). New / Import-Local
 * (a folder containing SKILL.md) / Import-Git / Edit / Delete / enable-disable.
 */
export const SKILLS_RESOURCE_SPEC: ResourceTabSpec = {
	kind: 'skills',
	icon: 'lightbulb',
	title: localize('chipos.skills.title', 'Skills'),
	description: localize('chipos.skills.desc', 'Skills are loaded from .chipos/skills/<name>/SKILL.md (project) or ~/.chipos/skills/ (global). The frontmatter "description" is shown to the agent as a menu; the body loads on demand only when the agent uses the skill. Import a folder that contains a SKILL.md, or a Git repo of skills. Skills from installed plugins appear via the Plugins tab.'),
	newLabel: localize('chipos.skills.new', '+ New Skill'),
	emptyMessage: localize('chipos.skills.empty', 'No skills yet. Click "+ New Skill", or import an existing SKILL.md folder with "Import from Local…".'),

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		const content = (await fileService.readFile(r.editFile)).value.toString();
		return parseRuleFile(content).description ?? '';
	},

	async createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined> {
		const name = await quickInput.input({
			title: localize('chipos.skills.new.title', 'New Skill'),
			prompt: localize('chipos.skills.new.prompt', 'Skill name (used as the folder name)'),
			placeHolder: 'explain-code',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.skills.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		const id = name?.trim();
		if (!id) {
			return undefined;
		}
		const skillMd = URI.joinPath(destDir, id, 'SKILL.md');
		const template = `---\ndescription: One-line description the agent sees in its skill menu.\n---\n# ${id}\n\nDescribe what this skill does and how to use it. The agent loads this body\non demand when it decides to use the skill.\n`;
		if (await fileService.exists(skillMd)) { throw new Error(localize('chipos.skills.exists', 'A resource with that name already exists — choose a different name.')); }
		await fileService.writeFile(skillMd, VSBuffer.fromString(template));
		return skillMd;
	},
};
