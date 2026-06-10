/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RESOURCE_LAYOUTS, resourcePlanes, scanResourcePlane, isResourceEnabled } from './chiposResourceScopes.js';

/**
 * A user-defined subagent definition resolved for runtime routing (FEAT-005
 * Stage B). The IDE sends this inline on the invoke as `selected_agent` so the
 * reasoner can apply the agent's instructions as a per-turn persona overlay.
 */
export interface SelectedAgentDefinition {
	readonly name: string;
	readonly instructions: string;
	readonly description?: string;
	readonly mode?: string;
	/** FEAT-005 slice 2: per-agent tool allow-list (`tools:` frontmatter). The reasoner enforces it at dispatch for a `mode: subagent` sub-role; absent → full catalog. */
	readonly tools?: string[];
}

/**
 * Resolves user-defined subagents (`.chipos/agents/<name>.md` + the user-global
 * `~/.chipos-ide/agents/` plane) for FEAT-005 Stage B `@<name>` routing. Stage A
 * authors + lists them via the Subagents tab; this service reads a single one by
 * name when the user invokes it in chat. Mirrors {@link ChiposSkillsService}'s
 * plane scan + never-throw posture.
 */
export class ChiposAgentsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/**
	 * Resolve a subagent by name (the `@<name>` the user typed). Scans the project
	 * plane (workspace-first) then the user-global plane and returns the first
	 * enabled match's definition — its `.md` body becomes `instructions`. A subagent
	 * disabled from the Subagents tab (`chipos.agents.disabled`) is treated as not
	 * found, and an unreadable/missing file simply falls through to `undefined`.
	 */
	async getAgentDefinition(name: string): Promise<SelectedAgentDefinition | undefined> {
		if (!name) {
			return undefined;
		}
		const folders = this._workspaceService.getWorkspace().folders;
		const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'agents');
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.agents);
			const match = scanned.find(s => s.name === name);
			if (!match || !isResourceEnabled(this._configurationService, 'agents', match.scope, match.name)) {
				continue;
			}
			try {
				const content = await this._fileService.readFile(match.editFile);
				const parsed = parseRuleFile(content.value.toString());
				if (parsed.body) {
					return { name, instructions: parsed.body, description: parsed.description, mode: parsed.mode, tools: parsed.tools };
				}
			} catch {
				// unreadable definition — try the next plane
			}
		}
		return undefined;
	}
}
