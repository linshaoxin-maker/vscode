/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { dirname, isEqualOrParent } from '../../../../../base/common/resources.js';
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
 * the user-global plane (`~/.chipos/rules/`), parses frontmatter, and returns
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
	 *
	 * When `anchorDir` is supplied (and `chipos.rules.agentsMdInterop` is not
	 * explicitly `false`), AGENTS.md / CLAUDE.md files are additionally discovered
	 * along the directory chain from the containing workspace-folder root down to
	 * `anchorDir`, for Claude Code / agents.md cross-tool compatibility.
	 */
	async getRules(anchorDir?: URI): Promise<RuleDescriptor[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'rules');

		const rules: RuleDescriptor[] = [];
		const seen = new Set<string>(); // workspace precedence: planes are workspace-first
		for (const plane of planes) {
			const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.rules);
			for (const r of scanned) {
				if (!isResourceEnabled(this._configurationService, 'rules', r.scope, r.source, r.name) || seen.has(r.name)) {
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
						priority: parsed.priority,
					});
					seen.add(r.name);
				} catch {
					// skip unreadable / malformed rule file — do not fail the scan
				}
			}
		}

		if (anchorDir && this._configurationService.getValue('chipos.rules.agentsMdInterop') !== false) {
			rules.push(...await this._discoverAgentsFiles(anchorDir));
		}
		return rules;
	}

	/**
	 * Lazy-load an `agent` rule's body on the model's request (FEAT-001b/c), the
	 * rule-side mirror of {@link ChiposSkillsService.readBody}. `agent` rules ship
	 * header-only in `prompt_resource_attachments` (description, empty body); when
	 * the model decides one is relevant it calls the `read_rule_body` IDE tool to
	 * pull the full instructions.
	 *
	 * Scans the same rule planes as {@link getRules} (project folders first, then
	 * the user-global plane — workspace precedence), finds the first enabled rule
	 * whose name === `ruleId`, parses it, and returns `{ content: body, isError:
	 * false }`. A missing / disabled / unreadable rule yields `{ content: 'Rule
	 * not found: <id>', isError: true }`. Never throws — per-rule failures are
	 * isolated exactly as in `getRules`.
	 */
	async readBody(ruleId: string): Promise<{ content: string; isError: boolean }> {
		try {
			const folders = this._workspaceService.getWorkspace().folders;
			const planes = await resourcePlanes(this._pathService, folders.map(f => f.uri), 'rules');
			for (const plane of planes) {
				const scanned = await scanResourcePlane(this._fileService, plane.dir, plane.scope, RESOURCE_LAYOUTS.rules);
				for (const r of scanned) {
					if (r.name !== ruleId || !isResourceEnabled(this._configurationService, 'rules', r.scope, r.source, r.name)) {
						continue;
					}
					try {
						const content = await this._fileService.readFile(r.editFile);
						const parsed = parseRuleFile(content.value.toString());
						return { content: parsed.body, isError: false };
					} catch {
						// found by name but unreadable — fall through to the not-found result
					}
				}
			}
		} catch {
			// scan failure — fall through to the not-found result, never throw
		}
		return { content: `Rule not found: ${ruleId}`, isError: true };
	}

	/**
	 * Discover AGENTS.md / CLAUDE.md files along the directory chain from the
	 * workspace-folder root that contains `anchorDir` down to `anchorDir` itself
	 * (inclusive). Files nearer to `anchorDir` get a higher `priority` so the
	 * collector (which sorts priority DESC) surfaces the nearest context first.
	 * Best-effort: an unreadable file is skipped, never failing discovery.
	 */
	private async _discoverAgentsFiles(anchorDir: URI): Promise<RuleDescriptor[]> {
		const folder = this._workspaceService.getWorkspace().folders.find(f => isEqualOrParent(anchorDir, f.uri));
		if (!folder) {
			return [];
		}
		const root = folder.uri;

		// Build the ancestor chain from `anchorDir` upward to the folder root, then
		// reverse so it is root-first.
		const chain: URI[] = [];
		let current = anchorDir;
		while (isEqualOrParent(current, root)) {
			chain.push(current);
			const parent = dirname(current);
			if (parent.toString() === current.toString()) {
				break; // reached the filesystem root — stop to avoid an infinite loop
			}
			current = parent;
		}
		chain.reverse();

		const MARKERS = ['CLAUDE.md', 'AGENTS.md']; // Claude first (same-dir preference) per the full-compat decision
		const MAX_FILES = 30;
		const rules: RuleDescriptor[] = [];
		for (let depthIndex = 0; depthIndex < chain.length; depthIndex++) {
			const dir = chain[depthIndex];
			for (const marker of MARKERS) {
				if (rules.length >= MAX_FILES) {
					return rules;
				}
				const file = URI.joinPath(dir, marker);
				if (await this._fileService.exists(file)) {
					try {
						const content = await this._fileService.readFile(file);
						const body = await this._resolveAgentsImports(content.value.toString(), dir, new Set([file.toString()]), 0);
						const rel = dir.path.slice(root.path.length).replace(/^\/+/, '');
						const name = rel ? `${marker} (${rel})` : marker;
						rules.push({
							name,
							source: 'workspace',
							sourceRef: file.path,
							ruleType: 'always',
							body,
							priority: depthIndex,
						});
					} catch {
						// skip unreadable AGENTS/CLAUDE file — do not fail discovery
					}
				}
			}
		}
		return rules;
	}

	/**
	 * Inline Claude Code `@path` imports found on their own line. Each import is
	 * resolved relative to `baseDir` and recursively expanded (up to `MAX_DEPTH`),
	 * with a `seen` set guarding against import cycles. Non-import lines and any
	 * line that fails to resolve are left verbatim. Best-effort: never throws.
	 */
	private async _resolveAgentsImports(content: string, baseDir: URI, seen: Set<string>, depth: number): Promise<string> {
		const MAX_DEPTH = 5;
		if (depth >= MAX_DEPTH) {
			return content;
		}
		const importLine = /^@(?<path>\S+)\s*$/;
		const lines = content.split('\n');
		const resolved: string[] = [];
		for (const line of lines) {
			const matched = importLine.exec(line);
			if (!matched?.groups) {
				resolved.push(line);
				continue;
			}
			const segments = matched.groups.path.split('/').filter(s => s && s !== '.');
			const target = URI.joinPath(baseDir, ...segments);
			const key = target.toString();
			if (seen.has(key)) {
				resolved.push(line); // cycle guard — leave the import verbatim
				continue;
			}
			try {
				const imported = await this._fileService.readFile(target);
				seen.add(key);
				resolved.push(await this._resolveAgentsImports(imported.value.toString(), dirname(target), seen, depth + 1));
			} catch {
				resolved.push(line); // unresolved import — leave verbatim
			}
		}
		return resolved.join('\n');
	}
}
