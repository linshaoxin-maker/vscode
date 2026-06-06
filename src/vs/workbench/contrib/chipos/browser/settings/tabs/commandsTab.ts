/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ScannedResource } from '../../resources/chiposResourceScopes.js';
import { ResourceTabSpec } from './resourceListTab.js';

/**
 * Commands tab (FEAT-001) spec for the generic {@link ResourceListTab}: workspace
 * + user-global `.chipos/commands/*.{md,txt}`. A command is injected on demand
 * when the user types `/<name>` in chat. New / Import-Local (.md/.txt) /
 * Import-Git / Edit / Delete / enable-disable.
 */
export const COMMANDS_RESOURCE_SPEC: ResourceTabSpec = {
	kind: 'commands',
	icon: 'terminal',
	title: localize('chipos.commands.title', 'Commands'),
	description: localize('chipos.commands.desc', 'Slash commands are loaded from .chipos/commands/ (project) or ~/.chipos-ide/commands/ (global). Invoke one by typing /<name> in chat — the file body is injected as the instruction for that turn. Import existing command files from a folder or a Git repo.'),
	newLabel: localize('chipos.commands.new', '+ New Command'),
	emptyMessage: localize('chipos.commands.empty', 'No commands yet. Click "+ New Command", or import existing command files with "Import from Local…".'),
	importFilter: { name: localize('chipos.commands.filter', 'Command files'), extensions: ['md', 'txt'] },

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		// Show the first meaningful line of the body as a hint, prefixed by the invocation.
		const body = (await fileService.readFile(r.editFile)).value.toString();
		const firstLine = body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(l => l.length > 0) ?? '';
		const usage = localize('chipos.commands.usage', 'Run with /{0}', r.name);
		return firstLine ? `${usage} — ${firstLine.slice(0, 80)}` : usage;
	},

	async createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined> {
		const name = await quickInput.input({
			title: localize('chipos.commands.new.title', 'New Command'),
			prompt: localize('chipos.commands.new.prompt', 'Command name (invoked as /<name>)'),
			placeHolder: 'review',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.commands.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		const id = name?.trim();
		if (!id) {
			return undefined;
		}
		const file = URI.joinPath(destDir, /\.(md|txt)$/i.test(id) ? id : `${id}.md`);
		const template = `# ${id}\n\nWhen the user runs /${id}, do the following:\n\n- Step one\n- Step two\n`;
		await fileService.writeFile(file, VSBuffer.fromString(template));
		return file;
	},
};
