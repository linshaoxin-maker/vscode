/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent-plugin manifest parsing (FEAT-002a). A chipos agent plugin is a folder
 * with a `.chipos-plugin/plugin.json` manifest plus convention dirs (`rules/`,
 * `commands/`, later `skills/`, `hooks/`) whose resources are decomposed into
 * the FEAT-001/003/004 collectors tagged `source: 'plugin'`. This is NOT a VS
 * Code extension (.vsix / Open VSX) — it is the chipos AI-capability bundle
 * format. Pure parsing here (no I/O) so it is independently unit-testable.
 */

/** Where a plugin manifest came from (for transparent Cursor import). */
export type PluginManifestSource = 'chipos' | 'cursor';

/** Manifest dir names probed under a plugin folder, in priority order. */
export const PLUGIN_MANIFEST_DIRS: ReadonlyArray<{ dir: string; file: string; source: PluginManifestSource }> = [
	{ dir: '.chipos-plugin', file: 'plugin.json', source: 'chipos' },
	{ dir: '.cursor-plugin', file: 'plugin.json', source: 'cursor' },
];

/**
 * A parsed plugin manifest. `id` is the install key (folder name under
 * `~/.chipos-ide/plugins/`); it defaults to `name`.
 */
export interface PluginManifest {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	readonly publisher?: string;
	/** Which manifest format this was parsed from (chipos | cursor). */
	readonly source: PluginManifestSource;
}

/** Thrown when a `plugin.json` is missing/!object/!required-fields. */
export class PluginManifestError extends Error { }

/**
 * Parse + validate a `plugin.json` body into a {@link PluginManifest}. Throws
 * {@link PluginManifestError} on invalid JSON or a missing required field
 * (`name`, `version`) — the install caller surfaces the message (BDD-002:
 * "manifest 不合法拒绝 + 显示 schema 错误"). The `cursor` source is accepted
 * transparently: a Cursor `.cursor-plugin/plugin.json` is read with the same
 * name/version contract and tagged `source: 'cursor'`.
 */
export function parsePluginManifest(jsonText: string, source: PluginManifestSource = 'chipos'): PluginManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch {
		throw new PluginManifestError('plugin.json is not valid JSON');
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new PluginManifestError('plugin.json must be a JSON object');
	}
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' ? obj.name.trim() : '';
	const version = typeof obj.version === 'string' ? obj.version.trim() : '';
	if (!name) {
		throw new PluginManifestError('plugin.json is missing the required "name" field');
	}
	if (!version) {
		throw new PluginManifestError('plugin.json is missing the required "version" field');
	}
	const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : name;
	return {
		id,
		name,
		version,
		description: typeof obj.description === 'string' ? obj.description : undefined,
		publisher: typeof obj.publisher === 'string' ? obj.publisher : undefined,
		source,
	};
}
