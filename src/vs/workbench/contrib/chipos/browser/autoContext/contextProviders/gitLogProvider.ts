/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';
import type { IChiposGitService } from '../../../common/chiposGitService.js';

/**
 * `git log` needs Node `child_process`, which the sandboxed renderer of a PACKAGED
 * app does not have (no global `require`). The original bare-`require` form
 * therefore silently produced no git-log context in the packaged build. We now run
 * git in the MAIN process via the injected {@link IChiposGitService}; an undefined
 * service (web / no Electron) degrades to no git-log context.
 */
const MAX_COMMITS = 5;

export class GitLogProvider implements IContextProvider {

	readonly source = ContextSourceType.GitLog;

	constructor(
		private readonly _workspaceContext: IWorkspaceContextService,
		private readonly _gitService?: IChiposGitService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const folder = this._workspaceContext.getWorkspace().folders[0];
			if (!folder) {
				return [];
			}

			const cwd = folder.uri.fsPath;
			const output = await this._execGitLog(cwd);
			if (!output) {
				return [];
			}

			const content = `Recent commits:\n${output}`;
			return [{
				source: ContextSourceType.GitLog,
				content,
				priority: 7,
				tokenEstimate: Math.ceil(content.length / 4),
				metadata: { cwd },
			}];
		} catch {
			return [];
		}
	}

	private async _execGitLog(cwd: string): Promise<string | undefined> {
		if (!this._gitService) {
			return undefined;
		}
		try {
			const res = await this._gitService.exec({
				args: ['log', '--oneline', '--no-decorate', '-n', String(MAX_COMMITS)],
				cwd,
				timeoutMs: 5000,
			});
			return res.ok && res.stdout.trim() ? res.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	}
}
