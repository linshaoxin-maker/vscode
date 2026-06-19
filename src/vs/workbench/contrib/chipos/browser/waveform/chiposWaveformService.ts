/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
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
 */
const VAPORVIEW_ADD_VARIABLE_CMD = 'waveformViewer.addVariable';

/**
 * Vaporview's public command to set the marker. Argument shape:
 * `{ uri?, time, units?, markerType? }`. Note Vaporview markers are keyed by
 * *time* (with units), not a cycle index — see the gap note on `openWaveform`.
 */
const VAPORVIEW_SET_MARKER_CMD = 'waveformViewer.setMarker';

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
		for (const signal of signals) {
			try {
				await this._commandService.executeCommand(VAPORVIEW_ADD_VARIABLE_CMD, {
					uri: vcdUri,
					instancePath: signal,
					reveal: true,
				});
			} catch (err) {
				this._logService.warn(`[ChipOS][Waveform] Failed to add/reveal signal '${signal}': ${this._describe(err)}`);
			}
		}

		// Vaporview's marker is time-based (`setMarker` takes `time` + `units`),
		// not cycle-indexed, so there is no exact "go to cycle N" command. We
		// forward `cycle` as a best-effort `time` value (default waveform units);
		// callers that need true cycle→time conversion must resolve the clock
		// period themselves before calling. GAP: no cycle-marker command exists.
		if (typeof opts?.cycle === 'number') {
			try {
				await this._commandService.executeCommand(VAPORVIEW_SET_MARKER_CMD, {
					uri: vcdUri,
					time: opts.cycle,
					markerType: 0,
				});
			} catch (err) {
				this._logService.warn(`[ChipOS][Waveform] Failed to set marker at cycle ${opts.cycle}: ${this._describe(err)}`);
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
