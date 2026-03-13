/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const MAX_COMMITS = 5;

export class GitLogProvider implements IContextProvider {

	readonly source = ContextSourceType.GitLog;

	constructor(
		private readonly _workspaceContext: IWorkspaceContextService,
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

	private _execGitLog(cwd: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			try {
				// Dynamic require to avoid bundler issues in browser context
				const cp: typeof import('child_process') = require('child_process');
				cp.exec(
					`git log --oneline --no-decorate -n ${MAX_COMMITS}`,
					{ cwd, timeout: 5000 },
					(err, stdout) => {
						if (err || !stdout.trim()) {
							resolve(undefined);
						} else {
							resolve(stdout.trim());
						}
					},
				);
			} catch {
				resolve(undefined);
			}
		});
	}
}
