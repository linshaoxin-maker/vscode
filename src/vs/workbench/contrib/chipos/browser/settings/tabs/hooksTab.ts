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
 * The 14 canonical ReasonerHookPoints with friendly labels for the New-Hook
 * wizard. `denyCapable` = the reasoner honours a `deny` here (only
 * tool.before_dispatch + subagent.before_invoke today — the rest are observe);
 * `toolMatch` = a `tool_name` matcher is meaningful (tool/subagent points).
 * Order: the two deny-capable points first (most useful), then observe points.
 * Keep in sync with VALID_POINTS in chiposHooksService.ts.
 */
const HOOK_POINTS: ReadonlyArray<{ readonly point: string; readonly label: string; readonly denyCapable: boolean; readonly toolMatch: boolean }> = [
	{ point: 'tool.before_dispatch', label: localize('chipos.hooks.pt.toolBefore', 'Before a tool runs — can BLOCK it'), denyCapable: true, toolMatch: true },
	{ point: 'subagent.before_invoke', label: localize('chipos.hooks.pt.subBefore', 'Before delegating to a sub-agent — can BLOCK it'), denyCapable: true, toolMatch: true },
	{ point: 'tool.after_result', label: localize('chipos.hooks.pt.toolAfter', 'After a tool returns (observe)'), denyCapable: false, toolMatch: true },
	{ point: 'subagent.after_result', label: localize('chipos.hooks.pt.subAfter', 'After a sub-agent returns (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'turn.before_start', label: localize('chipos.hooks.pt.turnStart', 'When a turn starts (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'turn.after_end', label: localize('chipos.hooks.pt.turnEnd', 'When a turn ends (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'turn.on_error', label: localize('chipos.hooks.pt.turnErr', 'When a turn errors (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'final.before_emit', label: localize('chipos.hooks.pt.final', 'Before the final answer (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'llm.before_call', label: localize('chipos.hooks.pt.llmBefore', 'Before each model call (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'llm.after_response', label: localize('chipos.hooks.pt.llmAfter', 'After each model response (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'prompt.before_render', label: localize('chipos.hooks.pt.promptBefore', 'Before the prompt is built (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'prompt.after_render', label: localize('chipos.hooks.pt.promptAfter', 'After the prompt is built (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'context.before_collect', label: localize('chipos.hooks.pt.ctxBefore', 'Before context is collected (observe)'), denyCapable: false, toolMatch: false },
	{ point: 'context.after_collect', label: localize('chipos.hooks.pt.ctxAfter', 'After context is collected (observe)'), denyCapable: false, toolMatch: false },
];

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
	description: localize('chipos.hooks.desc', 'Hooks are loaded from .chipos/hooks/*.json (project) or ~/.chipos/hooks/ (global). Each hook is { point, action, tool_name?, reason? }; a "deny" at tool.before_dispatch blocks the matching tool, "observe" just records. Points include tool.before_dispatch, tool.after_result, turn.before_start, turn.after_end.'),
	newLabel: localize('chipos.hooks.new', '+ New Hook'),
	emptyMessage: localize('chipos.hooks.empty', 'No hooks yet. Click "+ New Hook", or import a hook JSON with "Import from Local…".'),
	importFilter: { name: localize('chipos.hooks.filter', 'Hook files'), extensions: ['json'] },

	async metaForRow(fileService: IFileService, r: ScannedResource): Promise<string> {
		const content = (await fileService.readFile(r.editFile)).value.toString();
		const summaries = parseHookFileContent(content, r.name).map(h => `${h.action} ${h.tool_name ?? '*'} @ ${h.point}`);
		return summaries.length > 0 ? summaries.join(' · ') : localize('chipos.hooks.invalid', 'no valid hook (check the JSON)');
	},

	async createNew(fileService: IFileService, quickInput: IQuickInputService, destDir: URI): Promise<URI | undefined> {
		// Guided wizard so the user never hand-writes the JSON: name -> when (point)
		// -> action (deny only where the reasoner honours it) -> tool/role (only
		// for tool/subagent points) -> reason (only for deny). The result file is
		// still opened afterwards so it can be tweaked.
		const name = await quickInput.input({
			title: localize('chipos.hooks.new.title', 'New Hook (1/4) — name'),
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

		const pointPick = await quickInput.pick(
			HOOK_POINTS.map(p => ({ label: p.label, description: p.point, point: p.point, denyCapable: p.denyCapable, toolMatch: p.toolMatch })),
			{ title: localize('chipos.hooks.new.pointTitle', 'New Hook (2/4) — when should it fire?') },
		);
		if (!pointPick) {
			return undefined;
		}

		let action = 'observe';
		if (pointPick.denyCapable) {
			const actPick = await quickInput.pick([
				{ label: localize('chipos.hooks.act.deny', 'Deny — block it'), id: 'deny' },
				{ label: localize('chipos.hooks.act.observe', 'Observe — just record'), id: 'observe' },
			], { title: localize('chipos.hooks.new.actTitle', 'New Hook (3/4) — action') });
			if (!actPick) {
				return undefined;
			}
			action = actPick.id === 'deny' ? 'deny' : 'observe';
		}

		let toolName: string | undefined;
		if (pointPick.toolMatch) {
			const t = await quickInput.input({
				title: localize('chipos.hooks.new.toolTitle', 'New Hook (4/4) — which tool/role?'),
				value: '*',
				prompt: localize('chipos.hooks.new.toolPrompt', 'Tool name (e.g. run_in_terminal) or sub-agent role; * matches any'),
			});
			if (t === undefined) {
				return undefined;
			}
			toolName = t.trim() || '*';
		}

		let reason: string | undefined;
		if (action === 'deny') {
			const r = await quickInput.input({
				title: localize('chipos.hooks.new.reasonTitle', 'Reason shown to the agent when blocked'),
				placeHolder: localize('chipos.hooks.new.reasonPh', 'Blocked by a workspace policy.'),
			});
			reason = (r ?? '').trim() || 'Blocked by a workspace hook.';
		}

		const hookObj: Record<string, unknown> = { point: pointPick.point, action };
		if (toolName) {
			hookObj.tool_name = toolName;
		}
		if (reason) {
			hookObj.reason = reason;
		}
		const file = URI.joinPath(destDir, id);
		await fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(hookObj, null, 2) + '\n'));
		return file;
	},
};
