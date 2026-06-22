/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { WebviewInput } from '../../../../../workbench/contrib/webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../../../workbench/contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { IRunMetadata, IRunStorageService } from './runStorageService.js';

/** Webview view type used to identify (and revive/reuse) the run detail editor. */
const RUN_DETAIL_VIEW_TYPE = 'chipos.runDetail';

/** Command id invoked to open a run's detail view. */
export const OPEN_RUN_DETAIL_COMMAND_ID = 'chipos.runs.openDetail';

/** Shape of the messages the webview posts back to the host. */
interface IRunDetailMessage {
	readonly type: 'openArtifact' | 'openFile';
	readonly index: number;
}

/**
 * Manages a single, reused webview editor that renders the detail for a
 * captured run. Mirrors the lightweight webview-input lifecycle used by
 * `ReleaseNotesManager`: a long-lived input is opened once, its HTML is
 * swapped when a different run is selected, and link/row clicks come back via
 * `webview.onMessage` so the host can open artifacts and changed files through
 * the proper services.
 */
export class RunDetailPanel extends Disposable {

	private _input: WebviewInput | undefined;
	private _current: IRunMetadata | undefined;
	private readonly _inputDisposables = this._register(new DisposableStore());

	constructor(
		@IRunStorageService private readonly _runStorageService: IRunStorageService,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IEditorService private readonly _editorService: IEditorService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/** Open (or refresh + reveal) the detail view for `traceId`. */
	open(traceId: string): void {
		const run = this._runStorageService.getRun(traceId);
		if (!run) {
			this._logService.warn('[ChipOS] Run detail requested for unknown trace id:', traceId);
			return;
		}

		this._current = run;
		const title = localize('chipos.runs.detail.title', 'Run: {0}', run.label);
		const html = this._renderHtml(run);

		if (this._input) {
			this._input.setWebviewTitle(title);
			this._input.webview.setHtml(html);
			this._webviewWorkbenchService.revealWebview(this._input, this._editorService.activeEditorPane?.group ?? ACTIVE_GROUP, false);
			return;
		}

		this._input = this._webviewWorkbenchService.openWebview(
			{
				title,
				options: { tryRestoreScrollPosition: true, enableFindWidget: true },
				contentOptions: { allowScripts: true },
				extension: undefined,
			},
			RUN_DETAIL_VIEW_TYPE,
			title,
			Codicon.beaker,
			{ group: ACTIVE_GROUP, preserveFocus: false },
		);

		this._inputDisposables.add(this._input.webview.onMessage(e => this._onMessage(e.message as IRunDetailMessage)));
		this._inputDisposables.add(this._input.onWillDispose(() => {
			this._inputDisposables.clear();
			this._input = undefined;
			this._current = undefined;
		}));

		this._input.webview.setHtml(html);
	}

	private _onMessage(message: IRunDetailMessage): void {
		const run = this._current;
		if (!run || !message || typeof message.index !== 'number') {
			return;
		}
		if (message.type === 'openArtifact') {
			const artifact = run.artifacts[message.index];
			if (artifact?.uri) {
				this._openResource(artifact.uri);
			}
		} else if (message.type === 'openFile') {
			const file = run.changedFiles[message.index];
			if (file?.path) {
				this._openResource(file.path);
			}
		}
	}

	/** Open a resource via the editor (for file:// paths) or the opener service. */
	private _openResource(target: string): void {
		try {
			const uri = /^[a-z][a-z0-9+.-]*:/i.test(target) ? URI.parse(target) : URI.file(target);
			if (uri.scheme === 'file') {
				void this._editorService.openEditor({ resource: uri, options: { pinned: false } });
			} else {
				void this._openerService.open(uri);
			}
		} catch (err) {
			this._logService.warn('[ChipOS] Failed to open run resource:', target, err);
		}
	}

	private _renderHtml(run: IRunMetadata): string {
		const statusClass = `status-${run.status}`;
		const statusLabel = escape(run.status.toUpperCase());

		const metaBits: string[] = [escape(relativeTime(run.timestamp))];
		if (run.tool) {
			metaBits.push(escape(run.tool));
		}
		metaBits.push(escape(run.traceId));
		if (typeof run.durationMs === 'number') {
			metaBits.push(escape(formatDuration(run.durationMs)));
		}
		const meta = metaBits.join(' &middot; ');

		const artifactsHtml = run.artifacts.length > 0
			? run.artifacts.map((a, i) => {
				const clickable = !!a.uri;
				const summary = a.summary ? `<span class="sub">${escape(a.summary)}</span>` : '';
				const attrs = clickable ? ` class="row clickable" data-kind="artifact" data-index="${i}" role="button" tabindex="0"` : ' class="row"';
				return `<div${attrs}><span class="kind">${escape(a.kind)}</span>${a.uri ? `<span class="path">${escape(a.uri)}</span>` : ''}${summary}</div>`;
			}).join('')
			: `<div class="empty">${escape(localize('chipos.runs.detail.noArtifacts', 'No artifacts.'))}</div>`;

		const filesHtml = run.changedFiles.length > 0
			? run.changedFiles.map((f, i) => {
				const churn = formatChurn(f.added, f.removed);
				return `<div class="row clickable" data-kind="file" data-index="${i}" role="button" tabindex="0"><span class="path">${escape(f.path)}</span>${churn}</div>`;
			}).join('')
			: `<div class="empty">${escape(localize('chipos.runs.detail.noFiles', 'No changed files.'))}</div>`;

		const resultHtml = run.verdictSummary
			? `<div class="result">${escape(run.verdictSummary)}</div>`
			: `<div class="empty">${escape(localize('chipos.runs.detail.noResult', 'No result summary.'))}</div>`;

		const errorsHtml = run.errors && run.errors.length > 0
			? `<section><h2>${escape(localize('chipos.runs.detail.errors', 'Errors'))}</h2>${run.errors.map(e => {
				const code = e.code ? `<span class="kind">${escape(e.code)}</span>` : '';
				return `<div class="row error">${code}<span class="msg">${escape(e.message)}</span></div>`;
			}).join('')}</section>`
			: '';

		const labels = {
			artifacts: escape(localize('chipos.runs.detail.artifacts', 'Artifacts')),
			files: escape(localize('chipos.runs.detail.changedFiles', 'Changed Files')),
			result: escape(localize('chipos.runs.detail.result', 'Result')),
		};

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
	body {
		margin: 0;
		padding: 16px 20px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground);
		background: transparent;
	}
	header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
	h1 { font-size: 1.25em; font-weight: 600; margin: 0; }
	h2 {
		font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--vscode-descriptionForeground); margin: 22px 0 8px;
	}
	.badge {
		display: inline-block; padding: 2px 9px; border-radius: 10px;
		font-size: 0.72em; font-weight: 700; letter-spacing: 0.05em;
		color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
	}
	.badge.status-passed { background: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); color: var(--vscode-editor-background); }
	.badge.status-failed { background: var(--vscode-charts-red, var(--vscode-testing-iconFailed)); color: var(--vscode-editor-background); }
	.badge.status-fixed { background: var(--vscode-charts-blue, var(--vscode-testing-iconQueued)); color: var(--vscode-editor-background); }
	.badge.status-unknown { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 0 0 4px; }
	section { margin: 0; }
	.row {
		display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
		padding: 6px 8px; border-radius: 4px;
		border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	}
	.row.clickable { cursor: pointer; }
	.row.clickable:hover { background: var(--vscode-list-hoverBackground); }
	.row.clickable:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.kind {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.85em; color: var(--vscode-textLink-foreground);
	}
	.path { color: var(--vscode-foreground); word-break: break-all; }
	.sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
	.churn { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; }
	.churn .add { color: var(--vscode-charts-green, var(--vscode-gitDecoration-addedResourceForeground)); }
	.churn .del { color: var(--vscode-charts-red, var(--vscode-gitDecoration-deletedResourceForeground)); }
	.result {
		padding: 10px 12px; border-radius: 6px; line-height: 1.5;
		background: var(--vscode-textBlockQuote-background);
		border-left: 3px solid var(--vscode-textBlockQuote-border);
	}
	.row.error .msg { color: var(--vscode-errorForeground); }
	.empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px 8px; }
</style>
</head>
<body>
	<header>
		<span class="badge ${statusClass}">${statusLabel}</span>
		<h1>${escape(run.label)}</h1>
	</header>
	<p class="meta">${meta}</p>

	<section>
		<h2>${labels.artifacts}</h2>
		${artifactsHtml}
	</section>

	<section>
		<h2>${labels.files}</h2>
		${filesHtml}
	</section>

	<section>
		<h2>${labels.result}</h2>
		${resultHtml}
	</section>

	${errorsHtml}

	<script>
		const vscode = acquireVsCodeApi();
		document.addEventListener('click', evt => {
			const row = evt.target.closest('.row.clickable');
			if (!row) { return; }
			post(row);
		});
		document.addEventListener('keydown', evt => {
			if (evt.key !== 'Enter' && evt.key !== ' ') { return; }
			const row = evt.target.closest('.row.clickable');
			if (!row) { return; }
			evt.preventDefault();
			post(row);
		});
		function post(row) {
			const index = Number(row.getAttribute('data-index'));
			const kind = row.getAttribute('data-kind');
			vscode.postMessage({ type: kind === 'artifact' ? 'openArtifact' : 'openFile', index });
		}
	</script>
</body>
</html>`;
	}
}

/** HTML-escape a string for safe inline interpolation. */
function escape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Render a `+a −r` churn fragment, omitting absent sides. */
function formatChurn(added?: number, removed?: number): string {
	const bits: string[] = [];
	if (typeof added === 'number') {
		bits.push(`<span class="add">+${added}</span>`);
	}
	if (typeof removed === 'number') {
		bits.push(`<span class="del">−${removed}</span>`);
	}
	return bits.length > 0 ? `<span class="churn">${bits.join(' ')}</span>` : '';
}

/** Human-readable duration (e.g. `1.2s`, `850ms`). */
function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return localize('chipos.runs.detail.durationMs', '{0}ms', durationMs);
	}
	return localize('chipos.runs.detail.durationSec', '{0}s', (durationMs / 1000).toFixed(1));
}

/** Coarse relative-time string (`just now`, `2m ago`, `3h ago`, `4d ago`). */
function relativeTime(timestamp: number): string {
	const deltaMs = Math.max(0, Date.now() - timestamp);
	const seconds = Math.floor(deltaMs / 1000);
	if (seconds < 45) {
		return localize('chipos.runs.time.now', 'just now');
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return localize('chipos.runs.time.minutes', '{0}m ago', Math.max(1, minutes));
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('chipos.runs.time.hours', '{0}h ago', hours);
	}
	const days = Math.floor(hours / 24);
	return localize('chipos.runs.time.days', '{0}d ago', days);
}
