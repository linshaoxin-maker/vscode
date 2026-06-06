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
import { parseHookFileContent } from '../../resources/chiposHooksService.js';
import { ResourceTabSpec } from './resourceListTab.js';

/**
 * Hooks tab (FEAT-004) spec for the generic {@link ResourceListTab}: workspace +
 * user-global `.chipos/hooks/*.json`, each `{ point, action, tool_name?, reason? }`
 * (a `deny` at `tool.before_dispatch` blocks the matching tool before it runs).
 * Enable/disable is per-file (matching Cursor). chipos hooks are declarative —
 * NOT executable shell — so importing one carries no code-execution risk.
 */
export const HOOKS_RESOURCE_SPEC: ResourceTabSpec = {
	kind: 'hooks',
	icon: 'shield',
	title: localize('chipos.hooks.title', 'Hooks'),
	description: localize('chipos.hooks.desc', 'Hooks are loaded from .chipos/hooks/*.json (project) or ~/.chipos-ide/hooks/ (global). Each hook is { point, action, tool_name?, reason? }; a "deny" at tool.before_dispatch blocks the matching tool, "observe" just records. Points include tool.before_dispatch, tool.after_result, turn.before_start, turn.after_end.'),
	newLabel: localize('chipos.hooks.new', '+ New Hook'),
	emptyMessage: localize('chipos.hooks.empty', 'No hooks yet. Click "+ New Hook", or import a hook JSON with "Import from Local…".'),
	importFilter: { name: localize('chipos.hooks.filter', 'Hook files'), extensions: ['json'] },

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		const content = (await fileService.readFile(r.editFile)).value.toString();
		const summaries = parseHookFileContent(content, r.name).map(h => `${h.action} ${h.tool_name ?? '*'} @ ${h.point}`);
		return summaries.length > 0 ? summaries.join(' · ') : localize('chipos.hooks.invalid', 'no valid hook (check the JSON)');
	},

	async createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined> {
		const name = await quickInput.input({
			title: localize('chipos.hooks.new.title', 'New Hook'),
			prompt: localize('chipos.hooks.new.prompt', 'File name (.json added if omitted)'),
			placeHolder: 'no-terminal',
			validateInput: async value => (/^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : localize('chipos.hooks.new.invalid', 'Use letters, digits, ".", "_" or "-" only.')),
		});
		let id = name?.trim();
		if (!id) {
			return undefined;
		}
		if (!/\.json$/i.test(id)) {
			id = `${id}.json`;
		}
		const file = URI.joinPath(destDir, id);
		const template = JSON.stringify({
			point: 'tool.before_dispatch',
			action: 'deny',
			tool_name: 'run_in_terminal',
			reason: 'Blocked by a workspace hook.',
		}, null, 2) + '\n';
		await fileService.writeFile(file, VSBuffer.fromString(template));
		return file;
	},
};
