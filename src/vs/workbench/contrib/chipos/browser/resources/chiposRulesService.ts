/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RuleDescriptor } from './promptResourceAttachmentCollector.js';
import { RESOURCE_LAYOUTS, resourcePlanes, scanResourcePlane, isResourceEnabled } from './chiposResourceScopes.js';

/**
 * Indexes rule files for the prompt-resource collector (FEAT-001a/b).
 *
 * Scans both the project plane (each workspace folder's `.chipos/rules/`) and
 * the user-global plane (`~/.chipos-ide/rules/`), parses frontmatter, and returns
 * {@link RuleDescriptor}s tagged with their true scope (`source`). A rule
 * disabled from the Rules tab (`chipos.rules.disabled`) is filtered out here so
 * it drops from the next invoke with no other wiring. Workspace rules take
 * precedence over a user-global rule of the same name (project overrides user).
 */
export class ChiposRulesService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/**
	 * Scan the project + user-global rule planes and return parsed, enabled rule
	 * descriptors. A single unreadable or malformed file is skipped, never failing
	 * the whole scan (P3-design §5 — isolate per-rule failures).
	 */
	async getRules(): Promise<RuleDescriptor[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'rules');

		const rules: RuleDescriptor[] = [];
		const seen = new Set<string>(); // workspace precedence: planes are workspace-first
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.rules);
			for (const r of scanned) {
				if (!isResourceEnabled(this._configurationService, 'rules', r.scope, r.name) || seen.has(r.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(r.editFile);
					const parsed = parseRuleFile(content.value.toString());
					rules.push({
						name: r.name,
						source: r.scope === 'workspace' ? 'workspace' : 'user',
						sourceRef: r.editFile.path,
						ruleType: parsed.ruleType,
						globs: parsed.globs,
						body: parsed.body,
						description: parsed.description,
					});
					seen.add(r.name);
				} catch {
					// skip unreadable / malformed rule file — do not fail the scan
				}
			}
		}
		return rules;
	}
}
