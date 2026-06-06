/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RESOURCE_LAYOUTS, resourcePlanes, scanResourcePlane, isResourceEnabled, userGlobalResourceDir } from './chiposResourceScopes.js';

/** Default skill-body byte cap (FEAT-003 NFR-8): `chipos.skills.maxBodySize`. */
const DEFAULT_MAX_BODY_BYTES = 102400;

/**
 * A skill's catalog-visible header (FEAT-003 / ADR-004). Mirrors the wire
 * `SkillHeader` in `backend_v2/.../contracts/invoke.py`. Only name + description
 * travel in-band; the body is lazy-loaded later via the `read_skill_body` tool.
 *
 * NOTE: the wire `source` enum is `builtin | user | plugin` (no `workspace`), so
 * both project and user-global skills report `user` here; the settings tab
 * distinguishes the two by the plane it scanned, not by this field.
 */
export interface SkillHeader {
	readonly name: string;
	readonly description: string;
	readonly source: 'builtin' | 'user' | 'plugin';
	readonly source_ref?: string;
}

/**
 * Indexes skill headers for the prompt-resource collector (FEAT-003).
 *
 * Scans both the project plane (each workspace folder's `.chipos/skills/<id>/SKILL.md`)
 * and the user-global plane (`~/.chipos-ide/skills/<id>/SKILL.md`) — a directory
 * per skill with a `SKILL.md` carrying frontmatter (`description`) + a body. Only
 * the header (id = dir name, description) is returned; the body is lazy-loaded
 * via `read_skill_body`. A skill disabled from the Skills tab
 * (`chipos.skills.disabled`) is filtered out; a workspace skill takes precedence
 * over a user-global skill of the same name (project overrides user).
 */
export class ChiposSkillsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/**
	 * Scan the project + user-global skill planes and return enabled skill
	 * headers. A directory without a readable `SKILL.md` is skipped, never failing
	 * the whole scan.
	 */
	async getSkills(): Promise<SkillHeader[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'skills');

		const skills: SkillHeader[] = [];
		const seen = new Set<string>(); // workspace precedence: planes are workspace-first
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.skills);
			for (const s of scanned) {
				if (!isResourceEnabled(this._configurationService, 'skills', s.scope, s.name) || seen.has(s.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(s.editFile);
					// Reuse the frontmatter parser purely to lift `description`; the
					// body is parsed but intentionally discarded (header-only).
					const parsed = parseRuleFile(content.value.toString());
					skills.push({
						name: s.name,
						description: parsed.description ?? '',
						source: 'user',
						source_ref: s.editFile.path,
					});
					seen.add(s.name);
				} catch {
					// directory without a readable SKILL.md — skip, do not fail scan
				}
			}
		}
		return skills;
	}

	/**
	 * Lazy-load a skill's instructions body (FEAT-003 / ADR-004), invoked by the
	 * model via the `read_skill_body` IDE tool. Returns `{ content, isError }`:
	 *   - reads `<plane>/skills/<skillId>/SKILL.md` — workspace folders first, then
	 *     the user-global plane (matching the `getSkills` precedence),
	 *   - returns the body (instructions after frontmatter), capped at
	 *     `chipos.skills.maxBodySize` bytes (truncated + a `[truncated]` marker),
	 *   - rejects a traversal-y `skillId` and an unknown skill (isError=true).
	 * Header-only scanning never reads the body; this is the only body read.
	 */
	async readBody(skillId: string): Promise<{ content: string; isError: boolean }> {
		// Path-traversal guard: a skill id is a single directory segment.
		if (!skillId || /[\\/]|\.\./.test(skillId)) {
			return { content: `Invalid skill id: ${JSON.stringify(skillId)}`, isError: true };
		}
		const maxBytes = this._configurationService.getValue<number>('chipos.skills.maxBodySize') ?? DEFAULT_MAX_BODY_BYTES;
		const candidates = this._workspaceService.getWorkspace().folders
			.map(folder => URI.joinPath(folder.uri, '.chipos', 'skills', skillId, 'SKILL.md'));
		candidates.push(URI.joinPath(await userGlobalResourceDir(this._pathService, 'skills'), skillId, 'SKILL.md'));
		for (const skillMd of candidates) {
			try {
				const content = await this._fileService.readFile(skillMd);
				const parsed = parseRuleFile(content.value.toString());
				let body = parsed.body;
				const bytes = new TextEncoder().encode(body).length;
				if (bytes > maxBytes) {
					// Approximate cap by characters (>= bytes for non-ASCII), then mark.
					body = body.slice(0, maxBytes) + '\n\n[truncated: skill body exceeds maxBodySize]';
				}
				return { content: body, isError: false };
			} catch {
				continue; // not in this plane — try the next
			}
		}
		return { content: `Skill not found: ${skillId}`, isError: true };
	}
}
