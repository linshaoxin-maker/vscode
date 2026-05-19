/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService, IMarkerData, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	AgentEvent,
	AgentEventType,
	type IFileEditPayload,
	type ILintReportPayload,
	type IToolResultPayload,
	type IWorktreeFilesAppliedPayload,
	type IDiffPreviewPayload,
	type ISkillTreePayload,
} from '../eventStream/eventTypes.js';
import { SkillTreeHandler, type ISkillTreeData, type ISkillDomain, type ISkillItem } from '../../browser/migration/skillTreeHandler.js';

export interface IFileChangeInfo {
	path: string;
	action: 'created' | 'modified';
	additions: number;
	deletions: number;
}

interface ISessionEditorEffectsState {
	readonly trackedFiles: Set<string>;
	readonly fileChanges: Map<string, IFileChangeInfo>;
	skillTreeData: ISkillTreeData;
}

const CHIPOS_MARKER_OWNER = 'chipos-lint';
const EMPTY_SKILL_TREE: ISkillTreeData = { domains: [] };

/**
 * Handles editor-side effects triggered by backend events.
 * Integrates lint diagnostics, auto-opens files, and tracks file changes.
 */
export class ChipOSEditorEffects extends Disposable {

	private readonly _sessionStates = new ResourceMap<ISessionEditorEffectsState>();
	private readonly _projectedSkillTreeHandler: SkillTreeHandler;
	private _activeSessionResource: URI | undefined;

	private readonly _onDidChangeFileChanges = this._register(new Emitter<IFileChangeInfo[]>());
	readonly onDidChangeFileChanges = this._onDidChangeFileChanges.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._projectedSkillTreeHandler = this._register(new SkillTreeHandler(this._logService));
	}

	get skillTreeHandler(): SkillTreeHandler { return this._projectedSkillTreeHandler; }
	get fileChanges(): IFileChangeInfo[] {
		const state = this._getActiveState();
		return state ? Array.from(state.fileChanges.values()) : [];
	}
	get fileChangeCount(): number {
		return this._getActiveState()?.fileChanges.size ?? 0;
	}

	setActiveSession(sessionResource: URI | undefined): void {
		if (sessionResource && this._activeSessionResource && isEqual(this._activeSessionResource, sessionResource)) {
			this._projectActiveState();
			return;
		}
		if (!sessionResource && !this._activeSessionResource) {
			this._projectActiveState();
			return;
		}
		this._activeSessionResource = sessionResource;
		this._projectActiveState();
	}

	clearSessionState(sessionResource: URI): void {
		this._sessionStates.delete(sessionResource);
		if (this._isActiveSession(sessionResource)) {
			this._activeSessionResource = undefined;
			this._projectActiveState();
		}
	}

	handleEvent(sessionResource: URI, event: AgentEvent): void {
		const state = this._getOrCreateSessionState(sessionResource);
		switch (event.event_type) {
			case AgentEventType.FileEdit:
				this._handleFileEdit(state, event.payload as IFileEditPayload);
				break;
			case AgentEventType.LintReport:
				this._handleLintDiagnostics(event.payload as ILintReportPayload);
				break;
			case AgentEventType.ToolResult:
				this._handleToolResult(sessionResource, state, event.payload as IToolResultPayload);
				break;
			case AgentEventType.WorktreeFilesApplied:
				this._handleWorktreeFilesApplied(sessionResource, state, event.payload as IWorktreeFilesAppliedPayload);
				break;
			case AgentEventType.DiffPreview:
				this._handleDiffPreview(state, event.payload as IDiffPreviewPayload);
				break;
			case AgentEventType.SkillTree:
				this._handleSkillTree(sessionResource, state, event.payload as ISkillTreePayload);
				break;
			case AgentEventType.TaskComplete:
				this._handleTaskComplete(sessionResource, state);
				break;
		}
	}

	// ── FileEdit → track file changes (inline diff now handled by framework IChatTextEdit) ──

	private _handleFileEdit(state: ISessionEditorEffectsState, payload: IFileEditPayload): void {
		this._logService.info(`[ChipOS Effects] FileEdit: ${payload.file_path}, ${payload.edits.length} edits`);
		state.trackedFiles.add(payload.file_path);
	}

	// ── SkillTree → SkillTreeHandler ────────────────────────────────────────

	private _handleSkillTree(sessionResource: URI, state: ISessionEditorEffectsState, payload: ISkillTreePayload): void {
		this._logService.info(`[ChipOS Effects] SkillTree: ${payload.total_skills} skills`);
		const data = this._convertSkillTreePayload(payload);
		state.skillTreeData = data;
		if (this._isActiveSession(sessionResource)) {
			this._projectedSkillTreeHandler.updateSkillTree(data);
		}
	}

	private _convertSkillTreePayload(payload: ISkillTreePayload): ISkillTreeData {
		const domains: ISkillDomain[] = (payload.children ?? []).map((child: unknown, idx: number) => {
			const c = child as Record<string, unknown>;
			const skills: ISkillItem[] = ((c.children ?? c.skills ?? []) as unknown[]).map((s: unknown, sIdx: number) => {
				const sk = s as Record<string, unknown>;
				return {
					id: (sk.id as string) ?? `skill_${idx}_${sIdx}`,
					name: (sk.name as string) ?? (sk.label as string) ?? `Skill ${sIdx}`,
					description: (sk.description as string) ?? '',
					triggerMode: ((sk.trigger_mode ?? sk.triggerMode ?? 'manual') as 'auto' | 'manual' | 'keyword' | 'always'),
					enabled: (sk.enabled as boolean) ?? true,
				};
			});
			return {
				id: (c.id as string) ?? `domain_${idx}`,
				label: (c.label as string) ?? (c.name as string) ?? `Domain ${idx}`,
				skills,
			};
		});
		return { domains };
	}

	// ── 1. Lint Diagnostics ─────────────────────────────────────────────────

	private _handleLintDiagnostics(payload: ILintReportPayload): void {
		const markersByFile = new Map<string, IMarkerData[]>();

		for (const error of payload.errors ?? []) {
			if (!markersByFile.has(error.file)) {
				markersByFile.set(error.file, []);
			}
			markersByFile.get(error.file)!.push({
				severity: error.severity === 'error' ? MarkerSeverity.Error :
					error.severity === 'warning' ? MarkerSeverity.Warning :
						MarkerSeverity.Info,
				message: error.message,
				startLineNumber: error.line,
				startColumn: error.col ?? 1,
				endLineNumber: error.line,
				endColumn: error.col ? error.col + 1 : 1000,
				source: payload.tool ?? 'ChipOS Lint',
				code: error.rule,
			});
		}

		for (const [file, markers] of markersByFile) {
			const uri = this._resolveFileUri(file);
			this._markerService.changeOne(CHIPOS_MARKER_OWNER, uri, markers);
		}

		this._logService.info(`[ChipOS Effects] Set lint diagnostics: ${payload.errors?.length ?? 0} issues across ${markersByFile.size} files`);
	}

	// ── 2. Auto-open files on tool_result with write ops ────────────────────

	private _handleToolResult(sessionResource: URI, state: ISessionEditorEffectsState, payload: IToolResultPayload): void {
		const writeTools = ['write_file', 'str_replace', 'edit_file', 'create_file', 'patch_file'];
		if (!writeTools.includes(payload.tool_name)) {
			return;
		}

		if (!payload.success) {
			return;
		}

		const result = payload.result;
		let filePath: string | undefined;

		if (typeof result === 'string') {
			const match = result.match(/(?:wrote|created|modified|updated)\s+['"`]?([^\s'"`]+)/i);
			filePath = match?.[1];
		} else if (typeof result === 'object' && result !== null) {
			filePath = (result as Record<string, unknown>).file_path as string | undefined
				?? (result as Record<string, unknown>).path as string | undefined;
		}

		if (filePath) {
			state.trackedFiles.add(filePath);
			this.trackFileChange(filePath, 'modified', sessionResource);
			this._autoOpenFile(filePath);
		}
	}

	private async _autoOpenFile(filePath: string): Promise<void> {
		try {
			const uri = this._resolveFileUri(filePath);
			await this._editorService.openEditor({ resource: uri });
			this._logService.info(`[ChipOS Effects] Auto-opened file: ${filePath}`);
		} catch (err) {
			this._logService.warn(`[ChipOS Effects] Failed to auto-open: ${filePath}`, String(err));
		}
	}

	// ── 3. Diff preview → open Diff editor (FEAT-36) ───────────────────────

	private _handleDiffPreview(state: ISessionEditorEffectsState, payload: IDiffPreviewPayload): void {
		if (payload.file_path) {
			state.trackedFiles.add(payload.file_path);
			this._openDiffEditor(payload).catch(err => {
				this._logService.warn('[ChipOS Effects] DiffPreview open failed:', String(err));
			});
		}
	}

	private async _openDiffEditor(payload: IDiffPreviewPayload): Promise<void> {
		const modifiedUri = this._resolveFileUri(payload.file_path);
		const originalUri = modifiedUri.with({ scheme: 'chipos-diff', query: `original-${Date.now()}` });

		try {
			await this._editorService.openEditor({
				original: { resource: originalUri },
				modified: { resource: modifiedUri },
				label: `${payload.file_path} (Diff Preview)`,
				options: { pinned: false, preserveFocus: true },
			});
			this._logService.info(`[ChipOS Effects] Opened diff editor: ${payload.file_path}`);
		} catch {
			await this._editorService.openEditor({ resource: modifiedUri });
		}
	}

	// ── 4. Worktree files applied → track and open ──────────────────────────

	private _handleWorktreeFilesApplied(sessionResource: URI, state: ISessionEditorEffectsState, payload: IWorktreeFilesAppliedPayload): void {
		for (const f of payload.files ?? []) {
			state.trackedFiles.add(f.path);
			if (f.action !== 'deleted') {
				this.trackFileChange(f.path, f.action === 'added' ? 'created' : 'modified', sessionResource);
				this._autoOpenFile(f.path);
			}
		}
		this._refreshGitDiffStats(sessionResource, state);
	}

	// ── 5. Task complete → refresh git stats (FEAT-38), log summary ────────

	private _handleTaskComplete(sessionResource: URI, state: ISessionEditorEffectsState): void {
		this._logService.info(`[ChipOS Effects] Task complete. Tracked ${state.trackedFiles.size} files.`);
		this._refreshGitDiffStats(sessionResource, state);
		state.trackedFiles.clear();
	}

	// ── FEAT-37: File change commands ────────────────────────────────────────

	trackFileChange(filePath: string, action: 'created' | 'modified', sessionResource?: URI): void {
		const resolved = this._resolveSessionState(sessionResource, true);
		if (!resolved) {
			return;
		}
		const { sessionResource: targetSessionResource, state } = resolved;
		const existing = state.fileChanges.get(filePath);
		if (!existing) {
			state.fileChanges.set(filePath, { path: filePath, action, additions: 0, deletions: 0 });
		}
		this._syncProjectionIfActive(targetSessionResource);
	}

	clearFileChanges(sessionResource?: URI): void {
		const resolved = this._resolveSessionState(sessionResource, false);
		if (!resolved) {
			return;
		}
		resolved.state.fileChanges.clear();
		this._syncProjectionIfActive(resolved.sessionResource);
	}

	async undoAllFileChanges(sessionResource?: URI): Promise<{ reverted: number; errors: string[] }> {
		const resolved = this._resolveSessionState(sessionResource, false);
		if (!resolved) {
			return { reverted: 0, errors: [] };
		}

		const files = Array.from(resolved.state.fileChanges.values());
		if (!files.length) {
			return { reverted: 0, errors: [] };
		}

		const workspacePath = this._getWorkspacePath();
		if (!workspacePath) {
			return { reverted: 0, errors: ['No workspace folder found'] };
		}

		const errors: string[] = [];
		const modified = files.filter(f => f.action === 'modified').map(f => f.path);

		if (modified.length) {
			try {
				const cp: typeof import('child_process') = require('child_process');
				await new Promise<void>((resolve, reject) => {
					cp.exec(`git checkout HEAD -- ${modified.map(p => `"${p}"`).join(' ')}`, { cwd: workspacePath }, (err) => {
						if (err) { reject(err); } else { resolve(); }
					});
				});
			} catch (err) {
				errors.push(`git checkout failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		resolved.state.fileChanges.clear();
		this._syncProjectionIfActive(resolved.sessionResource);
		return { reverted: files.length - errors.length, errors };
	}

	async openGitDiff(filePath: string): Promise<void> {
		const modifiedUri = this._resolveFileUri(filePath);
		const headUri = modifiedUri.with({ scheme: 'git', query: JSON.stringify({ path: filePath, ref: 'HEAD' }) });
		const baseName = filePath.split('/').pop() || filePath;
		try {
			await this._editorService.openEditor({
				original: { resource: headUri },
				modified: { resource: modifiedUri },
				label: `${baseName} (HEAD vs Working)`,
			});
		} catch {
			await this._editorService.openEditor({ resource: modifiedUri });
		}
	}

	// ── FEAT-38: Git diff stats refresh ─────────────────────────────────────

	private _refreshGitDiffStats(sessionResource: URI, state: ISessionEditorEffectsState): void {
		const workspacePath = this._getWorkspacePath();
		if (!workspacePath || !state.fileChanges.size) {
			return;
		}

		try {
			const cp: typeof import('child_process') = require('child_process');
			cp.exec('git diff --numstat HEAD', { cwd: workspacePath, timeout: 5000 }, (err, stdout) => {
				const numstatEmpty = !stdout || !stdout.trim();
				if (err || numstatEmpty) {
					// Workspace isn't a git repo, or no tracked changes (the
					// case for net-new untracked files like sim/report_*.txt).
					// Without a fallback, additions/deletions stay at 0/0 and
					// the working-set widget shows the misleading "+0 -0"
					// label even though the files have real content.
					this._applyFilesystemFallbackStats(sessionResource, state);
					return;
				}
				let updated = false;
				const seenPaths = new Set<string>();
				for (const line of stdout.trim().split('\n')) {
					const parts = line.split('\t');
					if (parts.length < 3) { continue; }
					const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
					const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
					const path = parts[2];
					seenPaths.add(path);
					const existing = state.fileChanges.get(path);
					if (existing && (existing.additions !== additions || existing.deletions !== deletions)) {
						existing.additions = additions;
						existing.deletions = deletions;
						updated = true;
					}
				}
				if (updated) {
					this._syncProjectionIfActive(sessionResource);
				}
				// numstat doesn't report untracked / unindexed files even when
				// the workspace IS a git repo. Anything still at 0/0 after
				// the numstat pass needs the filesystem fallback to avoid
				// the same "+0 -0" rendering bug.
				const missing: string[] = [];
				for (const [p, info] of state.fileChanges) {
					if (!seenPaths.has(p) && info.additions === 0 && info.deletions === 0) {
						missing.push(p);
					}
				}
				if (missing.length > 0) {
					this._applyFilesystemFallbackStats(sessionResource, state, missing);
				}
			});
		} catch {
			// require('child_process') not available in browser context — try
			// the filesystem fallback directly so we still produce real line
			// counts in restricted environments.
			this._applyFilesystemFallbackStats(sessionResource, state);
		}
	}

	/**
	 * Fallback line counter used when `git diff --numstat HEAD` can't tell us
	 * how many lines a tracked file gained/lost. Reads each file's current
	 * content and treats every line as an addition.
	 *
	 * This is lossy on modified files (we don't have the prior baseline, so
	 * the deletions column stays at 0 and additions reflect the new total),
	 * but it's still far more useful than the "+0 -0" sentinel the widget
	 * shows otherwise. For brand-new files (the common worker-write case
	 * like sim/report_*.txt) the count is accurate.
	 */
	private _applyFilesystemFallbackStats(
		sessionResource: URI,
		state: ISessionEditorEffectsState,
		onlyPaths?: readonly string[],
	): void {
		let fs: typeof import('fs');
		try {
			fs = require('fs');
		} catch {
			return;
		}

		const targets = onlyPaths
			? onlyPaths.map(p => state.fileChanges.get(p)).filter((e): e is IFileChangeInfo => !!e)
			: Array.from(state.fileChanges.values());

		let updated = false;
		for (const entry of targets) {
			if (entry.additions !== 0 || entry.deletions !== 0) {
				continue;
			}
			const absPath = this._resolveFileUri(entry.path).fsPath;
			try {
				const stat = fs.statSync(absPath);
				if (!stat.isFile()) {
					continue;
				}
				const content = fs.readFileSync(absPath, 'utf8');
				if (!content.length) {
					continue;
				}
				const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
				const lines = trimmed.length === 0 ? 0 : trimmed.split('\n').length;
				if (lines !== entry.additions) {
					entry.additions = lines;
					updated = true;
				}
			} catch {
				// File may have been removed or be unreadable; leave entry alone.
			}
		}
		if (updated) {
			this._syncProjectionIfActive(sessionResource);
		}
	}

	private _projectActiveState(): void {
		const activeState = this._getActiveState();
		this._projectedSkillTreeHandler.updateSkillTree(activeState?.skillTreeData ?? EMPTY_SKILL_TREE);
		this._fireFileChanges();
	}

	private _syncProjectionIfActive(sessionResource: URI): void {
		if (this._isActiveSession(sessionResource)) {
			this._projectActiveState();
		}
	}

	private _getOrCreateSessionState(sessionResource: URI): ISessionEditorEffectsState {
		let state = this._sessionStates.get(sessionResource);
		if (!state) {
			state = {
				trackedFiles: new Set<string>(),
				fileChanges: new Map<string, IFileChangeInfo>(),
				skillTreeData: EMPTY_SKILL_TREE,
			};
			this._sessionStates.set(sessionResource, state);
		}
		return state;
	}

	private _resolveSessionState(sessionResource: URI | undefined, createIfMissing: boolean): { sessionResource: URI; state: ISessionEditorEffectsState } | undefined {
		const targetSessionResource = sessionResource ?? this._activeSessionResource;
		if (!targetSessionResource) {
			return undefined;
		}
		const state = createIfMissing
			? this._getOrCreateSessionState(targetSessionResource)
			: this._sessionStates.get(targetSessionResource);
		if (!state) {
			return undefined;
		}
		return { sessionResource: targetSessionResource, state };
	}

	private _getActiveState(): ISessionEditorEffectsState | undefined {
		if (!this._activeSessionResource) {
			return undefined;
		}
		return this._sessionStates.get(this._activeSessionResource);
	}

	private _isActiveSession(sessionResource: URI): boolean {
		return !!this._activeSessionResource && isEqual(this._activeSessionResource, sessionResource);
	}

	private _fireFileChanges(): void {
		this._onDidChangeFileChanges.fire(this.fileChanges);
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private _resolveFileUri(filePath: string): URI {
		if (filePath.startsWith('/')) {
			return URI.file(filePath);
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return URI.joinPath(folders[0].uri, filePath);
		}
		return URI.file(filePath);
	}

	private _getWorkspacePath(): string | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : undefined;
	}

	clearDiagnostics(): void {
		this._markerService.remove(CHIPOS_MARKER_OWNER, []);
	}
}
