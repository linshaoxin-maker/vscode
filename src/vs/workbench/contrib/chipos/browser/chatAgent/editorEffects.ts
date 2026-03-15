/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
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
import { InlineDiffController } from '../inlineDiff/inlineDiffController.js';
import { SkillTreeHandler, type ISkillTreeData, type ISkillDomain, type ISkillItem } from '../../browser/migration/skillTreeHandler.js';

import '../inlineDiff/inlineDiff.css';

export interface IFileChangeInfo {
	path: string;
	action: 'created' | 'modified';
	additions: number;
	deletions: number;
}

const CHIPOS_MARKER_OWNER = 'chipos-lint';

/**
 * Handles editor-side effects triggered by backend events.
 * Integrates lint diagnostics, auto-opens files, and tracks file changes.
 */
export class ChipOSEditorEffects extends Disposable {

	private readonly _trackedFiles = new Set<string>();
	private readonly _fileChanges = new Map<string, IFileChangeInfo>();
	private readonly _inlineDiffController: InlineDiffController;
	private readonly _skillTreeHandler: SkillTreeHandler;

	private readonly _onDidChangeFileChanges = this._register(new Emitter<IFileChangeInfo[]>());
	readonly onDidChangeFileChanges = this._onDidChangeFileChanges.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._inlineDiffController = this._register(new InlineDiffController(this._editorService, null));
		this._skillTreeHandler = this._register(new SkillTreeHandler(this._logService));
	}

	get inlineDiffController(): InlineDiffController { return this._inlineDiffController; }
	get skillTreeHandler(): SkillTreeHandler { return this._skillTreeHandler; }
	get fileChanges(): IFileChangeInfo[] { return Array.from(this._fileChanges.values()); }
	get fileChangeCount(): number { return this._fileChanges.size; }

	handleEvent(event: AgentEvent): void {
		switch (event.event_type) {
			case AgentEventType.FileEdit:
				this._handleFileEdit(event.payload as IFileEditPayload);
				break;
			case AgentEventType.LintReport:
				this._handleLintDiagnostics(event.payload as ILintReportPayload);
				break;
			case AgentEventType.ToolResult:
				this._handleToolResult(event.payload as IToolResultPayload);
				break;
			case AgentEventType.WorktreeFilesApplied:
				this._handleWorktreeFilesApplied(event.payload as IWorktreeFilesAppliedPayload);
				break;
			case AgentEventType.DiffPreview:
				this._handleDiffPreview(event.payload as IDiffPreviewPayload);
				break;
			case AgentEventType.SkillTree:
				this._handleSkillTree(event.payload as ISkillTreePayload);
				break;
			case AgentEventType.TaskComplete:
				this._handleTaskComplete();
				break;
		}
	}

	// ── FileEdit → InlineDiffController ─────────────────────────────────────

	private _handleFileEdit(payload: IFileEditPayload): void {
		this._logService.info(`[ChipOS Effects] FileEdit: ${payload.file_path}, ${payload.edits.length} edits`);
		this._trackedFiles.add(payload.file_path);
		this._inlineDiffController.handleFileEdit(payload).catch(err => {
			this._logService.warn('[ChipOS Effects] InlineDiff failed:', String(err));
		});
	}

	// ── SkillTree → SkillTreeHandler ────────────────────────────────────────

	private _handleSkillTree(payload: ISkillTreePayload): void {
		this._logService.info(`[ChipOS Effects] SkillTree: ${payload.total_skills} skills`);
		const data = this._convertSkillTreePayload(payload);
		this._skillTreeHandler.updateSkillTree(data);
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

	private _handleToolResult(payload: IToolResultPayload): void {
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
			this._trackedFiles.add(filePath);
			this.trackFileChange(filePath, 'modified');
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

	private _handleDiffPreview(payload: IDiffPreviewPayload): void {
		if (payload.file_path) {
			this._trackedFiles.add(payload.file_path);
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

	private _handleWorktreeFilesApplied(payload: IWorktreeFilesAppliedPayload): void {
		for (const f of payload.files ?? []) {
			this._trackedFiles.add(f.path);
			if (f.action !== 'deleted') {
				this.trackFileChange(f.path, f.action === 'added' ? 'created' : 'modified');
				this._autoOpenFile(f.path);
			}
		}
		this._refreshGitDiffStats();
	}

	// ── 5. Task complete → refresh git stats (FEAT-38), log summary ────────

	private _handleTaskComplete(): void {
		this._logService.info(`[ChipOS Effects] Task complete. Tracked ${this._trackedFiles.size} files.`);
		this._refreshGitDiffStats();
		this._trackedFiles.clear();
	}

	// ── FEAT-37: File change commands ────────────────────────────────────────

	trackFileChange(filePath: string, action: 'created' | 'modified'): void {
		const existing = this._fileChanges.get(filePath);
		if (!existing) {
			this._fileChanges.set(filePath, { path: filePath, action, additions: 0, deletions: 0 });
		}
		this._fireFileChanges();
	}

	clearFileChanges(): void {
		this._fileChanges.clear();
		this._fireFileChanges();
	}

	async undoAllFileChanges(): Promise<{ reverted: number; errors: string[] }> {
		const files = Array.from(this._fileChanges.values());
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
				const { exec } = await import('child_process');
				await new Promise<void>((resolve, reject) => {
					exec(`git checkout HEAD -- ${modified.map(p => `"${p}"`).join(' ')}`, { cwd: workspacePath }, (err) => {
						if (err) { reject(err); } else { resolve(); }
					});
				});
			} catch (err) {
				errors.push(`git checkout failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		this._fileChanges.clear();
		this._fireFileChanges();
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

	private _refreshGitDiffStats(): void {
		const workspacePath = this._getWorkspacePath();
		if (!workspacePath || !this._fileChanges.size) {
			return;
		}

		import('child_process').then(({ exec }) => {
			exec('git diff --numstat HEAD', { cwd: workspacePath, timeout: 5000 }, (err, stdout) => {
				if (err || !stdout.trim()) { return; }
				let updated = false;
				for (const line of stdout.trim().split('\n')) {
					const parts = line.split('\t');
					if (parts.length < 3) { continue; }
					const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
					const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
					const path = parts[2];
					const existing = this._fileChanges.get(path);
					if (existing && (existing.additions !== additions || existing.deletions !== deletions)) {
						existing.additions = additions;
						existing.deletions = deletions;
						updated = true;
					}
				}
				if (updated) {
					this._fireFileChanges();
				}
			});
		}).catch(() => { /* child_process not available in browser context */ });
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
