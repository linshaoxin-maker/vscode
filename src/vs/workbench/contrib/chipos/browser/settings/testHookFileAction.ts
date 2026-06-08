/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { parseHookFileContent } from '../resources/chiposHooksService.js';

const CHIPOS_CATEGORY = localize2('chipos.category', 'ChipOS');

/**
 * FEAT-004 B6 — `ChipOS: Test Hook File`. Validates + previews the hooks in the
 * active `.chipos/hooks/*.json` editor: parses each hook and shows what it would do
 * (declarative: action on tool @ point; function: which export runs), surfacing
 * malformed entries. A safe authoring "test" — declarative hooks are evaluated
 * reasoner-side and function hooks run only via consent in chat, so this validates/
 * previews rather than executing.
 */
export class TestHookFileAction extends Action2 {
	static readonly ID = 'chipos.testHookFile';

	constructor() {
		super({
			id: TestHookFileAction.ID,
			title: localize2('chipos.testHookFile', 'Test Hook File'),
			category: CHIPOS_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const quickInput = accessor.get(IQuickInputService);

		const resource = editorService.activeEditor?.resource;
		if (!resource || !resource.path.endsWith('.json') || !/[\\/]hooks[\\/]/.test(resource.path)) {
			await quickInput.pick([{ label: localize('chipos.testHookFile.notHook', 'Open a .chipos/hooks/*.json file first, then run this') }], { placeHolder: localize('chipos.testHookFile.ph0', 'Test Hook File') });
			return;
		}

		let text: string;
		try {
			text = (await fileService.readFile(resource)).value.toString();
		} catch {
			await quickInput.pick([{ label: localize('chipos.testHookFile.unreadable', 'Could not read the file') }], { placeHolder: localize('chipos.testHookFile.ph0', 'Test Hook File') });
			return;
		}

		const hooks = parseHookFileContent(text, resource.path);
		const items: IQuickPickItem[] = hooks.length
			? hooks.map(h => {
				const kind = (h as { kind?: string }).kind;
				const desc = kind === 'function'
					? localize('chipos.testHookFile.fn', 'function: runs {0} from {1} (needs consent + executablePlugins)', (h as { export?: string }).export ?? '?', (h as { module?: string }).module ?? '?')
					: localize('chipos.testHookFile.decl', '{0} on {1}', h.action, h.tool_name ?? '*');
				return { label: h.point, description: desc };
			})
			: [{ label: localize('chipos.testHookFile.none', 'No valid hooks parsed'), description: localize('chipos.testHookFile.noneHint', 'Expect a JSON array of { point, action, tool_name? }') }];

		await quickInput.pick(items, { placeHolder: localize('chipos.testHookFile.ph', '{0} hook(s) parsed — preview', hooks.length) });
	}
}
