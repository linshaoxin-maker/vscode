/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { FileChangesEvent, IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Hard cap so a giant monorepo can never freeze the main thread on scan. */
const MAX_HDL_FILES = 2000;

/** Debounce window for re-scanning after a file-watch event. */
const RESCAN_DEBOUNCE_MS = 250;

const HDL_EXTENSIONS = ['.v', '.sv'];

// ── Data model ─────────────────────────────────────────────────────────────

/** A parsed module definition: where its `module <name>` line lives. */
export interface IModuleDefinition {
	readonly name: string;
	readonly uri: URI;
	/** 0-based line of the `module <name>` declaration. */
	readonly line: number;
	/** Display name of the source file (e.g. `core.sv`). */
	readonly fileName: string;
}

/** An instantiation edge: parent module instantiates `instanceName` of type `moduleType`. */
interface IInstantiation {
	readonly moduleType: string;
	readonly instanceName: string;
}

/**
 * A rendered hierarchy node. Roots are plain modules (label = module name);
 * children are instances (label = `instanceName : moduleType`). Each node
 * points at the *definition* of its module type so clicking opens the source.
 */
export interface IModuleHierarchyNode {
	/** Stable handle path, e.g. `soc_top/cpu:risc_core`. Unique per tree position. */
	readonly handle: string;
	/** Module type name (the defined module this node represents). */
	readonly moduleType: string;
	/** Instance name when this node is an instantiation, otherwise undefined (root). */
	readonly instanceName: string | undefined;
	/** Definition of `moduleType`, if it could be resolved. */
	readonly definition: IModuleDefinition | undefined;
	readonly children: IModuleHierarchyNode[];
}

export const IModuleHierarchyService = createDecorator<IModuleHierarchyService>('moduleHierarchyService');

export interface IModuleHierarchyService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the cached hierarchy changes (re-scan completed). */
	readonly onDidChangeHierarchy: Event<void>;

	/** Current root nodes (never partial — a full tree or empty). */
	getRoots(): readonly IModuleHierarchyNode[];

	/** True once a scan has produced no modules. */
	readonly isEmpty: boolean;

	/** Force a re-scan of all workspace `.v`/`.sv` files. */
	scanWorkspace(): Promise<void>;
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** `module <name>` declaration. group `name` is the module identifier. */
const MODULE_DECL_RE = /^\s*module\s+(?<name>[A-Za-z_$][\w$]*)/;

/** `endmodule` terminator. */
const ENDMODULE_RE = /^\s*endmodule\b/;

/**
 * Candidate instantiation: `<type> [#( ... )] <instance> (`.
 * group `type` = module type, group `inst` = instance name. The caller keeps a
 * match only when `type` is a known module name — that filters out port lists,
 * function calls and primitives.
 */
const INSTANTIATION_RE = /\b(?<type>[A-Za-z_$][\w$]*)\s*(?:#\s*\([^;]*?\)\s*)?(?<inst>[A-Za-z_$][\w$]*)\s*\(/g;

/** Verilog keywords that the instantiation regex would otherwise treat as a `type`. */
const HDL_KEYWORDS = new Set<string>([
	'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
	'parameter', 'localparam', 'assign', 'always', 'always_ff', 'always_comb',
	'always_latch', 'initial', 'begin', 'end', 'if', 'else', 'case', 'casex',
	'casez', 'endcase', 'for', 'while', 'function', 'endfunction', 'task',
	'endtask', 'generate', 'endgenerate', 'genvar', 'integer', 'real',
	'typedef', 'struct', 'enum', 'return', 'posedge', 'negedge',
]);

interface IParsedFile {
	readonly definitions: IModuleDefinition[];
	/** instantiation candidates keyed by the enclosing module name. */
	readonly instantiationsByModule: Map<string, IInstantiation[]>;
}

/**
 * Parse a single HDL file body into module definitions and (raw, unfiltered)
 * instantiation candidates grouped by enclosing module. Instantiation
 * candidates are filtered against the global known-module set later, once all
 * files have been parsed.
 */
export function parseHdlFile(uri: URI, content: string): IParsedFile {
	const fileName = uri.path.split('/').pop() ?? uri.path;
	const lines = content.split(/\r?\n/);
	const definitions: IModuleDefinition[] = [];
	const instantiationsByModule = new Map<string, IInstantiation[]>();

	let currentModule: string | undefined;
	let currentInsts: IInstantiation[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const decl = MODULE_DECL_RE.exec(line);
		if (decl?.groups?.name) {
			// Close any module that wasn't terminated by `endmodule` (defensive).
			if (currentModule && currentInsts.length) {
				instantiationsByModule.set(currentModule, currentInsts);
			}
			currentModule = decl.groups.name;
			currentInsts = [];
			definitions.push({ name: currentModule, uri, line: i, fileName });
			continue;
		}

		if (ENDMODULE_RE.test(line)) {
			if (currentModule) {
				instantiationsByModule.set(currentModule, currentInsts);
			}
			currentModule = undefined;
			currentInsts = [];
			continue;
		}

		if (!currentModule) {
			continue;
		}

		INSTANTIATION_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = INSTANTIATION_RE.exec(line)) !== null) {
			const type = match.groups?.type;
			const inst = match.groups?.inst;
			if (!type || !inst || HDL_KEYWORDS.has(type) || HDL_KEYWORDS.has(inst)) {
				continue;
			}
			currentInsts.push({ moduleType: type, instanceName: inst });
		}
	}

	if (currentModule && currentInsts.length) {
		instantiationsByModule.set(currentModule, currentInsts);
	}

	return { definitions, instantiationsByModule };
}

// ── Service ────────────────────────────────────────────────────────────────

export class ModuleHierarchyService extends Disposable implements IModuleHierarchyService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeHierarchy = this._register(new Emitter<void>());
	readonly onDidChangeHierarchy: Event<void> = this._onDidChangeHierarchy.event;

	private _roots: IModuleHierarchyNode[] = [];
	private _isEmpty = true;

	private readonly _rescanScheduler = this._register(new RunOnceScheduler(() => this.scanWorkspace(), RESCAN_DEBOUNCE_MS));

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Re-scan (debounced) when the workspace folders change. The workbench
		// already watches workspace roots recursively, so we observe HDL file
		// create/change/delete via the global file-change event and filter to
		// `.v`/`.sv` rather than installing our own recursive watcher (the
		// correlated `createWatcher` is non-recursive only).
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => this._rescanScheduler.schedule()));
		this._register(this._fileService.onDidFilesChange((e: FileChangesEvent) => {
			const touchesHdl = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted].some(uri => this._isHdlFile(uri));
			if (touchesHdl) {
				this._rescanScheduler.schedule();
			}
		}));
	}

	getRoots(): readonly IModuleHierarchyNode[] {
		return this._roots;
	}

	get isEmpty(): boolean {
		return this._isEmpty;
	}

	// ── Scanning ───────────────────────────────────────────────────────────

	async scanWorkspace(): Promise<void> {
		const folders = this._contextService.getWorkspace().folders;
		if (folders.length === 0) {
			this._setRoots([]);
			return;
		}

		try {
			const fileUris: URI[] = [];
			for (const folder of folders) {
				await this._collectHdlFiles(folder.uri, fileUris);
				if (fileUris.length > MAX_HDL_FILES) {
					this._logService.warn(`[ModuleHierarchy] Workspace has more than ${MAX_HDL_FILES} HDL files — skipping scan to protect the main thread.`);
					this._setRoots([]);
					return;
				}
			}

			const parsed = await this._parseFiles(fileUris);
			const roots = this._buildTree(parsed);
			this._setRoots(roots);
			this._logService.trace(`[ModuleHierarchy] Scan complete: ${fileUris.length} files, ${roots.length} root module(s).`);
		} catch (err) {
			this._logService.warn('[ModuleHierarchy] Scan failed:', err instanceof Error ? err.message : String(err));
			this._setRoots([]);
		}
	}

	private async _collectHdlFiles(folder: URI, out: URI[]): Promise<void> {
		let stat: IFileStat;
		try {
			stat = await this._fileService.resolve(folder, { resolveMetadata: false });
		} catch {
			return;
		}
		this._gatherFromStat(stat, out);
	}

	private _gatherFromStat(stat: IFileStat, out: URI[]): void {
		if (out.length > MAX_HDL_FILES) {
			return;
		}
		if (stat.isFile) {
			if (this._isHdlFile(stat.resource)) {
				out.push(stat.resource);
			}
			return;
		}
		if (stat.children) {
			for (const child of stat.children) {
				this._gatherFromStat(child, out);
			}
		}
	}

	private _isHdlFile(uri: URI): boolean {
		const lower = uri.path.toLowerCase();
		return HDL_EXTENSIONS.some(ext => lower.endsWith(ext));
	}

	private async _parseFiles(uris: URI[]): Promise<IParsedFile[]> {
		const results: IParsedFile[] = [];
		for (const uri of uris) {
			try {
				const content = (await this._fileService.readFile(uri)).value.toString();
				results.push(parseHdlFile(uri, content));
			} catch (err) {
				this._logService.trace('[ModuleHierarchy] Failed to read', uri.toString(), err instanceof Error ? err.message : String(err));
			}
		}
		return results;
	}

	/**
	 * Build the rendered hierarchy: nest instances under their enclosing
	 * module, flatten un-instantiated modules to roots. Cycle-guarded by a
	 * visited-on-path set so a module that recurses into itself or an ancestor
	 * stops instead of looping forever.
	 */
	private _buildTree(parsed: IParsedFile[]): IModuleHierarchyNode[] {
		const definitions = new Map<string, IModuleDefinition>();
		for (const file of parsed) {
			for (const def of file.definitions) {
				// First definition wins (mirrors goto-def "first match").
				if (!definitions.has(def.name)) {
					definitions.set(def.name, def);
				}
			}
		}

		const knownModules = new Set(definitions.keys());

		// Filter instantiation candidates against the known-module set and merge
		// per enclosing module across files.
		const childEdges = new Map<string, IInstantiation[]>();
		const instantiatedTypes = new Set<string>();
		for (const file of parsed) {
			for (const [parent, insts] of file.instantiationsByModule) {
				if (!knownModules.has(parent)) {
					continue;
				}
				const kept = insts.filter(i => knownModules.has(i.moduleType));
				if (kept.length === 0) {
					continue;
				}
				const bucket = childEdges.get(parent) ?? [];
				for (const inst of kept) {
					bucket.push(inst);
					instantiatedTypes.add(inst.moduleType);
				}
				childEdges.set(parent, bucket);
			}
		}

		// Roots = modules never instantiated anywhere. Stable, sorted by name.
		const rootNames = [...knownModules].filter(name => !instantiatedTypes.has(name)).sort((a, b) => a.localeCompare(b));

		const buildNode = (moduleType: string, instanceName: string | undefined, parentHandle: string, onPath: Set<string>): IModuleHierarchyNode => {
			const segment = instanceName ? `${instanceName}:${moduleType}` : moduleType;
			const handle = parentHandle ? `${parentHandle}/${segment}` : segment;
			const definition = definitions.get(moduleType);

			let children: IModuleHierarchyNode[] = [];
			if (!onPath.has(moduleType)) {
				const nextPath = new Set(onPath);
				nextPath.add(moduleType);
				const edges = childEdges.get(moduleType) ?? [];
				children = edges.map(edge => buildNode(edge.moduleType, edge.instanceName, handle, nextPath));
			}

			return { handle, moduleType, instanceName, definition, children };
		};

		return rootNames.map(name => buildNode(name, undefined, '', new Set<string>()));
	}

	private _setRoots(roots: IModuleHierarchyNode[]): void {
		this._roots = roots;
		this._isEmpty = roots.length === 0;
		this._onDidChangeHierarchy.fire();
	}
}
