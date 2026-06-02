/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * EdaEnvHandler — consume `[EdaEnv]` lines pushed from the worker stderr at
 * startup and surface install guidance / status notifications to the user.
 *
 * Wire diagram:
 *
 *   worker stderr [EdaEnv] line
 *        ↓ (parsed line-by-line in sidecarManagerMain.ts:760)
 *   IPC channel `vscode:chipos:eda-env-status` { line, role }
 *   (NOTE: the `vscode:` prefix is mandatory — the sandbox preload's
 *    validateIPC rejects any channel without it. The earlier
 *    `chipos:eda-pack-progress` channel was only ever consumed by the
 *    secondary-surface vscode-extension which runs with a different
 *    preload, so it doesn't hit this restriction. Anything consumed by
 *    the primary `vscode/` workbench MUST use the `vscode:` prefix.)
 *        ↓ (this contribution subscribes via ipcRenderer.on)
 *   parsed → notification (with "Open install guide" button per missing tool)
 *
 * Closes ROADMAP §11 P2-d. The main-process forwarding has existed since
 * ADR-009; the renderer-side consumer (this file) is what actually shows
 * the user something when the worker reports a missing EDA tool.
 *
 * Stderr line formats (from execution/eda_pack/environment.py docstring):
 *
 *   [EdaEnv] check yosys=ok iverilog=ok verilator=ok openroad=missing
 *     → overview line; we use it to count missing tools for a single summary
 *       notification at startup if any are missing.
 *
 *   [EdaEnv] missing openroad install_hint=https://github.com/...
 *     → per-tool detail. We surface these as a notification-with-action that
 *       opens the install_hint URL in the user's browser.
 *
 *   [EdaEnv] all_ready
 *   [EdaEnv] core_ready
 *     → quiet success markers; logged but no notification (avoid noise).
 *
 * De-dup: we only show the notification for a given (tool, install_hint)
 * once per IDE session. Worker restarts re-emit the same lines but the
 * user already saw the toast. State is per-window (one EdaEnvHandler per
 * IDE window); reopening the IDE resets the dedup set.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

const IPC_CHANNEL = 'vscode:chipos:eda-env-status';
const RESCAN_INVOKE_CHANNEL = 'vscode:chipos:eda-rescan';

/**
 * Parsed shape of one [EdaEnv] line. Exported for unit testing the
 * regex / split logic separately from the IPC + UI plumbing.
 */
export type EdaEnvParsed =
	| { kind: 'check'; statuses: Record<string, 'ok' | 'missing'> }
	| { kind: 'missing'; tool: string; install_hint: string }
	| { kind: 'ready'; level: 'all' | 'core' }
	| { kind: 'found'; tool: string; path: string; version: string }
	| { kind: 'poll_stopped'; reason: 'all_found' | 'timeout'; remaining: string[] }
	| { kind: 'unknown'; raw: string };

/**
 * Pure parser — given a raw `[EdaEnv] ...` line (with or without the prefix),
 * return a typed shape. Defensive: malformed lines return { kind: 'unknown' }
 * so caller can log + ignore instead of throwing.
 *
 * Exported (module-level) for unit testing — keeps the parsing concern
 * isolated from the contribution's IPC + notification side effects.
 */
export function parseEdaEnvLine(rawLine: string): EdaEnvParsed {
	// Strip the [EdaEnv] prefix if present so callers can pass either form.
	const line = rawLine.startsWith('[EdaEnv]')
		? rawLine.slice('[EdaEnv]'.length).trim()
		: rawLine.trim();
	if (!line) {
		return { kind: 'unknown', raw: rawLine };
	}

	if (line === 'all_ready') {
		return { kind: 'ready', level: 'all' };
	}
	if (line === 'core_ready') {
		return { kind: 'ready', level: 'core' };
	}

	// Match the bare verb too (`[EdaEnv] check` with no tool tokens) — a
	// degenerate-but-valid overview reporting zero tools. Mirrors the
	// `poll_stopped` handling below, which also parses its arg-less form.
	if (line === 'check' || line.startsWith('check ')) {
		const body = line.slice('check'.length).trim();
		const statuses: Record<string, 'ok' | 'missing'> = {};
		for (const tok of body.split(/\s+/)) {
			if (!tok) { continue; }
			const eq = tok.indexOf('=');
			if (eq < 0) { continue; }
			const tool = tok.slice(0, eq);
			const state = tok.slice(eq + 1);
			if (state === 'ok' || state === 'missing') {
				statuses[tool] = state;
			}
		}
		return { kind: 'check', statuses };
	}

	if (line.startsWith('missing ')) {
		const body = line.slice('missing '.length).trim();
		// Expected: `<tool> install_hint=<url>`. Tool name is the first word;
		// install_hint may contain `=` so split only on the first `install_hint=`.
		const hintIdx = body.indexOf('install_hint=');
		if (hintIdx < 0) {
			// Just `missing <tool>` with no hint URL — still useful to surface.
			return { kind: 'missing', tool: body.split(/\s+/)[0] ?? '', install_hint: '' };
		}
		const tool = body.slice(0, hintIdx).trim();
		const install_hint = body.slice(hintIdx + 'install_hint='.length).trim();
		return { kind: 'missing', tool, install_hint };
	}

	// `found <tool> path=<path> version=<version>` — emitted by worker
	// background path-poll when a previously-missing tool appears in PATH.
	// Used to auto-clear missing-tool notifications without the user
	// having to click "I've installed it, rescan".
	if (line.startsWith('found ')) {
		const body = line.slice('found '.length).trim();
		const parts = body.split(/\s+/);
		const tool = parts[0] ?? '';
		let path = '';
		let version = '';
		for (const tok of parts.slice(1)) {
			const eq = tok.indexOf('=');
			if (eq < 0) { continue; }
			const k = tok.slice(0, eq);
			const v = tok.slice(eq + 1);
			if (k === 'path') { path = v; }
			else if (k === 'version') { version = v; }
		}
		return { kind: 'found', tool, path, version };
	}

	// `poll_stopped reason=<all_found|timeout> remaining=<csv|none>` — emitted
	// when the worker's background path-poll daemon exits. Informational only.
	if (line.startsWith('poll_stopped')) {
		const body = line.slice('poll_stopped'.length).trim();
		let reason: 'all_found' | 'timeout' = 'timeout';
		let remaining: string[] = [];
		for (const tok of body.split(/\s+/)) {
			if (!tok) { continue; }
			const eq = tok.indexOf('=');
			if (eq < 0) { continue; }
			const k = tok.slice(0, eq);
			const v = tok.slice(eq + 1);
			if (k === 'reason' && (v === 'all_found' || v === 'timeout')) {
				reason = v;
			} else if (k === 'remaining' && v && v !== 'none') {
				remaining = v.split(',').filter(x => x);
			}
		}
		return { kind: 'poll_stopped', reason, remaining };
	}

	return { kind: 'unknown', raw: rawLine };
}

export class EdaEnvHandler extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.edaEnvHandler';

	/** Tools we already toasted about this session — key is `${tool}::${hint}`. */
	private readonly _seenMissing = new Set<string>();

	/** Once-per-session guard for the "EDA toolchain ready" toast — we don't
	 * want to repeatedly congratulate the user every time a rescan runs.
	 * Reset by IDE restart. */
	private _announcedReady = false;

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		const onMessage = (_evt: unknown, ...args: unknown[]) => {
			const payload = args[0] as { line?: string; role?: string } | undefined;
			if (!payload || typeof payload.line !== 'string') {
				return;
			}
			try {
				this._handle(payload.line, payload.role ?? 'worker');
			} catch (err) {
				this._logService.warn(`[ChipOS EdaEnv] handler threw: ${err}`);
			}
		};

		ipcRenderer.on(IPC_CHANNEL, onMessage);
		this._register({
			dispose: () => {
				try {
					ipcRenderer.removeListener(IPC_CHANNEL, onMessage);
				} catch {
					/* ignore */
				}
			},
		});

		this._logService.info('[ChipOS EdaEnv] handler registered, listening on ' + IPC_CHANNEL);
	}

	private _handle(line: string, role: string): void {
		const parsed = parseEdaEnvLine(line);
		switch (parsed.kind) {
			case 'check': {
				const missingCount = Object.values(parsed.statuses).filter(v => v === 'missing').length;
				const total = Object.keys(parsed.statuses).length;
				this._logService.info(
					`[ChipOS EdaEnv] ${role} check: ${total - missingCount}/${total} EDA tools ready`,
				);
				// If this is a rescan emit AND a previously-missing tool now
				// reports `ok`, drop matching entries from `_seenMissing` so
				// future emits will toast again (e.g. user uninstalls then
				// reinstalls within one session). Also surface a one-shot
				// success notification for tools that just transitioned
				// missing → ok during this session, so the user gets
				// positive feedback for clicking the rescan button.
				if (role === 'rescan') {
					const justFixed: string[] = [];
					for (const [tool, state] of Object.entries(parsed.statuses)) {
						if (state !== 'ok') { continue; }
						// _seenMissing keys are `${tool}::${hint}` — drop ANY
						// hint variant for this tool name.
						for (const key of Array.from(this._seenMissing)) {
							if (key.startsWith(`${tool}::`)) {
								this._seenMissing.delete(key);
								justFixed.push(tool);
							}
						}
					}
					if (justFixed.length > 0) {
						this._notificationService.notify({
							severity: Severity.Info,
							message: localize(
								'chipos.edaEnv.rescanFound',
								'Detected newly-installed EDA tools: {0}',
								justFixed.join(', '),
							),
						});
					} else if (missingCount > 0) {
						// Rescan ran but nothing new appeared — tell the user so
						// they don't sit waiting wondering if the button did
						// anything. (Without this, a click on the button looked
						// silently broken when the tool wasn't actually on PATH
						// yet.)
						this._notificationService.notify({
							severity: Severity.Warning,
							message: localize(
								'chipos.edaEnv.rescanNoChange',
								'Rescan complete — no newly-installed tools detected. {0} tool(s) still missing.',
								missingCount,
							),
						});
					}
				}
				return;
			}
			case 'missing': {
				const dedupKey = `${parsed.tool}::${parsed.install_hint}`;
				if (this._seenMissing.has(dedupKey)) {
					return;
				}
				this._seenMissing.add(dedupKey);
				this._logService.warn(
					`[ChipOS EdaEnv] missing tool reported: ${parsed.tool} (hint=${parsed.install_hint || '<none>'})`,
				);

				const message = parsed.install_hint
					? localize(
						'chipos.edaEnv.missing.with.hint',
						'EDA tool not found: {0}. Click \"Open install guide\" to view installation instructions.',
						parsed.tool,
					)
					: localize(
						'chipos.edaEnv.missing.no.hint',
						'EDA tool not found: {0}. (No install hint provided by the worker.)',
						parsed.tool,
					);

				// Two action buttons:
				// 1. "View install guide" — opens our in-IDE markdown walkthrough
				//    (per-vendor: account flow / license / PATH setup / verification
				//    command). Falls back to the raw vendor URL for tools without
				//    a bundled guide. See `_resolveInstallGuideUri` for the lookup
				//    table — every entry there opens a Walkthrough/markdown URI,
				//    NOT the bare vendor download page that left users stuck at
				//    "needs a Xilinx account" with no recovery path.
				// 2. "我已安装完成，重新检测" — invokes the main-process IPC
				//    `vscode:chipos:eda-rescan` which spawns a one-shot
				//    `chipos-worker scan-eda` subprocess in the same env/PATH as
				//    the live worker. Stderr `[EdaEnv]` lines come back on the
				//    SAME `vscode:chipos:eda-env-status` channel — so the
				//    user's freshly-installed Vivado appears as `check ...
				//    vivado=ok` and we drop the notification + status pill
				//    updates without restarting the worker.
				const primary: Array<{ id: string; label: string; tooltip: string; class: undefined; enabled: boolean; run: () => Promise<void>; dispose: () => void }> = [];
				if (parsed.install_hint) {
					primary.push({
						id: `chipos.edaEnv.openInstallGuide.${parsed.tool}`,
						label: localize('chipos.edaEnv.viewInstallGuide', 'View install guide'),
						tooltip: parsed.install_hint,
						class: undefined,
						enabled: true,
						run: async () => {
							await this._openerService.open(this._resolveInstallGuideUri(parsed.tool, parsed.install_hint));
						},
						dispose: () => { /* no-op */ },
					});
				}
				primary.push({
					id: `chipos.edaEnv.rescan.${parsed.tool}`,
					label: localize('chipos.edaEnv.rescan', "I've installed it, rescan"),
					tooltip: localize('chipos.edaEnv.rescan.tooltip', 'Re-scan the worker PATH for newly-installed EDA tools without restarting the worker.'),
					class: undefined,
					enabled: true,
					run: async () => {
						await this._triggerRescan();
					},
					dispose: () => { /* no-op */ },
				});
				const actions = { primary };

				this._notificationService.notify({
					severity: Severity.Warning,
					message,
					actions,
				});
				return;
			}
			case 'ready': {
				this._logService.info(
					`[ChipOS EdaEnv] ${role} ${parsed.level === 'all' ? 'all_ready' : 'core_ready'}`,
				);
				// rescan-triggered ready transitions deserve a toast — user just
				// clicked "I've installed it" or auto-poll found everything they
				// were waiting on. Startup ready signal stays silent (would
				// pop on every IDE launch which is noise).
				if (role === 'rescan' && !this._announcedReady) {
					this._announcedReady = true;
					this._notificationService.notify({
						severity: Severity.Info,
						message: parsed.level === 'all'
							? localize('chipos.edaEnv.allReady', 'EDA toolchain ready — all tools available.')
							: localize('chipos.edaEnv.coreReady', 'EDA toolchain ready — core tools available (some optional tools missing).'),
					});
				}
				return;
			}
			case 'found': {
				// Worker's background path-poll detected a tool the user just
				// finished installing. Drop the dedup entry so a fresh
				// missing-line would toast again later if needed, and surface
				// a positive notification so the user gets feedback for their
				// install effort.
				for (const key of Array.from(this._seenMissing)) {
					if (key.startsWith(`${parsed.tool}::`)) {
						this._seenMissing.delete(key);
					}
				}
				this._logService.info(
					`[ChipOS EdaEnv] background poll found ${parsed.tool} at ${parsed.path} (${parsed.version})`,
				);
				this._notificationService.notify({
					severity: Severity.Info,
					message: localize(
						'chipos.edaEnv.autoFound',
						'EDA tool detected: {0} ({1}). It’s now usable without restarting ChipOS.',
						parsed.tool,
						parsed.version || 'version unknown',
					),
				});
				return;
			}
			case 'poll_stopped': {
				// Informational. Logged so users debugging "why didn't ChipOS
				// auto-detect my install" have something to look at; not
				// surfaced as a notification because most users will never
				// notice this happened.
				this._logService.info(
					`[ChipOS EdaEnv] background poll stopped: reason=${parsed.reason} remaining=${parsed.remaining.join(',') || '<none>'}`,
				);
				return;
			}
			case 'unknown':
				this._logService.debug(`[ChipOS EdaEnv] unparsed line: ${parsed.raw}`);
				return;
		}
	}

	/**
	 * Resolve a tool name to the URI we want to open when the user clicks
	 * "View install guide". For tools we ship a bundled walkthrough for
	 * (vivado / quartus / openroad / verilator), we return a `command:`
	 * URI that invokes our markdown viewer command. For everything else
	 * we fall back to the raw vendor URL the worker reported in
	 * `install_hint`.
	 *
	 * NOTE: bundled-guide URI is a `command:chipos.eda.openInstallGuide`
	 * — that command is contributed elsewhere (next step in the migration)
	 * and reads from `vscode/src/vs/workbench/contrib/chipos/browser/media/installGuides/<tool>.md`.
	 * The renderer's command service handles unknown commands gracefully
	 * (logs + falls through to the URL), so this remains a safe no-op if
	 * the bundled guide is not yet wired.
	 */
	private _resolveInstallGuideUri(tool: string, fallbackUrl: string): URI {
		const BUNDLED_GUIDES = new Set(['vivado', 'quartus', 'quartus_sh', 'quartus_pgm', 'openroad', 'verilator', 'yosys', 'iverilog', 'sv2v']);
		if (BUNDLED_GUIDES.has(tool)) {
			const arg = encodeURIComponent(JSON.stringify(tool));
			return URI.parse(`command:chipos.eda.openInstallGuide?${arg}`);
		}
		return URI.parse(fallbackUrl);
	}

	/**
	 * Invoke the main-process rescan handler via the sandbox's ipcRenderer.
	 * Errors are logged + surfaced to the user as a warning — silent failure
	 * looks like a broken button. The actual scan results arrive separately
	 * via the regular IPC_CHANNEL handler (see `_handle`).
	 */
	private async _triggerRescan(): Promise<void> {
		this._logService.info('[ChipOS EdaEnv] user triggered rescan');
		try {
			const result = await ipcRenderer.invoke(RESCAN_INVOKE_CHANNEL) as { success?: boolean; error?: string; exitCode?: number };
			if (!result || result.success !== true) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: localize(
						'chipos.edaEnv.rescanFailed',
						'EDA rescan failed: {0}',
						result?.error ?? `exit code ${result?.exitCode ?? '?'}`,
					),
				});
			}
		} catch (err) {
			this._logService.error(`[ChipOS EdaEnv] rescan invoke threw: ${err}`);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize(
					'chipos.edaEnv.rescanInvokeFailed',
					'EDA rescan could not be triggered: {0}',
					String(err),
				),
			});
		}
	}
}

registerWorkbenchContribution2(EdaEnvHandler.ID, EdaEnvHandler, WorkbenchPhase.AfterRestored);

/**
 * `chipos.eda.rescan` — invokable from any notification button (e.g. the
 * "manual installation required" toast in chiposContribution.ts) or from the
 * command palette. Delegates to the main-process IPC handler that re-runs
 * `<worker-binary> scan-eda` in a one-shot subprocess. Result lines come back
 * on the regular `vscode:chipos:eda-env-status` channel and are handled by
 * the EdaEnvHandler instance above. Returns `true` on success so callers can
 * branch on the outcome (e.g. close a different notification).
 *
 * Registered at module-load (alongside `EdaEnvHandler`) so it's available
 * even before the workbench phase fires that constructs the contribution.
 */
CommandsRegistry.registerCommand('chipos.eda.rescan', async () => {
	try {
		const result = await ipcRenderer.invoke('vscode:chipos:eda-rescan') as { success?: boolean; error?: string; exitCode?: number };
		return result?.success === true;
	} catch (err) {
		console.error(`[ChipOS EdaEnv] rescan command threw: ${err}`);
		return false;
	}
});
