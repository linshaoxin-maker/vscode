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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChiposGitService } from '../../common/chiposGitService.js';
import {
	AgentEvent,
	AgentEventType,
	type ILintReportPayload,
	type IToolResultPayload,
	type IWorktreeFilesAppliedPayload,
	type IDiffPreviewPayload,
	type ISkillTreePayload,
} from '../eventTypes.js';
import { SkillTreeHandler, type ISkillTreeData, type ISkillDomain, type ISkillItem } from '../../browser/migration/skillTreeHandler.js';

/**
 * Git/file effects below run git in the MAIN process via {@link IChiposGitService}
 * and read files via {@link IFileService}. They previously shelled out through a
 * bare `require('child_process')` / `require('fs')`, which silently no-op'd in a
 * PACKAGED app (the sandboxed renderer has no global `require`) — so the working-set
 * widget showed "+0 -0" and undo-all did nothing in shipped builds. The git service
 * is resolved optionally; when absent (web), diff stats fall back to IFileService
 * line counts and undo-all reports git as unavailable.
 */

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

	/** Main-process git runner; undefined on web, where git ops degrade. */
	private readonly _gitService: IChiposGitService | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._projectedSkillTreeHandler = this._register(new SkillTreeHandler(this._logService));
		try {
			this._gitService = instantiationService?.invokeFunction(acc => acc.get(IChiposGitService));
		} catch {
			// not registered (e.g. web) — git ops degrade to the filesystem fallback
		}
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

	// ── SkillTree → SkillTreeHandler ────────────────────────────────────────

	private _handleSkillTree(sessionResource: URI, state: ISessionEditorEffectsState, payload: ISkillTreePayload): void {
		this._logService.info(`[ChipOS Effects] SkillTree: ${payload.total_skills} skills`);
		const data = this._convertSkillTreePayload(payload);
		state.skillTreeData = data;
		if (this._isActiveSession(sessionResource)) {
			this._projectedSkillTreeHandler.updateSkillTree(data);
		}
	}

	/**
	 * Flatten the reasoner's nested category tree (``children`` of ``children``
	 * … each leaf category carrying ``skills``) into the IDE's two-level
	 * domain→skill model. Every category that directly holds skills becomes one
	 * domain labelled by its full path (``"logic_design / counter"``); the leaf
	 * skills render by name underneath. This recurses to arbitrary depth so a
	 * skill at ``logic_design/counter`` (a 2-level path) is shown by name rather
	 * than the old shallow map's bug — which treated the ``counter`` *category*
	 * as a fake skill leaf and never reached the real skill. Matches the
	 * skills the vscode-extension's (recursive) ``SkillTreeProvider`` shows,
	 * just presented one level flatter to fit the existing IDE tree model.
	 */
	private _convertSkillTreePayload(payload: ISkillTreePayload): ISkillTreeData {
		const domains: ISkillDomain[] = [];
		const walk = (node: Record<string, unknown>, pathLabels: string[]): void => {
			const label = (node.label as string) ?? (node.name as string) ?? (node.id as string) ?? '';
			const here = label ? [...pathLabels, label] : pathLabels;
			const rawSkills = (node.skills ?? []) as unknown[];
			if (rawSkills.length > 0) {
				const skills: ISkillItem[] = rawSkills.map((s: unknown, sIdx: number) => {
					const sk = s as Record<string, unknown>;
					// Reasoner skill entries are ``{ skill_id, description, status,
					// confidence }`` (skill_tree_manager.add_skill) — there is no
					// name/label/id/trigger field. Show the rule summary
					// (``description``) as the primary label, exactly like the
					// vscode-extension's SkillTreeProvider, with the skill id as the
					// secondary line. ``enabled`` is derived from status so a retired
					// skill renders with the ○ marker. ``trigger_mode``/``triggerMode``
					// are still honoured if a future payload supplies them.
					const skillId = (sk.skill_id as string) ?? (sk.id as string) ?? `skill_${here.join('_')}_${sIdx}`;
					const summary = (sk.description as string) ?? (sk.name as string) ?? (sk.label as string) ?? skillId;
					const status = (sk.status as string) ?? '';
					return {
						id: skillId,
						name: summary,
						description: skillId,
						triggerMode: ((sk.trigger_mode ?? sk.triggerMode ?? 'auto') as 'auto' | 'manual' | 'keyword' | 'always'),
						enabled: typeof sk.enabled === 'boolean' ? (sk.enabled as boolean) : status !== 'retired',
					};
				});
				domains.push({
					id: (node.id as string) ?? here.join('/'),
					label: here.join(' / ') || label,
					skills,
				});
			}
			for (const child of (node.children ?? []) as unknown[]) {
				walk(child as Record<string, unknown>, here);
			}
		};
		for (const top of (payload.children ?? []) as unknown[]) {
			walk(top as Record<string, unknown>, []);
		}
		return { domains };
	}

	/**
	 * FEAT-DS-006: feed a server-fetched skill tree (GET /api/v1/skill-tree)
	 * straight into the projected handler. The stateless path emits no SSE
	 * ``skill_tree`` event, so the IDE pulls the store on demand
	 * (see {@link ChipOSChatAgent.refreshSkillTree}) and hands the raw payload
	 * here. Unlike {@link _handleSkillTree} this is session-independent — the
	 * dynamic-skill store is global, not per-conversation — so it always updates
	 * the handler with no active-session gate.
	 */
	applySkillTreePayload(payload: ISkillTreePayload): void {
		const data = this._convertSkillTreePayload(payload);
		this._logService.info(`[ChipOS Effects] SkillTree (pull): ${data.domains.length} domains, ${payload.total_skills ?? '?'} skills`);
		this._projectedSkillTreeHandler.updateSkillTree(data);
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
		void this._refreshGitDiffStats(sessionResource, state).catch(err => this._logService.warn('[ChipOS Effects] git diff stats refresh failed:', String(err)));
	}

	// ── 5. Task complete → refresh git stats (FEAT-38), log summary ────────

	private _handleTaskComplete(sessionResource: URI, state: ISessionEditorEffectsState): void {
		this._logService.info(`[ChipOS Effects] Task complete. Tracked ${state.trackedFiles.size} files.`);
		void this._refreshGitDiffStats(sessionResource, state).catch(err => this._logService.warn('[ChipOS Effects] git diff stats refresh failed:', String(err)));
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
				if (!this._gitService) {
					throw new Error('Node git is not available in this environment.');
				}
				// execFile argv (no shell) — the `--` terminator + per-path args
				// mean a path with spaces or shell metacharacters cannot break out.
				const res = await this._gitService.exec({ args: ['checkout', 'HEAD', '--', ...modified], cwd: workspacePath });
				if (!res.ok) {
					throw new Error((res.stderr || '').trim() || `git checkout exited with code ${res.code}`);
				}
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

	private async _refreshGitDiffStats(sessionResource: URI, state: ISessionEditorEffectsState): Promise<void> {
		const workspacePath = this._getWorkspacePath();
		if (!workspacePath || !state.fileChanges.size) {
			return;
		}

		if (!this._gitService) {
			// No main-process git runner (web) — use the filesystem fallback
			// directly so we still produce real line counts.
			await this._applyFilesystemFallbackStats(sessionResource, state);
			return;
		}

		let stdout: string;
		try {
			const res = await this._gitService.exec({ args: ['diff', '--numstat', 'HEAD'], cwd: workspacePath, timeoutMs: 5000 });
			if (!res.ok || !res.stdout.trim()) {
				// Workspace isn't a git repo, or no tracked changes (the case for
				// net-new untracked files like sim/report_*.txt). Without a
				// fallback, additions/deletions stay at 0/0 and the working-set
				// widget shows the misleading "+0 -0" label even though the files
				// have real content.
				await this._applyFilesystemFallbackStats(sessionResource, state);
				return;
			}
			stdout = res.stdout;
		} catch {
			// Defensive: if the git call rejects, fall back to the filesystem line
			// counter so we still avoid the "+0 -0" sentinel.
			await this._applyFilesystemFallbackStats(sessionResource, state);
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
		// numstat doesn't report untracked / unindexed files even when the
		// workspace IS a git repo. Anything still at 0/0 after the numstat pass
		// needs the filesystem fallback to avoid the same "+0 -0" rendering bug.
		const missing: string[] = [];
		for (const [p, info] of state.fileChanges) {
			if (!seenPaths.has(p) && info.additions === 0 && info.deletions === 0) {
				missing.push(p);
			}
		}
		if (missing.length > 0) {
			await this._applyFilesystemFallbackStats(sessionResource, state, missing);
		}
	}

	/**
	 * Fallback line counter used when `git diff --numstat HEAD` can't tell us
	 * how many lines a tracked file gained/lost. Reads each file's current
	 * content (via IFileService — renderer-safe in the packaged app, unlike the
	 * old `require('fs')`) and treats every line as an addition.
	 *
	 * This is lossy on modified files (we don't have the prior baseline, so
	 * the deletions column stays at 0 and additions reflect the new total),
	 * but it's still far more useful than the "+0 -0" sentinel the widget
	 * shows otherwise. For brand-new files (the common worker-write case
	 * like sim/report_*.txt) the count is accurate.
	 */
	private async _applyFilesystemFallbackStats(
		sessionResource: URI,
		state: ISessionEditorEffectsState,
		onlyPaths?: readonly string[],
	): Promise<void> {
		const targets = onlyPaths
			? onlyPaths.map(p => state.fileChanges.get(p)).filter((e): e is IFileChangeInfo => !!e)
			: Array.from(state.fileChanges.values());

		let updated = false;
		for (const entry of targets) {
			if (entry.additions !== 0 || entry.deletions !== 0) {
				continue;
			}
			const uri = this._resolveFileUri(entry.path);
			try {
				// readFile throws for a directory / missing / unreadable path,
				// which the catch swallows (leaving the entry untouched).
				const content = (await this._fileService.readFile(uri)).value.toString();
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
