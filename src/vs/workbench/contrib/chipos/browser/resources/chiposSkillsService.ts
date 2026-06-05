/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { parseRuleFile } from './frontmatterParser.js';

/**
 * A skill's catalog-visible header (FEAT-003 / ADR-004). Mirrors the wire
 * `SkillHeader` in `backend_v2/.../contracts/invoke.py`. Only name + description
 * travel in-band; the body is lazy-loaded later via the `read_skill_body` tool.
 */
export interface SkillHeader {
	readonly name: string;
	readonly description: string;
	readonly source: 'builtin' | 'user' | 'plugin';
	readonly source_ref?: string;
}

/**
 * Indexes workspace skill headers for the prompt-resource collector (FEAT-003).
 *
 * v1 scans each workspace folder's `.chipos/skills/<id>/SKILL.md` — the skill
 * convention is a directory per skill with a `SKILL.md` carrying frontmatter
 * (`description`) + a body. Only the header (id = dir name, description) is
 * returned; the body is NOT shipped (the model lazy-loads it via
 * `read_skill_body`). The user-global `~/.chipos-ide/skills/` plane and plugin
 * skills (FEAT-002a) are follow-ups; today this reads on demand per turn.
 */
export class ChiposSkillsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	/**
	 * Scan all workspace folders' `.chipos/skills/` and return skill headers.
	 * Returns `[]` when no workspace / no skills dir. A directory without a
	 * readable `SKILL.md` is skipped, never failing the whole scan.
	 */
	async getSkills(): Promise<SkillHeader[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return [];
		}

		const skills: SkillHeader[] = [];
		for (const folder of folders) {
			const skillsDir = URI.joinPath(folder.uri, '.chipos', 'skills');
			let entries;
			try {
				const stat = await this._fileService.resolve(skillsDir);
				entries = stat.children;
			} catch {
				continue; // no .chipos/skills/ in this folder
			}
			if (!entries) {
				continue;
			}

			for (const entry of entries) {
				if (!entry.isDirectory) {
					continue; // each skill is a `<id>/` directory
				}
				const skillMd = URI.joinPath(entry.resource, 'SKILL.md');
				try {
					const content = await this._fileService.readFile(skillMd);
					// Reuse the frontmatter parser purely to lift `description`; the
					// body is parsed but intentionally discarded (header-only).
					const parsed = parseRuleFile(content.value.toString());
					skills.push({
						name: entry.name,
						description: parsed.description ?? '',
						source: 'user',
						source_ref: skillMd.path,
					});
				} catch {
					// directory without a readable SKILL.md — skip, do not fail scan
				}
			}
		}
		return skills;
	}
}
