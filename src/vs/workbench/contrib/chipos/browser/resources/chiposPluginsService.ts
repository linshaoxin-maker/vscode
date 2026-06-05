/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { parseRuleFile } from './frontmatterParser.js';
import { RuleDescriptor } from './promptResourceAttachmentCollector.js';
import { PLUGIN_MANIFEST_DIRS, PluginManifest, parsePluginManifest } from './pluginInstaller.js';

const RULE_FILE_RE = /\.(mdc|md|txt)$/i;

/** An installed agent plugin: its manifest + the install dir it lives in. */
export interface InstalledPlugin {
	readonly manifest: PluginManifest;
	readonly root: URI;
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
}
