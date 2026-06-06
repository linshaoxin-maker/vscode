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
 * Rules tab (FEAT-001b/c) spec for the generic {@link ResourceListTab}: workspace
 * + user-global `.chipos/rules/*.{mdc,md,txt}`. The frontmatter decides how a rule
 * applies — `alwaysApply: true` every turn, `globs:` when the active file matches,
 * otherwise manual (@-mentioned). New / Import-Local (.mdc/.md/.txt files) /
 * Import-Git / Edit / Delete / enable-disable.
 */
export const RULES_RESOURCE_SPEC: ResourceTabSpec = {
	kind: 'rules',
	icon: 'book',
	title: localize('chipos.rules.title', 'Rules'),
	description: localize('chipos.rules.desc', 'Rules are loaded from .chipos/rules/ (project) or ~/.chipos-ide/rules/ (global). Frontmatter controls when each applies: "alwaysApply: true" every turn, "globs: src/**/*.ts" when the active file matches, otherwise manual. Import existing .mdc/.md rules from a folder or a Git repo.'),
	newLabel: localize('chipos.rules.newRule', '+ New Rule'),
	emptyMessage: localize('chipos.rules.empty', 'No rules yet. Click "+ New Rule", or import existing rules with "Import from Local…".'),
	importFilter: { name: localize('chipos.rules.filter', 'Rule files'), extensions: ['mdc', 'md', 'txt'] },

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		const parsed = parseRuleFile((await fileService.readFile(r.editFile)).value.toString());
		const typeLabel = parsed.ruleType === 'glob'
			? localize('chipos.rules.metaGlob', 'glob: {0}', (parsed.globs ?? []).join(', '))
			: parsed.ruleType; // 'always' | 'manual'
		return parsed.description ? `${typeLabel} · ${parsed.description}` : typeLabel;
	},

	async createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined> {
		const name = await quickInput.input({
			title: localize('chipos.rules.new.title', 'New Rule'),
			prompt: localize('chipos.rules.new.prompt', 'Rule name (the .md file name)'),
			placeHolder: 'coding-style',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.rules.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		const id = name?.trim();
		if (!id) {
			return undefined;
		}
		const file = URI.joinPath(destDir, /\.(mdc|md|txt)$/i.test(id) ? id : `${id}.md`);
		const template = `---\ndescription: One-line summary the agent uses to decide when to apply this rule.\nalwaysApply: false\n---\n# ${id}\n\nDescribe the rule here. Set alwaysApply: true to inject it every turn, or add\nglobs: "src/**/*.ts" to inject it when a matching file is open.\n`;
		await fileService.writeFile(file, VSBuffer.fromString(template));
		return file;
	},
};
