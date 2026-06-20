/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { timeout } from '../../../../../base/common/async.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';

/**
 * The customEditor `viewType` contributed by the `lramseyer.vaporview` builtin
 * extension for `.vcd`/`.fst`/`.ghw`/`.fsdb` waveform files (see its
 * `package.json` → `contributes.customEditors`).
 */
const VAPORVIEW_VIEW_TYPE = 'vaporview.waveformViewer';

/**
 * Vaporview's public command to add (and optionally reveal) a variable in the
 * open waveform viewer. Argument shape (per Vaporview API_DOCS.md):
 * `{ uri?, netlistId?, instancePath?, scopePath?, name?, msb?, lsb?, recursive?, reveal? }`.
 * We address signals by `instancePath` and pass `reveal: true` so an
 * already-displayed signal is selected rather than duplicated.
 *
 * IMPORTANT: `uri` MUST be a STRING here, not a `URI`. Vaporview resolves the
 * document with `documents[i].uri.toString() === arg.uri` (a string identity
 * check), so passing a revived `URI` object never matches and it silently warns
 * "Document not found". We always pass Vaporview's OWN reported uri string (from
 * `getOpenDocuments`) — see `_resolveOpenDocumentUri`.
 */
const VAPORVIEW_ADD_VARIABLE_CMD = 'waveformViewer.addVariable';

/**
 * Vaporview's public command to set the marker. Argument shape:
 * `{ uri?, time, units?, markerType? }` (`uri` a STRING, see addVariable note).
 * Note Vaporview markers are keyed by *time* (with units), not a cycle index —
 * see the gap note on `openWaveform`.
 */
const VAPORVIEW_SET_MARKER_CMD = 'waveformViewer.setMarker';

/**
 * Vaporview's command returning the open waveform documents — used to recover
 * the exact uri string Vaporview keys a document under (and to wait for it to be
 * registered after a fresh open). Return shape: `{ documents: string[],
 * last_active_document: string | null }`.
 */
const VAPORVIEW_GET_OPEN_DOCUMENTS_CMD = 'waveformViewer.getOpenDocuments';

/**
 * Vaporview's command returning a document's viewer state (save-file schema),
 * whose `displayedSignals` array we use to VERIFY that an `addVariable` actually
 * landed — on a cold open the webview is still loading when addVariable fires and
 * silently drops it (no throw), so we re-issue until the displayed count reaches
 * the target. Return shape (subset): `{ displayedSignals: unknown[], … }`.
 */
const VAPORVIEW_GET_VIEWER_STATE_CMD = 'waveformViewer.getViewerState';

export interface IOpenWaveformOptions {
	/** Full instance paths of signals to add/reveal in the viewer. */
	readonly signals?: string[];
	/**
	 * Optional cycle index to mark. Vaporview only exposes a *time*-based marker
	 * (`setMarker`), so this is forwarded as a best-effort `time` value and may
	 * not map to a literal clock cycle. See the gap note in `openWaveform`.
	 */
	readonly cycle?: number;
}

export const IChiposWaveformService = createDecorator<IChiposWaveformService>('chiposWaveformService');

export interface IChiposWaveformService {
	readonly _serviceBrand: undefined;

	/**
	 * Open the given `.vcd` (or other Vaporview-supported) waveform in Vaporview's
	 * custom editor and, best-effort, add/reveal the requested signals and set a
	 * marker. Never throws — failures are logged and swallowed so callers (the
	 * agent `viewer_action` driver, dev commands) can fire-and-forget.
	 */
	openWaveform(vcdUri: URI, opts?: IOpenWaveformOptions): Promise<void>;
}

export class ChiposWaveformService implements IChiposWaveformService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async openWaveform(vcdUri: URI, opts?: IOpenWaveformOptions): Promise<void> {
		try {
			await this._openInVaporview(vcdUri);
		} catch (err) {
			this._logService.warn(`[ChipOS][Waveform] Failed to open ${vcdUri.toString()} in Vaporview: ${this._describe(err)}`);
			return;
		}

		const signals = opts?.signals ?? [];
		if (signals.length === 0 && typeof opts?.cycle !== 'number') {
			return;
		}

		// Recover the exact uri STRING Vaporview keys this document under and wait
		// for it to be registered. Vaporview's command args want `uri` as a string
		// (it does a verbatim `doc.uri.toString() === arg.uri` check), and reusing
		// its OWN reported uri sidesteps every URI-identity pitfall — revived-URI
		// objects, the macOS `/private` firmlink, trailing-slash/encoding drift.
		const docUriStr = await this._resolveOpenDocumentUri(vcdUri);
		if (!docUriStr) {
			this._logService.warn(`[ChipOS][Waveform] Vaporview never registered ${vcdUri.toString()}; skipping signal/marker reveal.`);
			return;
		}

		if (signals.length > 0) {
			await this._revealSignals(docUriStr, signals);
		}

		// Vaporview's marker is time-based (`setMarker` takes `time` + `units`),
		// not cycle-indexed, so there is no exact "go to cycle N" command. We
		// forward `cycle` as a best-effort `time` value (default waveform units);
		// callers that need true cycle→time conversion must resolve the clock
		// period themselves before calling. GAP: no cycle-marker command exists.
		// Set AFTER the signals (the webview is warm by then, so the marker lands).
		if (typeof opts?.cycle === 'number') {
			await this._executeWithRetry(VAPORVIEW_SET_MARKER_CMD, { uri: docUriStr, time: opts.cycle, markerType: 0 });
		}
	}

	/**
	 * Add + reveal `signals`, re-issuing until they actually appear in the viewer.
	 * The cold-open trap: even after the netlist parses and `addVariable` is
	 * accepted (no throw), the WEBVIEW that renders the waveform is still loading,
	 * so the "draw this signal" message is dropped and the signal never shows — and
	 * Vaporview reports nothing back. We can't detect that per-call, so after each
	 * round we read `getViewerState().displayedSignals` and re-issue (idempotent via
	 * `reveal: true`) until the displayed count reaches the target or settles (some
	 * paths may be genuinely absent from the netlist). Best-effort — never throws.
	 */
	private async _revealSignals(docUriStr: string, signals: string[]): Promise<void> {
		const ATTEMPTS = 10;
		const DELAY_MS = 350;
		const target = signals.length;
		let prevCount = -1;
		let stableRounds = 0;
		for (let i = 0; i < ATTEMPTS; i++) {
			for (const signal of signals) {
				try {
					await this._commandService.executeCommand(VAPORVIEW_ADD_VARIABLE_CMD, { uri: docUriStr, instancePath: signal, reveal: true });
				} catch {
					// Command not registered yet (extension still activating) — next round.
				}
			}
			await timeout(DELAY_MS);
			const count = await this._displayedSignalCount(docUriStr);
			if (count >= target) {
				return;
			}
			// Settle guard: if the count has stopped growing for two rounds, the
			// signals that CAN resolve have landed (the rest are absent paths) — stop
			// rather than burn the full attempt budget.
			if (count > 0 && count === prevCount) {
				stableRounds++;
				if (stableRounds >= 2) {
					this._logService.warn(`[ChipOS][Waveform] revealed ${count}/${target} signals (remaining paths not in netlist?)`);
					return;
				}
			} else {
				stableRounds = 0;
			}
			prevCount = count;
		}
		this._logService.warn(`[ChipOS][Waveform] signal reveal gave up at ${prevCount < 0 ? 0 : prevCount}/${target} after ${ATTEMPTS} rounds`);
	}

	/** Number of signals currently displayed in the viewer (0 on any error). */
	private async _displayedSignalCount(docUriStr: string): Promise<number> {
		try {
			const state = await this._commandService.executeCommand<{ displayedSignals?: unknown[] }>(VAPORVIEW_GET_VIEWER_STATE_CMD, { uri: docUriStr });
			return Array.isArray(state?.displayedSignals) ? state!.displayedSignals!.length : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Poll `getOpenDocuments` until Vaporview reports a document matching `vcdUri`
	 * (by file name), returning that document's exact uri STRING — the authoritative
	 * key for addVariable/setMarker. Also serves as a readiness gate: the document
	 * only appears here once Vaporview has registered it. The extension activates
	 * asynchronously on open, so the command itself may not exist yet (throws) for
	 * the first attempts. Returns undefined if it never appears in the window.
	 */
	private async _resolveOpenDocumentUri(vcdUri: URI): Promise<string | undefined> {
		const wantBase = this._baseName(vcdUri.path);
		const ATTEMPTS = 12;
		const DELAY_MS = 300;
		for (let i = 0; i < ATTEMPTS; i++) {
			try {
				// The command returns a plain array of uri strings (Vaporview's
				// `getAllDocumentUris()` → `documents.map(d => d.uri.toString())`).
				// Tolerate an object-wrapped shape too in case a future version
				// changes it (the API doc describes `{ documents, lastActiveDocument }`).
				const result = await this._commandService.executeCommand<string[] | { documents?: string[] }>(VAPORVIEW_GET_OPEN_DOCUMENTS_CMD);
				const docs: string[] = Array.isArray(result)
					? result
					: Array.isArray(result?.documents) ? result.documents : [];
				const match = docs.find(d => typeof d === 'string' && this._baseName(d) === wantBase);
				if (match) {
					return match;
				}
			} catch {
				// Command not registered yet (extension still activating) — retry.
			}
			await timeout(DELAY_MS);
		}
		return undefined;
	}

	private _baseName(pathOrUri: string): string {
		const noQuery = pathOrUri.split('?')[0].split('#')[0];
		const segs = noQuery.split('/');
		return segs[segs.length - 1] || noQuery;
	}

	/**
	 * Run a Vaporview command, retrying through the residual VCD-parse race: even
	 * after the document is registered, addVariable can report "Signal not found"
	 * (a message, not a throw) until the netlist finishes building. `reveal: true`
	 * makes repeats idempotent. Best-effort — never throws.
	 */
	private async _executeWithRetry(commandId: string, arg: object): Promise<void> {
		const ATTEMPTS = 6;
		const DELAY_MS = 300;
		for (let i = 0; i < ATTEMPTS; i++) {
			try {
				await this._commandService.executeCommand(commandId, arg);
				return;
			} catch (err) {
				if (i === ATTEMPTS - 1) {
					this._logService.warn(`[ChipOS][Waveform] '${commandId}' failed (final attempt): ${this._describe(err)}`);
					return;
				}
				await timeout(DELAY_MS);
			}
		}
	}

	private async _openInVaporview(vcdUri: URI): Promise<void> {
		// Preferred path: open directly via the editor service with the Vaporview
		// custom-editor override so it routes through the normal editor-opening
		// logic (revealIfOpened, group placement, etc.).
		try {
			await this._editorService.openEditor({
				resource: vcdUri,
				options: { override: VAPORVIEW_VIEW_TYPE },
			});
			return;
		} catch (err) {
			this._logService.warn(`[ChipOS][Waveform] editorService override open failed, falling back to vscode.openWith: ${this._describe(err)}`);
		}

		// Fallback: plain open then re-open with the explicit Vaporview viewType.
		await this._commandService.executeCommand('vscode.openWith', vcdUri, VAPORVIEW_VIEW_TYPE);
	}

	private _describe(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
