/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

/**
 * `git log` needs Node, which the browser layer doesn't type. We use the bare
 * global `require` Electron's renderer injects (the same binding editorEffects.ts
 * / gitImport.ts rely on; `globalThis.require` is a DIFFERENT, undefined binding),
 * declared locally so the browser tsconfig (no `@types/node`) type-checks, with a
 * hand-typed slice of `child_process` and a literal-specifier helper. Resolves to
 * undefined outside Electron, where collect() degrades to no git-log context.
 */
declare const require: ((moduleName: string) => unknown) | undefined;

/** The slice of Node's `child_process` we use, typed locally to avoid node types. */
interface INodeChildProcess {
	exec(
		command: string,
		options: { readonly cwd?: string; readonly timeout?: number },
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	): void;
}

function requireChildProcess(): INodeChildProcess | undefined {
	try {
		return typeof require === 'function' ? (require('child_process') as INodeChildProcess) : undefined;
	} catch {
		return undefined;
	}
}

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
			const cp = requireChildProcess();
			if (!cp) {
				resolve(undefined);
				return;
			}
			try {
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
