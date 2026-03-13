/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ISCMService, ISCMRepository } from '../../../../../../workbench/contrib/scm/common/scm.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

export class GitDiffProvider implements IContextProvider {

	readonly source = ContextSourceType.GitDiff;

	constructor(
		private readonly _scmService: ISCMService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const items: IContextItem[] = [];
			const repos = [...this._scmService.repositories];

			for (const repo of repos) {
				const summary = this._summarizeRepository(repo);
				if (summary) {
					items.push({
						source: ContextSourceType.GitDiff,
						content: summary,
						priority: 3,
						tokenEstimate: Math.ceil(summary.length / 4),
						metadata: { repoId: repo.id },
					});
				}
			}

			return items;
		} catch {
			return [];
		}
	}

	private _summarizeRepository(repo: ISCMRepository): string | undefined {
		const lines: string[] = [];

		for (const group of repo.provider.groups) {
			if (group.resources.length === 0) {
				continue;
			}
			lines.push(`[${group.label}]`);
			for (const resource of group.resources) {
				lines.push(`  ${resource.sourceUri.fsPath}`);
			}
		}

		return lines.length > 0
			? `Git changes (${repo.provider.label}):\n${lines.join('\n')}`
			: undefined;
	}
}
