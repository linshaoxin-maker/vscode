/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsProvider, InlineCompletionsDisposeReason } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';

/**
 * ChipOS inline-completion provider (Cursor item 31).
 *
 * Two layers of behavior:
 *
 * 1) **Magic-comment snippets (v1.5, this commit)** — when the user types
 *    a recognized prefix like `// gen counter`, the provider returns a
 *    ghost-text Verilog skeleton. This:
 *      - Demos the framework's complete ghost-text path (Tab to accept,
 *        Esc to dismiss, gutter rendering) for chipos.
 *      - Gives real value today even before the reasoner /v1/code-
 *        completion endpoint exists.
 *      - Reads as "type the comment + Tab to materialize" which is a
 *        Cursor-style affordance.
 *
 * 2) **LLM completions (v2, future)** — when no magic-comment match,
 *    POST `{ prefix, suffix, language }` to reasoner's `/v1/code-
 *    completion` endpoint and map response to `InlineCompletions.items`.
 *    The endpoint is TBD; this file is the single place that changes
 *    when it lands.
 */

interface IMagicSnippet {
	/** Trigger comment text — matched case-insensitively. */
	readonly trigger: RegExp;
	/** Inserted code (excluding the magic-comment trigger itself, which is replaced). */
	readonly body: string;
	/** Filter text — what shows above the ghost as the completion label. */
	readonly label: string;
	/** Optional language filter. If absent, applies to every doc. */
	readonly languages?: ReadonlySet<string>;
}

const VERILOG_LANGS = new Set(['verilog', 'systemverilog']);

const SNIPPETS: readonly IMagicSnippet[] = [
	{
		trigger: /\/\/\s*gen\s+counter\s*$/i,
		label: 'gen counter — 8-bit free-running counter',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module counter #(',
			'    parameter WIDTH = 8',
			')(',
			'    input  wire             clk,',
			'    input  wire             rst_n,',
			'    output reg  [WIDTH-1:0] cnt',
			');',
			'',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n)',
			'            cnt <= {WIDTH{1\'b0}};',
			'        else',
			'            cnt <= cnt + 1\'b1;',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+testbench\s*$/i,
		label: 'gen testbench — clock + reset skeleton',
		languages: VERILOG_LANGS,
		body: [
			'',
			'`timescale 1ns/1ps',
			'',
			'module tb;',
			'',
			'    reg clk = 0;',
			'    reg rst_n = 0;',
			'    always #5 clk = ~clk;  // 100 MHz',
			'',
			'    // TODO: instantiate DUT',
			'',
			'    initial begin',
			'        #20 rst_n = 1;',
			'        #200;',
			'        $finish;',
			'    end',
			'',
			'    initial begin',
			'        $dumpfile("tb.vcd");',
			'        $dumpvars(0, tb);',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+fsm\s*$/i,
		label: 'gen fsm — 3-process FSM template',
		languages: VERILOG_LANGS,
		body: [
			'',
			'    // State encoding',
			'    localparam [1:0] S_IDLE = 2\'d0,',
			'                     S_RUN  = 2\'d1,',
			'                     S_DONE = 2\'d2;',
			'',
			'    reg [1:0] state, next_state;',
			'',
			'    // State register',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) state <= S_IDLE;',
			'        else        state <= next_state;',
			'    end',
			'',
			'    // Next-state logic',
			'    always @(*) begin',
			'        case (state)',
			'            S_IDLE: next_state = /* TODO */ S_RUN;',
			'            S_RUN:  next_state = /* TODO */ S_DONE;',
			'            S_DONE: next_state = S_IDLE;',
			'            default: next_state = S_IDLE;',
			'        endcase',
			'    end',
			'',
			'    // Output logic',
			'    always @(*) begin',
			'        case (state)',
			'            S_IDLE: /* TODO */;',
			'            S_RUN:  /* TODO */;',
			'            S_DONE: /* TODO */;',
			'        endcase',
			'    end',
		].join('\n'),
	},
];

class ChipOSInlineCompletionsProvider implements InlineCompletionsProvider<InlineCompletions> {

	readonly debugDisplayName = 'chipos.inlineCompletions';

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		_token: CancellationToken,
	): Promise<InlineCompletions | null> {
		const langId = model.getLanguageId();
		const lineText = model.getLineContent(position.lineNumber);
		const beforeCursor = lineText.substring(0, position.column - 1);

		for (const snippet of SNIPPETS) {
			if (snippet.languages && !snippet.languages.has(langId)) {
				continue;
			}
			if (!snippet.trigger.test(beforeCursor)) {
				continue;
			}
			// Replace the magic-comment trigger with the snippet body. The
			// snippet bodies start with `\n` so the trigger comment stays on
			// its own line and the generated code follows below.
			const replaceRange = new Range(
				position.lineNumber,
				1,
				position.lineNumber,
				position.column,
			);
			this._logService.info(`[ChipOS InlineCompletions] magic snippet matched: ${snippet.label}`);
			return Promise.resolve({
				items: [{
					insertText: beforeCursor + snippet.body,
					range: replaceRange,
					filterText: beforeCursor,
				}],
			});
		}

		// No magic match → defer to (future) reasoner LLM completion. v1.5
		// returns null; v2 will POST to /v1/code-completion here.
		this._logService.trace('[ChipOS InlineCompletions] no snippet match — returning null');
		return Promise.resolve(null);
	}

	disposeInlineCompletions(_completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		// Snippet bodies are inlined plain strings — nothing to clean up.
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
		logService.info('[ChipOS] InlineCompletions provider registered (v1.5 magic-comment snippets — counter / testbench / fsm; LLM endpoint pending)');
	}
}

registerWorkbenchContribution2(ChipOSInlineCompletionsContribution.ID, ChipOSInlineCompletionsContribution, WorkbenchPhase.AfterRestored);
