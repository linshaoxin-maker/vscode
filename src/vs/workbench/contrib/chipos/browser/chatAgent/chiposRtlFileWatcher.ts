/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { URI } from '../../../../../base/common/uri.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Event } from '../../../../../base/common/event.js';

/**
 * FEAT-X.3.2 — auto-open RTL files when the agent (or any external
 * actor) creates them on disk.
 *
 * The chipos-ide chatAgent's `editorEffects.ts` already auto-opens
 * files emitted via WorkbenchEvent.ToolResult / WorktreeFilesApplied,
 * but that path only fires when the backend send a structured event.
 * If the agent shells out (`exec verilog_template -o foo.v`) or the
 * user's external generator drops a file in the workspace, no event
 * is emitted and the new file sits invisible in the explorer until
 * the user clicks it.
 *
 * This watcher mirrors `vscode-extension/src/editor/fileWatcher.ts` —
 * a single global FileSystemWatcher scoped to the active workspace,
 * filtered to HDL extensions, that pops a preview tab when a new
 * file appears.
 *
 * Off by default — users who don't want noisy pane churn can leave
 * `chipos.editor.autoOpenRtlOnCreate` at false. EDA-focused
 * deployments can ship with true via product.json overrides.
 */

const SETTING_KEY = 'chipos.editor.autoOpenRtlOnCreate';

// Verilog / SystemVerilog / header variants. Keep the set tight on
// purpose — adding e.g. `.py` would flood the editor with generated
// helper scripts that are usually noise.
const RTL_EXTENSIONS = new Set(['.v', '.sv', '.svh', '.vh']);

export class ChipOSRtlFileWatcher extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.editor.rtlFileWatcher';

	private readonly _watching = this._register(new DisposableStore());
	private _enabled = false;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._refreshFromConfig();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_KEY)) {
				this._refreshFromConfig();
			}
		}));
		// Re-attach watcher if the workspace folder list changes (open folder,
		// add folder to workspace), since file-system watch scopes follow the
		// workspace.
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			if (this._enabled) {
				this._disable();
				this._enable();
			}
		}));
	}

	private _refreshFromConfig(): void {
		const requested = this._configurationService.getValue<boolean>(SETTING_KEY) === true;
		if (requested && !this._enabled) {
			this._enable();
		} else if (!requested && this._enabled) {
			this._disable();
		}
	}

	private _enable(): void {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return; // nothing to watch
		}
		for (const folder of folders) {
			// Recursive watch; the listener filters by extension. We can't
			// use a `**/*.{v,sv,svh,vh}` GlobPattern here because IFileService
			// watchers take a URI, not a glob — extension filtering happens
			// in the change handler.
			this._watching.add(this._fileService.watch(folder.uri, { recursive: true, excludes: ['**/node_modules/**', '**/.git/**'] }));
		}
		this._watching.add(Event.filter(this._fileService.onDidFilesChange, e => e.gotAdded())(e => {
			for (const resource of e.rawAdded) {
				if (!this._isRtlFile(resource)) { continue; }
				this._openFile(resource);
			}
		}));
		this._enabled = true;
		this._logService.debug('[ChipOS RtlFileWatcher] enabled, watching', folders.length, 'folder(s)');
	}

	private _disable(): void {
		this._watching.clear();
		this._enabled = false;
		this._logService.debug('[ChipOS RtlFileWatcher] disabled');
	}

	private _isRtlFile(resource: URI): boolean {
		const path = resource.path.toLowerCase();
		const lastDot = path.lastIndexOf('.');
		if (lastDot < 0) { return false; }
		return RTL_EXTENSIONS.has(path.slice(lastDot));
	}

	private _openFile(resource: URI): void {
		this._editorService.openEditor({
			resource,
			options: { pinned: false, preserveFocus: true },
		}).catch(err => {
			// File may have been deleted between watcher firing and our
			// open — silently swallow, not a user-visible failure.
			this._logService.debug('[ChipOS RtlFileWatcher] openEditor failed for', resource.toString(), err);
		});
	}
}

registerWorkbenchContribution2(ChipOSRtlFileWatcher.ID, ChipOSRtlFileWatcher, WorkbenchPhase.AfterRestored);
