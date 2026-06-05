/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RuleDescriptor } from './promptResourceAttachmentCollector.js';
import { CommandDescriptor } from './chiposCommandsService.js';
import { SkillHeader } from './chiposSkillsService.js';
import { PLUGIN_MANIFEST_DIRS, PluginManifest, parsePluginManifest, installLocalPlugin, IPluginInstallResult } from './pluginInstaller.js';

const RULE_FILE_RE = /\.(mdc|md|txt)$/i;
const COMMAND_FILE_RE = /\.(md|txt)$/i;

/** An installed agent plugin: its manifest + the install dir it lives in. */
export interface InstalledPlugin {
	readonly manifest: PluginManifest;
	readonly root: URI;
}

/** An installed plugin plus a count of the resources it contributes (Plugins tab). */
export interface PluginContributionSummary {
	readonly manifest: PluginManifest;
	readonly root: URI;
	readonly ruleCount: number;
	readonly commandCount: number;
	readonly skillCount: number;
}

/**
 * Indexes installed agent plugins (FEAT-002a) under `~/.chipos-ide/plugins/<id>/`
 * and decomposes their contributed resources into the FEAT-001 collector shapes,
 * tagged `source: 'plugin'` (so the renderer adds the `[from plugin <id>]`
 * provenance badge). v1 covers plugin-contributed **rules**; commands/skills/hooks
 * decomposition + the install command + a Plugins tab are follow-up slices.
 *
 * NOTE: this is the chipos agent-plugin (AI-capability bundle) format — NOT a VS
 * Code extension (.vsix / Open VSX), which is a separate IDE concern.
 */
export class ChiposPluginsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
	) { }

	/** `~/.chipos-ide/plugins/` — the user-global install root for agent plugins. */
	private async _pluginsRoot(): Promise<URI> {
		const home = await this._pathService.userHome();
		return URI.joinPath(home, '.chipos-ide', 'plugins');
	}

	/**
	 * Scan the install root and return each plugin whose manifest parses. A dir
	 * without a valid `.chipos-plugin/plugin.json` (or Cursor `.cursor-plugin/`)
	 * is skipped — an invalid manifest never fails the whole scan here (the
	 * install path is where a bad manifest is rejected with a message).
	 */
	async getInstalledPlugins(): Promise<InstalledPlugin[]> {
		const root = await this._pluginsRoot();
		let entries;
		try {
			entries = (await this._fileService.resolve(root)).children;
		} catch {
			return []; // no install root yet
		}
		if (!entries) {
			return [];
		}
		const plugins: InstalledPlugin[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory) {
				continue;
			}
			for (const probe of PLUGIN_MANIFEST_DIRS) {
				const manifestUri = URI.joinPath(entry.resource, probe.dir, probe.file);
				try {
					const content = await this._fileService.readFile(manifestUri);
					const manifest = parsePluginManifest(content.value.toString(), probe.source);
					plugins.push({ manifest, root: entry.resource });
					break; // first matching manifest wins
				} catch {
					// not this manifest format / invalid — try the next probe
				}
			}
		}
		return plugins;
	}

	/**
	 * Install a local plugin folder into `~/.chipos-ide/plugins/<id>/`. Thin
	 * orchestration over {@link installLocalPlugin} (the testable core): supplies
	 * the file service + resolved install root. Rejects with `PluginManifestError`
	 * when the folder has no valid manifest — the install command surfaces it.
	 */
	async installFromFolder(sourceDir: URI): Promise<IPluginInstallResult> {
		return installLocalPlugin(this._fileService, sourceDir, await this._pluginsRoot());
	}

	/**
	 * List installed plugins with a count of the rules/commands/skills each
	 * contributes — the data the Plugins settings tab renders. Counts mirror the
	 * decomposition rules in {@link getPluginRules}/{@link getPluginCommands}/
	 * {@link getPluginSkills} (matching file extensions; a skill = a subdir with
	 * a readable `SKILL.md`).
	 */
	async getInstalledPluginSummaries(): Promise<PluginContributionSummary[]> {
		const plugins = await this.getInstalledPlugins();
		const summaries: PluginContributionSummary[] = [];
		for (const plugin of plugins) {
			summaries.push({
				manifest: plugin.manifest,
				root: plugin.root,
				ruleCount: await this._countFiles(URI.joinPath(plugin.root, 'rules'), RULE_FILE_RE),
				commandCount: await this._countFiles(URI.joinPath(plugin.root, 'commands'), COMMAND_FILE_RE),
				skillCount: await this._countSkillDirs(URI.joinPath(plugin.root, 'skills')),
			});
		}
		return summaries;
	}

	/** Count non-dir entries in `dir` whose name matches `fileRe` (0 if absent). */
	private async _countFiles(dir: URI, fileRe: RegExp): Promise<number> {
		try {
			const children = (await this._fileService.resolve(dir)).children ?? [];
			return children.filter(c => !c.isDirectory && fileRe.test(c.name)).length;
		} catch {
			return 0;
		}
	}

	/** Count subdirs of `dir` that contain a readable `SKILL.md` (0 if absent). */
	private async _countSkillDirs(dir: URI): Promise<number> {
		try {
			const children = (await this._fileService.resolve(dir)).children ?? [];
			let count = 0;
			for (const child of children) {
				if (child.isDirectory && await this._fileService.exists(URI.joinPath(child.resource, 'SKILL.md'))) {
					count++;
				}
			}
			return count;
		} catch {
			return 0;
		}
	}

	/**
	 * Decompose every installed plugin's `rules/*.{mdc,md,txt}` into
	 * {@link RuleDescriptor}s (source=plugin, sourceRef=plugin id). The caller
	 * merges these with the workspace rules before the FEAT-001a collector runs.
	 */
	async getPluginRules(): Promise<RuleDescriptor[]> {
		const plugins = await this.getInstalledPlugins();
		const rules: RuleDescriptor[] = [];
		for (const plugin of plugins) {
			const rulesDir = URI.joinPath(plugin.root, 'rules');
			let children;
			try {
				children = (await this._fileService.resolve(rulesDir)).children;
			} catch {
				continue; // plugin contributes no rules
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
						source: 'plugin',
						sourceRef: plugin.manifest.id,
						ruleType: parsed.ruleType,
						globs: parsed.globs,
						body: parsed.body,
						description: parsed.description,
					});
				} catch {
					// skip unreadable / malformed rule file — never fail the scan
				}
			}
		}
		return rules;
	}

	/**
	 * Decompose every installed plugin's `commands/*.{md,txt}` into
	 * {@link CommandDescriptor}s (source=plugin, sourceRef=plugin id). The caller
	 * merges these with the workspace commands for the `/<name>` lookup.
	 */
	async getPluginCommands(): Promise<CommandDescriptor[]> {
		const plugins = await this.getInstalledPlugins();
		const commands: CommandDescriptor[] = [];
		for (const plugin of plugins) {
			const dir = URI.joinPath(plugin.root, 'commands');
			let children;
			try {
				children = (await this._fileService.resolve(dir)).children;
			} catch {
				continue;
			}
			if (!children) {
				continue;
			}
			for (const child of children) {
				if (child.isDirectory || !COMMAND_FILE_RE.test(child.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(child.resource);
					commands.push({
						name: child.name.replace(COMMAND_FILE_RE, ''),
						body: content.value.toString(),
						source: 'plugin',
						sourceRef: plugin.manifest.id,
					});
				} catch {
					// skip unreadable command file — never fail the scan
				}
			}
		}
		return commands;
	}

	/**
	 * Decompose every installed plugin's `skills/<id>/SKILL.md` headers into
	 * {@link SkillHeader}s (source=plugin, source_ref=plugin id). Header only —
	 * the body is lazy-loaded via read_skill_body. The caller merges these with
	 * the workspace skills for the `## Available Skills` catalog.
	 */
	async getPluginSkills(): Promise<SkillHeader[]> {
		const plugins = await this.getInstalledPlugins();
		const skills: SkillHeader[] = [];
		for (const plugin of plugins) {
			const skillsDir = URI.joinPath(plugin.root, 'skills');
			let entries;
			try {
				entries = (await this._fileService.resolve(skillsDir)).children;
			} catch {
				continue;
			}
			if (!entries) {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory) {
					continue;
				}
				const skillMd = URI.joinPath(entry.resource, 'SKILL.md');
				try {
					const content = await this._fileService.readFile(skillMd);
					const parsed = parseRuleFile(content.value.toString());
					skills.push({
						name: entry.name,
						description: parsed.description ?? '',
						source: 'plugin',
						source_ref: plugin.manifest.id,
					});
				} catch {
					// directory without a readable SKILL.md — skip
				}
			}
		}
		return skills;
	}
}
