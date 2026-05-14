/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsProvider, InlineCompletionsDisposeReason } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';

/**
 * ChipOS inline-completion provider stub (Cursor item 31 v1).
 *
 * Goal: register a provider against the framework's
 * `_languageFeaturesService.inlineCompletionsProvider` registry so the
 * framework's ghost-text infrastructure is fully wired for chipos —
 * keybindings (Tab to accept, Esc to dismiss, Alt+] / Alt+[ to switch
 * candidates), gutter rendering, partial accept, all of which require a
 * registered provider to exist for the editor's language.
 *
 * This v1 stub returns `null` for every request — meaning no ghost
 * text appears yet. Future v2 will:
 *   1. Debounce on `onDidChangeContent` / `onDidChangeCursorPosition`
 *   2. POST `{ prefix, suffix, language, recent_files }` to the
 *      reasoner's `/v1/code-completion` endpoint (TBD)
 *   3. Map response to `InlineCompletions.items[]`
 *
 * Why ship a stub: it makes the UI path discoverable (the inline
 * completions service is active per-editor) and removes the chipos
 * side of the wire — when the reasoner endpoint lands, only this file
 * changes; no other code rebuilds.
 */
class ChipOSInlineCompletionsProvider implements InlineCompletionsProvider<InlineCompletions> {

	readonly debugDisplayName = 'chipos.inlineCompletions';

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	provideInlineCompletions(
		_model: ITextModel,
		_position: Position,
		_context: InlineCompletionContext,
		_token: CancellationToken,
	): Promise<InlineCompletions | null> {
		// v1 stub — no suggestions yet. Logged at trace level so the wire
		// is observable when developing the reasoner endpoint without
		// polluting normal logs.
		this._logService.trace('[ChipOS InlineCompletions] provider called (stub) — returning null');
		return Promise.resolve(null);
	}

	disposeInlineCompletions(_completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		// Stub returns null so dispose has nothing to clean up.
	}
}

export class ChipOSInlineCompletionsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chiposInlineCompletions';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ILogService logService: ILogService,
	) {
		super();
		const provider = new ChipOSInlineCompletionsProvider(logService);
		// `{ pattern: '**' }` matches every document URI — chipos targets
		// EDA files (.v / .sv / .vhd) but also wants completions in Python
		// testbenches, Tcl scripts, etc. v2 will narrow by language or
		// add a config gate.
		this._register(languageFeaturesService.inlineCompletionsProvider.register({ pattern: '**' }, provider));
		logService.info('[ChipOS] InlineCompletions provider registered (v1 stub — no suggestions yet, awaiting reasoner /v1/code-completion endpoint)');
	}
}

registerWorkbenchContribution2(ChipOSInlineCompletionsContribution.ID, ChipOSInlineCompletionsContribution, WorkbenchPhase.AfterRestored);
