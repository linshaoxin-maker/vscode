/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent-plugin manifest parsing + local install (FEAT-002a). A chipos agent
 * plugin is a folder with a `.chipos-plugin/plugin.json` manifest plus
 * convention dirs (`rules/`, `commands/`, later `skills/`, `hooks/`) whose
 * resources are decomposed into the FEAT-001/003/004 collectors tagged
 * `source: 'plugin'`. This is NOT a VS Code extension (.vsix / Open VSX) — it
 * is the chipos AI-capability bundle format.
 *
 * {@link parsePluginManifest} is pure (no I/O). {@link readPluginManifest} and
 * {@link installLocalPlugin} take their {@link IFileService} + target root
 * explicitly (rather than via DI) so they stay unit-testable against an
 * in-memory file system; the native folder picker is wired separately in the
 * install command.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

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
	// The id becomes the install folder name (`<pluginsRoot>/<id>/`), so it must
	// be a single safe path segment — otherwise a hostile manifest (e.g.
	// `"id": "../../.."`) could escape the plugins root (path traversal).
	if (id.includes('/') || id.includes('\\') || id.includes('\0') || id === '.' || id === '..') {
		throw new PluginManifestError(`plugin.json id "${id}" is not a valid install folder name — it must not contain path separators, NUL, or "..".`);
	}
	return {
		id,
		name,
		version,
		description: typeof obj.description === 'string' ? obj.description : undefined,
		publisher: typeof obj.publisher === 'string' ? obj.publisher : undefined,
		source,
	};
}

/** Result of a successful local plugin install. */
export interface IPluginInstallResult {
	readonly manifest: PluginManifest;
	/** The install dir the plugin was copied to (`<pluginsRoot>/<id>/`). */
	readonly installedAt: URI;
}

/**
 * Locate, read and validate the manifest under a candidate plugin source dir.
 * Probes `.chipos-plugin/plugin.json` then `.cursor-plugin/plugin.json`
 * ({@link PLUGIN_MANIFEST_DIRS}, first match wins). Throws
 * {@link PluginManifestError} when no probe yields a readable manifest, or when
 * the first manifest found is malformed (missing `name`/`version`, bad JSON) —
 * a present-but-invalid manifest is rejected with its schema error rather than
 * silently falling through to the next probe.
 */
export async function readPluginManifest(fileService: IFileService, sourceDir: URI): Promise<PluginManifest> {
	for (const probe of PLUGIN_MANIFEST_DIRS) {
		const manifestUri = URI.joinPath(sourceDir, probe.dir, probe.file);
		let content: string;
		try {
			content = (await fileService.readFile(manifestUri)).value.toString();
		} catch {
			continue; // not this manifest format — try the next probe
		}
		// A readable manifest is authoritative: parse errors propagate (they are
		// PluginManifestError) so the caller surfaces the schema problem.
		return parsePluginManifest(content, probe.source);
	}
	throw new PluginManifestError('The selected folder has no .chipos-plugin/plugin.json (or .cursor-plugin/plugin.json) manifest');
}

/**
 * Install a local plugin folder into `<pluginsRoot>/<id>/`. Validates the
 * manifest first (rejecting with {@link PluginManifestError}), then copies the
 * whole source tree to the install dir keyed by the manifest id, overwriting an
 * existing install of the same id (a clean reinstall/update, not a merge). The
 * install root (`~/.chipos-ide/plugins/`) is passed in so this stays pure of
 * path-service DI and unit-testable.
 */
export async function installLocalPlugin(fileService: IFileService, sourceDir: URI, pluginsRoot: URI): Promise<IPluginInstallResult> {
	const manifest = await readPluginManifest(fileService, sourceDir);
	const installedAt = URI.joinPath(pluginsRoot, manifest.id);
	// overwrite=true: the file service deletes an existing target first (clean
	// replace) and no-ops when source === target (re-picking an installed dir).
	await fileService.copy(sourceDir, installedAt, true);
	return { manifest, installedAt };
}
