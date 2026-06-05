/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RuleDescriptor } from './promptResourceAttachmentCollector.js';

const RULE_FILE_RE = /\.(mdc|md|txt)$/i;

/**
 * Indexes workspace rule files for the prompt-resource collector (FEAT-001a/b).
 *
 * v1 scans each workspace folder's `.chipos/rules/*.{mdc,md,txt}` — the existing
 * project-rules convention (see rulesTab) — parses frontmatter, and returns
 * {@link RuleDescriptor}s. The user-global `~/.chipos-ide/rules/` plane and a
 * cached file-watcher are follow-ups; today this reads on demand per turn (the
 * collector is cheap and the file set is small).
 */
export class ChiposRulesService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	/**
	 * Scan all workspace folders' `.chipos/rules/` and return parsed rule
	 * descriptors. Returns `[]` when no workspace / no rules dir. A single
	 * unreadable or malformed file is skipped, never failing the whole scan
	 * (P3-design §5 — isolate per-rule failures).
	 */
	async getRules(): Promise<RuleDescriptor[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return [];
		}

		const rules: RuleDescriptor[] = [];
		for (const folder of folders) {
			const rulesDir = URI.joinPath(folder.uri, '.chipos', 'rules');
			let children;
			try {
				const stat = await this._fileService.resolve(rulesDir);
				children = stat.children;
			} catch {
				continue; // no .chipos/rules/ in this folder
			}
			if (!children) {
				continue;
			}

			for (const child of children) {
				if (child.isDirectory || !RULE_FILE_RE.test(child.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(child.resource);
					const parsed = parseRuleFile(content.value.toString());
					rules.push({
						name: child.name.replace(RULE_FILE_RE, ''),
						source: 'workspace',
						sourceRef: child.resource.path,
						ruleType: parsed.ruleType,
						globs: parsed.globs,
						body: parsed.body,
						description: parsed.description,
					});
				} catch {
					// skip unreadable / malformed rule file — do not fail the scan
				}
			}
		}
		return rules;
	}
}
