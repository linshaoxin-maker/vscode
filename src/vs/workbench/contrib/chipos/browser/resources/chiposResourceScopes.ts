/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../services/path/common/pathService.js';

/**
 * Shared foundation for the workspace AI-resource planes (rules / commands /
 * skills / hooks): plane resolution, enable/disable state, scanning, and import.
 *
 * One module so the per-turn services (ChiposRulesService/…/ChiposHooksService)
 * and the settings tabs consume the SAME logic — scanning, the
 * `chipos.<kind>.disabled` state model, and copy-in all live here, so the four
 * resource types can't drift (a prior bug came from a tab mirroring another and
 * duplicating its leak). This is the chipos `.chipos/` convention — distinct
 * from VS Code extensions and from agent plugins (`~/.chipos-ide/plugins/`).
 */

export type ResourceKind = 'rules' | 'commands' | 'skills' | 'hooks';

/** Where a resource lives: the project workspace, or the user-global plane. */
export type ResourceScope = 'workspace' | 'user';

/**
 * On-disk shape of a resource kind. `flat` = files directly under the kind dir
 * matched by {@link fileRe}; `skill` = a sub-directory per resource each holding
 * a {@link markerFile}.
 */
export interface ResourceLayout {
	readonly kind: ResourceKind;
	readonly shape: 'flat' | 'skill';
	/** Match for `flat` files (also used to strip the extension for the id). */
	readonly fileRe?: RegExp;
	/** Required file inside each `skill` sub-directory (e.g. `SKILL.md`). */
	readonly markerFile?: string;
	/** Whether the identity name strips the file extension (rules/commands) or keeps it (hooks). */
	readonly stripExt: boolean;
}

export const RESOURCE_LAYOUTS: Readonly<Record<ResourceKind, ResourceLayout>> = {
	rules: { kind: 'rules', shape: 'flat', fileRe: /\.(mdc|md|txt)$/i, stripExt: true },
	commands: { kind: 'commands', shape: 'flat', fileRe: /\.(md|txt)$/i, stripExt: true },
	hooks: { kind: 'hooks', shape: 'flat', fileRe: /\.json$/i, stripExt: false },
	skills: { kind: 'skills', shape: 'skill', markerFile: 'SKILL.md', stripExt: false },
};

/**
 * Extra ecosystem sub-directories scanned for each kind, on top of the chipos
 * `.chipos/` / `~/.chipos-ide/` planes — so resources authored for Cursor or
 * Claude Code are picked up too (full-ecosystem compat). Each entry is a path
 * segment list resolved relative to a workspace folder OR the user home. These
 * planes always come AFTER the chipos plane so chipos keeps precedence under the
 * callers' first-wins dedupe. Same on-disk layout as {@link RESOURCE_LAYOUTS}:
 * Cursor `.mdc` rules share our frontmatter, command files are plain `.md`, and
 * Agent Skills are a `SKILL.md` per sub-directory. Hooks have no compatible
 * ecosystem form (Claude/Cursor encode them in `settings.json`), so none.
 */
export const ECOSYSTEM_RESOURCE_DIRS: Readonly<Record<ResourceKind, ReadonlyArray<readonly string[]>>> = {
	rules: [['.cursor', 'rules']],
	commands: [['.claude', 'commands'], ['.cursor', 'commands']],
	skills: [['.claude', 'skills']],
	hooks: [],
};

// --- Plane resolution ---------------------------------------------------------

/** `<folder>/.chipos/<kind>/` — the project (workspace) plane for a folder. */
export function workspaceResourceDir(folder: URI, kind: ResourceKind): URI {
	return URI.joinPath(folder, '.chipos', kind);
}

/** `~/.chipos-ide/<kind>/` — the user-global plane (available in all projects). */
export async function userGlobalResourceDir(pathService: IPathService, kind: ResourceKind): Promise<URI> {
	const home = await pathService.userHome();
	return URI.joinPath(home, '.chipos-ide', kind);
}

/** A directory to scan plus the scope its contents belong to. */
export interface ResourcePlane {
	readonly dir: URI;
	readonly scope: ResourceScope;
}

/**
 * The ordered planes to scan for `kind`. Per workspace folder: the chipos
 * `.chipos/<kind>` plane (scope `workspace`) followed by any ecosystem planes
 * from {@link ECOSYSTEM_RESOURCE_DIRS} (Cursor / Claude Code dirs, also scope
 * `workspace`); then the user-global `~/.chipos-ide/<kind>` plane (scope `user`)
 * followed by its ecosystem planes under the home dir (scope `user`).
 *
 * The order matters — callers dedupe by name with FIRST-wins, so all workspace
 * planes precede all user planes (project overrides user, matching Cursor) and,
 * within each scope, the chipos plane precedes the ecosystem planes so a chipos
 * resource always wins over a same-named Cursor/Claude one. A kind with no
 * ecosystem dirs (hooks) adds no extra planes; absent dirs are a no-op
 * ({@link scanResourcePlane} returns `[]`), so no config gate is needed.
 */
export async function resourcePlanes(pathService: IPathService, workspaceFolders: readonly URI[], kind: ResourceKind): Promise<ResourcePlane[]> {
	const ecosystem = ECOSYSTEM_RESOURCE_DIRS[kind];
	const planes: ResourcePlane[] = [];
	for (const folder of workspaceFolders) {
		planes.push({ dir: workspaceResourceDir(folder, kind), scope: 'workspace' });
		for (const segments of ecosystem) {
			planes.push({ dir: URI.joinPath(folder, ...segments), scope: 'workspace' });
		}
	}
	planes.push({ dir: await userGlobalResourceDir(pathService, kind), scope: 'user' });
	const home = await pathService.userHome();
	for (const segments of ecosystem) {
		planes.push({ dir: URI.joinPath(home, ...segments), scope: 'user' });
	}
	return planes;
}

// --- Enable/disable state (mirrors chipos.plugins.disabled, FEAT-002c) --------

/** Config key holding the disabled ids for a resource kind. */
export function disabledConfigKey(kind: ResourceKind): string {
	return `chipos.${kind}.disabled`;
}

/**
 * Stable, scope-qualified identity (`"<scope>:<name>"`) so the same name in two
 * scopes — e.g. a workspace and a user-global skill both called `deploy` —
 * toggles independently.
 */
export function resourceStateId(scope: ResourceScope, name: string): string {
	return `${scope}:${name}`;
}

export function getDisabledResourceIds(config: IConfigurationService, kind: ResourceKind): ReadonlySet<string> {
	const raw = config.getValue<string[]>(disabledConfigKey(kind));
	return new Set(Array.isArray(raw) ? raw : []);
}

/** Whether a resource currently contributes to the agent (not in the disabled set). */
export function isResourceEnabled(config: IConfigurationService, kind: ResourceKind, scope: ResourceScope, name: string): boolean {
	return !getDisabledResourceIds(config, kind).has(resourceStateId(scope, name));
}

/**
 * Enable/disable a resource by adding/removing its scope-qualified id from
 * `chipos.<kind>.disabled` (user scope). A disabled resource stays on disk but
 * the per-turn scan filters it out — no other wiring needed (mirrors
 * {@link ChiposPluginsService.setPluginEnabled}).
 */
export async function setResourceEnabled(config: IConfigurationService, kind: ResourceKind, scope: ResourceScope, name: string, enabled: boolean): Promise<void> {
	const next = new Set(getDisabledResourceIds(config, kind));
	const id = resourceStateId(scope, name);
	if (enabled) {
		next.delete(id);
	} else {
		next.add(id);
	}
	await config.updateValue(disabledConfigKey(kind), [...next], ConfigurationTarget.USER);
}

// --- Scanning (used by both the services and the tabs) ------------------------

/** One resource found on disk: its identity, scope, and the URIs to edit/delete. */
export interface ScannedResource {
	readonly name: string;
	readonly scope: ResourceScope;
	/** The dir (skill) or file (flat) — the delete target. */
	readonly entry: URI;
	/** `SKILL.md` (skill) or the file itself (flat) — the open-in-editor target. */
	readonly editFile: URI;
}

/**
 * List the resources in one plane directory. Pure structural scan (no body
 * parsing): a `flat` kind returns files matching `fileRe`; a `skill` kind
 * returns sub-directories that contain the marker file. A missing/unreadable
 * directory yields `[]` (never throws), so an absent plane is a no-op.
 */
export async function scanResourcePlane(fileService: IFileService, dir: URI, scope: ResourceScope, layout: ResourceLayout): Promise<ScannedResource[]> {
	let children;
	try {
		children = (await fileService.resolve(dir)).children;
	} catch {
		return [];
	}
	if (!children) {
		return [];
	}
	const out: ScannedResource[] = [];
	for (const child of children) {
		if (layout.shape === 'flat') {
			if (child.isDirectory || !layout.fileRe!.test(child.name)) {
				continue;
			}
			const name = layout.stripExt ? child.name.replace(layout.fileRe!, '') : child.name;
			out.push({ name, scope, entry: child.resource, editFile: child.resource });
		} else {
			if (!child.isDirectory) {
				continue;
			}
			const marker = URI.joinPath(child.resource, layout.markerFile!);
			if (!(await fileService.exists(marker))) {
				continue;
			}
			out.push({ name: child.name, scope, entry: child.resource, editFile: marker });
		}
	}
	return out;
}

// --- Import (local folder / git clone) ---------------------------------------

/**
 * Find the resource entries importable from an arbitrary tree (a picked folder
 * or a git clone). Looks at the tree root, at a `<kind>/` sub-directory, and —
 * for a `skill` kind — treats the root itself as a skill when it holds the
 * marker. Returns the source URIs to copy (a file for `flat`, a dir for `skill`).
 */
export async function findImportableResources(fileService: IFileService, root: URI, layout: ResourceLayout): Promise<URI[]> {
	const roots = [root, URI.joinPath(root, layout.kind)];
	if (layout.shape === 'skill') {
		roots.push(URI.joinPath(root, 'skills'));
	}
	const found = new Map<string, URI>(); // dedupe by fsPath
	if (layout.shape === 'skill' && await fileService.exists(URI.joinPath(root, layout.markerFile!))) {
		found.set(root.fsPath, root); // the picked folder IS a single skill
	}
	for (const dir of roots) {
		for (const r of await scanResourcePlane(fileService, dir, 'user', layout)) {
			found.set(r.entry.fsPath, r.entry);
		}
	}
	return [...found.values()];
}

/**
 * Copy one resource entry (a `flat` file or a `skill` folder) into `destDir`,
 * which is created if absent. Returns the resulting resource name. Throws on a
 * collision unless `overwrite` is set (`IFileService.copy` overwrite flag).
 */
export async function copyResourceEntry(fileService: IFileService, src: URI, layout: ResourceLayout, destDir: URI, overwrite: boolean): Promise<string> {
	await fileService.createFolder(destDir);
	const base = src.path.split('/').filter(Boolean).pop() ?? src.path;
	const target = URI.joinPath(destDir, base);
	await fileService.copy(src, target, overwrite);
	return layout.stripExt && layout.fileRe ? base.replace(layout.fileRe, '') : base;
}
