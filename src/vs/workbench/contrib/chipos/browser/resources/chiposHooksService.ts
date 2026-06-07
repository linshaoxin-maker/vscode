/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ReasonerHookAction, ReasonerHookDefinition, ReasonerHookPoint } from '../chatAgent/statelessInvoke/types.js';
import { RESOURCE_LAYOUTS, resourcePlanes, scanResourcePlane, isResourceEnabled } from './chiposResourceScopes.js';

/** Max hooks sent per turn — mirrors the reasoner `InvokeRequest.hooks` cap. */
export const MAX_HOOKS = 100;

const VALID_POINTS: ReadonlySet<string> = new Set<ReasonerHookPoint>([
	'turn.before_start', 'context.before_collect', 'context.after_collect',
	'prompt.before_render', 'prompt.after_render', 'llm.before_call',
	'llm.after_response', 'tool.before_dispatch', 'tool.after_result',
	'subagent.before_invoke', 'subagent.after_result', 'final.before_emit',
	'turn.after_end', 'turn.on_error',
]);

/**
 * Coerce one parsed JSON value into a {@link ReasonerHookDefinition}, or
 * `undefined` if it isn't a structurally valid hook (unknown/absent `point`).
 */
function toHookDefinition(raw: unknown, sourceRef: string, source: NonNullable<ReasonerHookDefinition['source']>): ReasonerHookDefinition | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const point = obj.point;
	if (typeof point !== 'string' || !VALID_POINTS.has(point)) {
		return undefined;
	}
	const action: ReasonerHookAction = (obj.action === 'deny' || obj.action === 'amend' || obj.action === 'ask') ? obj.action : 'observe';
	const hook: ReasonerHookDefinition = {
		point: point as ReasonerHookPoint,
		action,
		source,
		source_ref: sourceRef,
	};
	if (typeof obj.tool_name === 'string') {
		hook.tool_name = obj.tool_name.slice(0, 128);
	}
	if (typeof obj.reason === 'string') {
		hook.reason = obj.reason.slice(0, 512);
	}
	return hook;
}

/**
 * Parse one `.chipos/hooks/*.json` file body into validated hook definitions.
 * The file may hold a single hook object or an array of them. Pure + total: bad
 * JSON or invalid entries yield `[]` / are dropped, never throwing — so one bad
 * file can't fail the whole scan.
 */
export function parseHookFileContent(text: string, sourceRef: string, source: NonNullable<ReasonerHookDefinition['source']> = 'workspace'): ReasonerHookDefinition[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const hooks: ReasonerHookDefinition[] = [];
	for (const entry of entries) {
		const hook = toHookDefinition(entry, sourceRef, source);
		if (hook) {
			hooks.push(hook);
		}
	}
	return hooks;
}

/**
 * Indexes workspace hook files for the stateless invoke request (FEAT-004).
 *
 * Scans each workspace folder's `.chipos/hooks/*.json` — each file holds one
 * hook object or an array of them — and returns validated
 * {@link ReasonerHookDefinition}s for {@link InvokeRequest.hooks}. The reasoner
 * registers each as a per-turn dispatcher subscriber, so a `deny` hook at
 * `tool.before_dispatch` blocks the matching tool. The user-global
 * `~/.chipos-ide/hooks/` plane, a settings-tab UI, and a cached file-watcher are
 * follow-ups; today this reads on demand per turn (the file set is small).
 */
export class ChiposHooksService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/**
	 * Scan the project + user-global hook planes and return validated, enabled
	 * hook definitions (capped at {@link MAX_HOOKS}). A single unreadable,
	 * malformed, or invalid file is skipped, never failing the whole scan. A hook
	 * file disabled from the Hooks tab (`chipos.hooks.disabled`, per-file like
	 * Cursor) is filtered out.
	 */
	async getHooks(): Promise<ReasonerHookDefinition[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'hooks');

		const hooks: ReasonerHookDefinition[] = [];
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.hooks);
			for (const h of scanned) {
				if (!isResourceEnabled(this._configurationService, 'hooks', h.scope, h.name)) {
					continue; // per-file disable (id = `<scope>:<filename>`)
				}
				try {
					const content = await this._fileService.readFile(h.editFile);
					const source = h.scope === 'workspace' ? 'workspace' : 'user';
					hooks.push(...parseHookFileContent(content.value.toString(), h.editFile.path, source));
				} catch {
					// skip unreadable hook file — do not fail the scan
				}
			}
		}
		return hooks.slice(0, MAX_HOOKS);
	}
}
