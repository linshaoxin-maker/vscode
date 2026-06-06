/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { RESOURCE_LAYOUTS, resourcePlanes, scanResourcePlane, isResourceEnabled } from './chiposResourceScopes.js';

/**
 * A slash command authored under `.chipos/commands/` (project) or
 * `~/.chipos-ide/commands/` (user-global) (FEAT-001). Unlike an always-apply
 * rule, a command is injected on demand — when the user invokes `/<name>` — so
 * the collector matches `name` against the typed token.
 */
export interface CommandDescriptor {
	readonly name: string;
	readonly body: string;
	/** Who contributed it — workspace `.chipos/commands/`, the user-global plane, or an installed plugin. */
	readonly source: 'workspace' | 'user' | 'plugin';
	/** File path, or the plugin id for a plugin-contributed command. */
	readonly sourceRef: string;
}

/**
 * Indexes command files for the prompt-resource collector (FEAT-001).
 *
 * Scans both the project plane (each workspace folder's `.chipos/commands/`) and
 * the user-global plane (`~/.chipos-ide/commands/`) and returns
 * {@link CommandDescriptor}s. The reasoner renders the matched command into the
 * synthetic instruction message (ADR-002), the same path as rules but with
 * `kind: 'command'`. A command disabled from the Commands tab
 * (`chipos.commands.disabled`) is filtered out; workspace overrides a
 * user-global command of the same name.
 */
export class ChiposCommandsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/**
	 * Scan the project + user-global command planes and return enabled command
	 * descriptors. A single unreadable file is skipped, never failing the scan.
	 */
	async getCommands(): Promise<CommandDescriptor[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'commands');

		const commands: CommandDescriptor[] = [];
		const seen = new Set<string>(); // workspace precedence: planes are workspace-first
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.commands);
			for (const c of scanned) {
				if (!isResourceEnabled(this._configurationService, 'commands', c.scope, c.name) || seen.has(c.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(c.editFile);
					commands.push({
						name: c.name,
						body: content.value.toString(),
						source: c.scope === 'workspace' ? 'workspace' : 'user',
						sourceRef: c.editFile.path,
					});
					seen.add(c.name);
				} catch {
					// skip unreadable command file — do not fail the scan
				}
			}
		}
		return commands;
	}
}
