/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

const COMMAND_FILE_RE = /\.(md|txt)$/i;

/**
 * A slash command authored under a workspace's `.chipos/commands/` (FEAT-001).
 * Unlike an always-apply rule, a command is injected on demand — when the user
 * invokes `/<name>` — so the collector matches `name` against the typed token.
 */
export interface CommandDescriptor {
	readonly name: string;
	readonly body: string;
	/** Who contributed it — workspace `.chipos/commands/` or an installed plugin. */
	readonly source: 'workspace' | 'plugin';
	/** Workspace file path, or the plugin id for a plugin-contributed command. */
	readonly sourceRef: string;
}

/**
 * Indexes workspace command files for the prompt-resource collector (FEAT-001).
 *
 * v1 scans each workspace folder's `.chipos/commands/*.{md,txt}` — the slash
 * command convention — and returns {@link CommandDescriptor}s. The reasoner
 * renders the matched command into the synthetic instruction message (ADR-002),
 * the same path as rules but with `kind: 'command'`. The user-global plane and a
 * cached file-watcher are follow-ups; today this reads on demand per turn (the
 * file set is small and only read when the user actually types a slash command).
 */
export class ChiposCommandsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	/**
	 * Scan all workspace folders' `.chipos/commands/` and return command
	 * descriptors. Returns `[]` when no workspace / no commands dir. A single
	 * unreadable file is skipped, never failing the whole scan.
	 */
	async getCommands(): Promise<CommandDescriptor[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return [];
		}

		const commands: CommandDescriptor[] = [];
		for (const folder of folders) {
			const dir = URI.joinPath(folder.uri, '.chipos', 'commands');
			let children;
			try {
				const stat = await this._fileService.resolve(dir);
				children = stat.children;
			} catch {
				continue; // no .chipos/commands/ in this folder
			}
			if (!children) {
				continue;
			}

			for (const child of children) {
				if (child.isDirectory || !COMMAND_FILE_RE.test(child.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(child.resource);
					commands.push({
						name: child.name.replace(COMMAND_FILE_RE, ''),
						body: content.value.toString(),
						source: 'workspace',
						sourceRef: child.resource.path,
					});
				} catch {
					// skip unreadable command file — do not fail the scan
				}
			}
		}
		return commands;
	}
}
