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
 *   IPC channel `chipos:eda-env-status` { line, role }
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

const IPC_CHANNEL = 'chipos:eda-env-status';

/**
 * Parsed shape of one [EdaEnv] line. Exported for unit testing the
 * regex / split logic separately from the IPC + UI plumbing.
 */
export type EdaEnvParsed =
	| { kind: 'check'; statuses: Record<string, 'ok' | 'missing'> }
	| { kind: 'missing'; tool: string; install_hint: string }
	| { kind: 'ready'; level: 'all' | 'core' }
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

	if (line.startsWith('check ')) {
		const body = line.slice('check '.length);
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

	return { kind: 'unknown', raw: rawLine };
}

export class EdaEnvHandler extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chipos.edaEnvHandler';

	/** Tools we already toasted about this session — key is `${tool}::${hint}`. */
	private readonly _seenMissing = new Set<string>();

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

				const actions = parsed.install_hint
					? {
						primary: [{
							id: `chipos.edaEnv.openInstallGuide.${parsed.tool}`,
							label: localize('chipos.edaEnv.openInstallGuide', 'Open install guide'),
							tooltip: parsed.install_hint,
							class: undefined,
							enabled: true,
							run: async () => {
								await this._openerService.open(URI.parse(parsed.install_hint));
							},
							dispose: () => { /* no-op */ },
						}],
					}
					: undefined;

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
				return;
			}
			case 'unknown':
				this._logService.debug(`[ChipOS EdaEnv] unparsed line: ${parsed.raw}`);
				return;
		}
	}
}

registerWorkbenchContribution2(EdaEnvHandler.ID, EdaEnvHandler, WorkbenchPhase.AfterRestored);
