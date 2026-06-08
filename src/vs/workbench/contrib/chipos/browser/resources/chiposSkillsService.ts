/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { ChiposPluginsService } from './chiposPluginsService.js';
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
	/** FEAT-011c: true when SKILL.md declares a `script:` (a runnable skill). Awareness only — execution is gated by chipos.skills.executableScripts + workspace trust. */
	readonly hasScript?: boolean;
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
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustService: IWorkspaceTrustManagementService,
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
						hasScript: !!parsed.script,
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

		// 1) Project + user-global planes (the user's own skills — no trust gate).
		const candidates = this._workspaceService.getWorkspace().folders
			.map(folder => URI.joinPath(folder.uri, '.chipos', 'skills', skillId, 'SKILL.md'));
		candidates.push(URI.joinPath(await userGlobalResourceDir(this._pathService, 'skills'), skillId, 'SKILL.md'));
		for (const skillMd of candidates) {
			const capped = await this._readCapped(skillMd, maxBytes);
			if (capped) {
				return capped;
			}
		}

		// 2) Plugin-contributed skills (FEAT-003 BDD-003-04): third-party content —
		// require workspace trust before loading the body ("untrusted plugin").
		// getPluginSkills already excludes disabled plugins, so a disabled plugin's
		// skill simply falls through to "not found".
		const plugins = this._instantiationService.createInstance(ChiposPluginsService);
		const match = (await plugins.getPluginSkills()).find(s => s.name === skillId);
		if (match?.source_ref) {
			if (!this._workspaceTrustService.isWorkspaceTrusted()) {
				return { content: `Skill '${skillId}' is contributed by a plugin; trust this workspace to load it (Plugins tab).`, isError: true };
			}
			const uri = await plugins.resolvePluginFile(match.source_ref, `skills/${skillId}/SKILL.md`);
			if (uri) {
				const capped = await this._readCapped(uri, maxBytes);
				if (capped) {
					return capped;
				}
			}
		}

		return { content: `Skill not found: ${skillId}`, isError: true };
	}

	/** Read a SKILL.md body capped at `maxBytes` (truncated + marker); `undefined` if unreadable. */
	private async _readCapped(skillMd: URI, maxBytes: number): Promise<{ content: string; isError: boolean } | undefined> {
		try {
			const content = await this._fileService.readFile(skillMd);
			let body = parseRuleFile(content.value.toString()).body;
			// Approximate cap by characters (>= bytes for non-ASCII), then mark.
			if (new TextEncoder().encode(body).length > maxBytes) {
				body = body.slice(0, maxBytes) + '\n\n[truncated: skill body exceeds maxBodySize]';
			}
			return { content: body, isError: false };
		} catch {
			return undefined;
		}
	}

	/**
	 * FEAT-011c — resolve a skill's bundled executable command, trust-gated. Returns
	 * `{ script, cwd }` ONLY when ALL hold: the chipos.skills.executableScripts opt-in
	 * is on, the workspace is trusted, the skill exists, and its SKILL.md declares a
	 * `script:`. Otherwise `undefined` (the script stays inert). `cwd` is the skill
	 * directory so the worker runs the script relative to it (sandboxed).
	 */
	async getSkillScript(skillId: string): Promise<{ script: string; cwd: string } | undefined> {
		if (!skillId || /[\\/]|\.\./.test(skillId)) {
			return undefined;
		}
		// Opt-in + workspace trust are BOTH required to even resolve a script.
		if (this._configurationService.getValue<boolean>('chipos.skills.executableScripts') !== true) {
			return undefined;
		}
		if (!this._workspaceTrustService.isWorkspaceTrusted()) {
			return undefined;
		}
		// Project + user-global planes, then plugin-contributed (already trust-gated above).
		const candidates = this._workspaceService.getWorkspace().folders
			.map(folder => URI.joinPath(folder.uri, '.chipos', 'skills', skillId, 'SKILL.md'));
		candidates.push(URI.joinPath(await userGlobalResourceDir(this._pathService, 'skills'), skillId, 'SKILL.md'));
		for (const skillMd of candidates) {
			const script = await this._readScript(skillMd);
			if (script) {
				return { script, cwd: URI.joinPath(skillMd, '..').fsPath };
			}
		}
		const plugins = this._instantiationService.createInstance(ChiposPluginsService);
		const match = (await plugins.getPluginSkills()).find(s => s.name === skillId);
		if (match?.source_ref) {
			const uri = await plugins.resolvePluginFile(match.source_ref, `skills/${skillId}/SKILL.md`);
			if (uri) {
				const script = await this._readScript(uri);
				if (script) {
					return { script, cwd: URI.joinPath(uri, '..').fsPath };
				}
			}
		}
		return undefined;
	}

	/** Lift the `script:` frontmatter from a SKILL.md; `undefined` if none/unreadable. */
	private async _readScript(skillMd: URI): Promise<string | undefined> {
		try {
			const content = await this._fileService.readFile(skillMd);
			return parseRuleFile(content.value.toString()).script;
		} catch {
			return undefined;
		}
	}
}
