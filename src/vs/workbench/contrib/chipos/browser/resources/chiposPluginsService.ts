/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RuleDescriptor } from './promptResourceAttachmentCollector.js';
import { CommandDescriptor } from './chiposCommandsService.js';
import { SkillHeader } from './chiposSkillsService.js';
import { parseHookFileContent } from './chiposHooksService.js';
import { ReasonerHookDefinition } from '../chatAgent/statelessInvoke/types.js';
import { PLUGIN_MANIFEST_DIRS, PluginManifest, parsePluginManifest, installLocalPlugin, IPluginInstallResult } from './pluginInstaller.js';
import { isAllowedGitUrl, cloneGitRepo } from './gitImport.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

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
	/** False when the plugin id is in `chipos.plugins.disabled` (FEAT-002c). */
	readonly enabled: boolean;
	readonly ruleCount: number;
	readonly commandCount: number;
	readonly skillCount: number;
}

/** Config key holding the ids of disabled plugins (FEAT-002c). */
const DISABLED_PLUGINS_KEY = 'chipos.plugins.disabled';

/**
 * Indexes installed agent plugins under `~/.chipos-ide/plugins/<id>/` and
 * decomposes their contributed rules/commands/skills into the FEAT-001/003
 * collector shapes, tagged `source: 'plugin'` (so the renderer adds the
 * `[from plugin <id>]` provenance badge). Also installs (FEAT-002a) and
 * disables/uninstalls (FEAT-002c) plugins. A **disabled** plugin stays on disk
 * but contributes nothing — the decomposition scan filters it out, so its
 * resources drop from the next invoke with no other wiring.
 *
 * NOTE: this is the chipos agent-plugin (AI-capability bundle) format — NOT a VS
 * Code extension (.vsix / Open VSX), which is a separate IDE concern.
 */
export class ChiposPluginsService {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/** `~/.chipos-ide/plugins/` — the user-global install root for agent plugins. */
	private async _pluginsRoot(): Promise<URI> {
		const home = await this._pathService.userHome();
		return URI.joinPath(home, '.chipos-ide', 'plugins');
	}

	/**
	 * Resolve `relPath` inside an installed plugin's dir to an absolute on-disk
	 * URI, traversal-guarded (FEAT-004 / H-3 executable hooks). Used by the H-3
	 * caller to locate a plugin's hook module before handing it to the isolated
	 * subprocess host. Returns `undefined` when:
	 *   - the resolved path escapes `~/.chipos-ide/plugins/<pluginId>/` (a `..`
	 *     segment tried to climb out — SECURITY: never load such a file), or
	 *   - the target does not exist on disk.
	 * This is the ONLY sanctioned way to turn an untrusted `module` carrier from
	 * a `hook_eval` event into a path the host may fork.
	 */
	async resolvePluginFile(pluginId: string, relPath: string): Promise<URI | undefined> {
		const root = await this._pluginsRoot();
		const pluginDir = URI.joinPath(root, pluginId);
		const segs = relPath.split(/[\\/]+/).filter(s => s && s !== '.');
		const target = URI.joinPath(pluginDir, ...segs);
		// TRAVERSAL GUARD: a `..` segment escaped the plugin dir — reject.
		if (!(target.path === pluginDir.path || target.path.startsWith(pluginDir.path + '/'))) {
			return undefined;
		}
		if (!(await this._fileService.exists(target))) {
			return undefined;
		}
		return target;
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

	/** Hosts a plugin may be cloned from (`chipos.plugins.allowedGitDomains`). */
	private _allowedGitDomains(): string[] {
		const raw = this._configurationService.getValue<string[]>('chipos.plugins.allowedGitDomains');
		return Array.isArray(raw) && raw.length > 0 ? raw : ['github.com'];
	}

	/**
	 * Install a plugin from a Git URL (FEAT-002b): validate the host against
	 * `chipos.plugins.allowedGitDomains`, shallow-clone into a temp dir, then hand
	 * the clone to the verified {@link installLocalPlugin} core. The temp clone is
	 * always removed (success or failure) so no residue is left. Rejects before
	 * any clone when the host is not allow-listed. `cloneToTemp` is injectable for
	 * hermetic tests; production uses the real git clone.
	 */
	async installFromGit(url: string, cloneToTemp?: (url: string) => Promise<URI>): Promise<IPluginInstallResult> {
		const allowed = this._allowedGitDomains();
		if (!isAllowedGitUrl(url, allowed)) {
			throw new Error(`Refusing to clone from an untrusted host. Allowed hosts (chipos.plugins.allowedGitDomains): ${allowed.join(', ')}.`);
		}
		const clone = cloneToTemp ?? (u => this._cloneToTemp(u));
		const tempDir = await clone(url);
		try {
			return await installLocalPlugin(this._fileService, tempDir, await this._pluginsRoot());
		} finally {
			// Always remove the temp clone — on success it has been copied to
			// <id>/, on failure it is residue.
			try {
				await this._fileService.del(tempDir, { recursive: true, useTrash: false });
			} catch {
				// best-effort cleanup
			}
		}
	}

	/** Shallow-clone `url` into a fresh temp dir under `~/.chipos-ide/.cache/`. */
	private async _cloneToTemp(url: string): Promise<URI> {
		const home = await this._pathService.userHome();
		const cloneParent = URI.joinPath(home, '.chipos-ide', '.cache', 'plugin-clones');
		await this._fileService.createFolder(cloneParent);
		const tempDir = URI.joinPath(cloneParent, generateUuid());
		await cloneGitRepo(url, tempDir.fsPath, { timeoutMs: 60000 });
		// Drop the cloned `.git` history so it is not copied into the install.
		try {
			await this._fileService.del(URI.joinPath(tempDir, '.git'), { recursive: true, useTrash: false });
		} catch {
			// best-effort: a plugin still installs fine if .git is absent / undeletable
		}
		return tempDir;
	}

	/** The set of disabled plugin ids from `chipos.plugins.disabled` (FEAT-002c). */
	private _disabledIds(): ReadonlySet<string> {
		const raw = this._configurationService.getValue<string[]>(DISABLED_PLUGINS_KEY);
		return new Set(Array.isArray(raw) ? raw : []);
	}

	/** Whether a plugin currently contributes its resources (FEAT-002c). */
	isPluginEnabled(id: string): boolean {
		return !this._disabledIds().has(id);
	}

	/**
	 * Enable/disable a plugin by adding/removing its id from
	 * `chipos.plugins.disabled` (user scope). A disabled plugin stays installed
	 * but its rules/commands/skills are filtered out of the next decomposition
	 * scan — no other wiring needed (FEAT-002c, BDD "disable 移除贡献资源").
	 */
	async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
		const next = new Set(this._disabledIds());
		if (enabled) {
			next.delete(id);
		} else {
			next.add(id);
		}
		await this._configurationService.updateValue(DISABLED_PLUGINS_KEY, [...next], ConfigurationTarget.USER);
	}

	/**
	 * Uninstall a plugin: delete `~/.chipos-ide/plugins/<id>/`, then drop any
	 * stale `disabled` entry (so a later reinstall starts enabled). If the delete
	 * throws, the error propagates before the cleanup — an already-disabled
	 * plugin therefore stays disabled (FEAT-002c rollback invariant: a failed
	 * file delete keeps the prior disable in effect).
	 */
	async uninstall(id: string): Promise<void> {
		const target = URI.joinPath(await this._pluginsRoot(), id);
		await this._fileService.del(target, { recursive: true, useTrash: false });
		if (this._disabledIds().has(id)) {
			await this.setPluginEnabled(id, true);
		}
	}

	/** Installed plugins minus the disabled ones — the set the decomposition uses. */
	private async _getEnabledPlugins(): Promise<InstalledPlugin[]> {
		const disabled = this._disabledIds();
		return (await this.getInstalledPlugins()).filter(p => !disabled.has(p.manifest.id));
	}

	/**
	 * List installed plugins with a count of the rules/commands/skills each
	 * contributes + its enabled state — the data the Plugins settings tab renders.
	 * Includes disabled plugins (shown greyed with an Enable action). Counts mirror
	 * the decomposition rules in {@link getPluginRules}/{@link getPluginCommands}/
	 * {@link getPluginSkills} (matching file extensions; a skill = a subdir with a
	 * readable `SKILL.md`).
	 */
	async getInstalledPluginSummaries(): Promise<PluginContributionSummary[]> {
		const plugins = await this.getInstalledPlugins();
		const disabled = this._disabledIds();
		const summaries: PluginContributionSummary[] = [];
		for (const plugin of plugins) {
			summaries.push({
				manifest: plugin.manifest,
				root: plugin.root,
				enabled: !disabled.has(plugin.manifest.id),
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
	 * Decompose every **enabled** plugin's `rules/*.{mdc,md,txt}` into
	 * {@link RuleDescriptor}s (source=plugin, sourceRef=plugin id). The caller
	 * merges these with the workspace rules before the FEAT-001a collector runs.
	 * Disabled plugins (FEAT-002c) are skipped so their rules drop from the invoke.
	 */
	async getPluginRules(): Promise<RuleDescriptor[]> {
		const plugins = await this._getEnabledPlugins();
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
	 * Decompose every **enabled** plugin's `commands/*.{md,txt}` into
	 * {@link CommandDescriptor}s (source=plugin, sourceRef=plugin id). The caller
	 * merges these with the workspace commands for the `/<name>` lookup. Disabled
	 * plugins (FEAT-002c) are skipped.
	 */
	async getPluginCommands(): Promise<CommandDescriptor[]> {
		const plugins = await this._getEnabledPlugins();
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
	 * Decompose every **enabled** plugin's `skills/<id>/SKILL.md` headers into
	 * {@link SkillHeader}s (source=plugin, source_ref=plugin id). Header only —
	 * the body is lazy-loaded via read_skill_body. The caller merges these with
	 * the workspace skills for the `## Available Skills` catalog. Disabled plugins
	 * (FEAT-002c) are skipped.
	 */
	async getPluginSkills(): Promise<SkillHeader[]> {
		const plugins = await this._getEnabledPlugins();
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

	/**
	 * Decompose every **enabled** plugin's `hooks/*.json` into
	 * {@link ReasonerHookDefinition}s (source=plugin, source_ref=plugin id). The
	 * caller merges these with the workspace hooks before the FEAT-004 invoke, so
	 * the reasoner registers them as per-turn dispatcher subscribers. Each file
	 * holds one hook object or an array of them. Disabled plugins (FEAT-002c) are
	 * skipped so their hooks drop from the invoke.
	 */
	async getPluginHooks(): Promise<ReasonerHookDefinition[]> {
		const plugins = await this._getEnabledPlugins();
		const hooks: ReasonerHookDefinition[] = [];
		for (const plugin of plugins) {
			const hooksDir = URI.joinPath(plugin.root, 'hooks');
			let children;
			try {
				children = (await this._fileService.resolve(hooksDir)).children;
			} catch {
				continue; // plugin contributes no hooks
			}
			if (!children) {
				continue;
			}
			for (const child of children) {
				if (child.isDirectory || !/\.json$/i.test(child.name)) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(child.resource);
					hooks.push(...parseHookFileContent(content.value.toString(), plugin.manifest.id, 'plugin'));
				} catch {
					// skip unreadable / malformed hook file — never fail the scan
				}
			}
		}
		return hooks;
	}
}
