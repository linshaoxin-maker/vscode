/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IFileService, IFileStat } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const MAX_ENTRIES = 100;
const MAX_DEPTH = 2;

export class ProjectStructureProvider implements IContextProvider {

	readonly source = ContextSourceType.ProjectStructure;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _workspaceContext: IWorkspaceContextService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const folders = this._workspaceContext.getWorkspace().folders;
			if (folders.length === 0) {
				return [];
			}

			const lines: string[] = [];

			for (const folder of folders) {
				const stat = await this._fileService.resolve(folder.uri, { resolveMetadata: false });
				this._walk(stat, '', 0, lines);
				if (lines.length >= MAX_ENTRIES) {
					break;
				}
			}

			if (lines.length === 0) {
				return [];
			}

			const content = `Project structure:\n${lines.join('\n')}`;
			return [{
				source: ContextSourceType.ProjectStructure,
				content,
				priority: 8,
				tokenEstimate: Math.ceil(content.length / 4),
			}];
		} catch {
			return [];
		}
	}

	private _walk(stat: IFileStat, indent: string, depth: number, lines: string[]): void {
		if (lines.length >= MAX_ENTRIES) {
			return;
		}

		const name = stat.name;
		if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') {
			return;
		}

		const icon = stat.isDirectory ? '📁' : '📄';
		lines.push(`${indent}${icon} ${name}`);

		if (stat.isDirectory && depth < MAX_DEPTH && stat.children) {
			const sorted = [...stat.children].sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) {
					return a.isDirectory ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			});
			for (const child of sorted) {
				this._walk(child, indent + '  ', depth + 1, lines);
			}
		}
	}
}
