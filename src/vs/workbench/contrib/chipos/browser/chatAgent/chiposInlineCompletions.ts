/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionItemProvider, CompletionList, InlineCompletionContext, InlineCompletions, InlineCompletionsProvider, InlineCompletionsDisposeReason } from '../../../../../editor/common/languages.js';
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

export interface IChipOSEdaSnippet {
	readonly label: string;
	readonly body: string;
	readonly languages?: ReadonlySet<string>;
}

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
	{
		trigger: /\/\/\s*gen\s+(sync|synchronizer)\s*$/i,
		label: 'gen synchronizer — 2-stage CDC sync flop',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module sync2 #(',
			'    parameter WIDTH = 1',
			')(',
			'    input  wire             clk_dst,',
			'    input  wire             rst_n,',
			'    input  wire [WIDTH-1:0] in_async,',
			'    output reg  [WIDTH-1:0] out_sync',
			');',
			'',
			'    reg [WIDTH-1:0] meta;',
			'',
			'    always @(posedge clk_dst or negedge rst_n) begin',
			'        if (!rst_n) begin',
			'            meta     <= {WIDTH{1\'b0}};',
			'            out_sync <= {WIDTH{1\'b0}};',
			'        end else begin',
			'            meta     <= in_async;',
			'            out_sync <= meta;',
			'        end',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+edge\s*(detect|detector)?\s*$/i,
		label: 'gen edge detector — rising / falling pulse',
		languages: VERILOG_LANGS,
		body: [
			'',
			'    reg in_d;',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) in_d <= 1\'b0;',
			'        else        in_d <= in;',
			'    end',
			'',
			'    wire rise_pulse = ( in  & ~in_d);   // rising-edge 1-cycle pulse',
			'    wire fall_pulse = (~in  &  in_d);   // falling-edge 1-cycle pulse',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+fifo\s*$/i,
		label: 'gen fifo — sync FIFO (depth = 2^DEPTH_LOG2)',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module sync_fifo #(',
			'    parameter WIDTH      = 32,',
			'    parameter DEPTH_LOG2 = 4   // 16 entries',
			')(',
			'    input  wire              clk,',
			'    input  wire              rst_n,',
			'    input  wire              wr_en,',
			'    input  wire [WIDTH-1:0]  wr_data,',
			'    output wire              full,',
			'    input  wire              rd_en,',
			'    output reg  [WIDTH-1:0]  rd_data,',
			'    output wire              empty',
			');',
			'',
			'    localparam DEPTH = 1 << DEPTH_LOG2;',
			'    reg [WIDTH-1:0]      mem [0:DEPTH-1];',
			'    reg [DEPTH_LOG2:0]   wr_ptr, rd_ptr;',
			'',
			'    assign empty = (wr_ptr == rd_ptr);',
			'    assign full  = (wr_ptr[DEPTH_LOG2] != rd_ptr[DEPTH_LOG2]) &&',
			'                   (wr_ptr[DEPTH_LOG2-1:0] == rd_ptr[DEPTH_LOG2-1:0]);',
			'',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) begin',
			'            wr_ptr <= 0;',
			'            rd_ptr <= 0;',
			'        end else begin',
			'            if (wr_en && !full) begin',
			'                mem[wr_ptr[DEPTH_LOG2-1:0]] <= wr_data;',
			'                wr_ptr <= wr_ptr + 1\'b1;',
			'            end',
			'            if (rd_en && !empty) begin',
			'                rd_data <= mem[rd_ptr[DEPTH_LOG2-1:0]];',
			'                rd_ptr  <= rd_ptr + 1\'b1;',
			'            end',
			'        end',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+axi(4)?\s*-?\s*lite\s*(slave)?\s*$/i,
		label: 'gen axi-lite slave — AXI4-Lite skeleton',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module axi_lite_slave #(',
			'    parameter ADDR_WIDTH = 4,',
			'    parameter DATA_WIDTH = 32',
			')(',
			'    input  wire                    aclk,',
			'    input  wire                    aresetn,',
			'',
			'    // Write address',
			'    input  wire [ADDR_WIDTH-1:0]   awaddr,',
			'    input  wire                    awvalid,',
			'    output reg                     awready,',
			'',
			'    // Write data',
			'    input  wire [DATA_WIDTH-1:0]   wdata,',
			'    input  wire [DATA_WIDTH/8-1:0] wstrb,',
			'    input  wire                    wvalid,',
			'    output reg                     wready,',
			'',
			'    // Write response',
			'    output reg  [1:0]              bresp,',
			'    output reg                     bvalid,',
			'    input  wire                    bready,',
			'',
			'    // Read address',
			'    input  wire [ADDR_WIDTH-1:0]   araddr,',
			'    input  wire                    arvalid,',
			'    output reg                     arready,',
			'',
			'    // Read data',
			'    output reg  [DATA_WIDTH-1:0]   rdata,',
			'    output reg  [1:0]              rresp,',
			'    output reg                     rvalid,',
			'    input  wire                    rready',
			');',
			'',
			'    // TODO: register file',
			'    reg [DATA_WIDTH-1:0] reg0, reg1;',
			'',
			'    // TODO: write FSM (awready/wready/bvalid handshake)',
			'    // TODO: read  FSM (arready/rvalid handshake)',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+uart\s+tx\s*$/i,
		label: 'gen uart tx — 8N1 transmitter skeleton',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module uart_tx #(',
			'    parameter CLK_HZ   = 100_000_000,',
			'    parameter BAUD     = 115_200',
			')(',
			'    input  wire       clk,',
			'    input  wire       rst_n,',
			'    input  wire [7:0] tx_data,',
			'    input  wire       tx_valid,',
			'    output reg        tx_ready,',
			'    output reg        tx_pin',
			');',
			'',
			'    localparam DIVIDER = CLK_HZ / BAUD;',
			'',
			'    reg [3:0]  bit_cnt;',
			'    reg [$clog2(DIVIDER)-1:0] baud_cnt;',
			'    reg [9:0]  shift;          // {stop, 8 data, start}',
			'    reg        busy;',
			'',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) begin',
			'            tx_pin   <= 1\'b1;',
			'            tx_ready <= 1\'b1;',
			'            busy     <= 1\'b0;',
			'            bit_cnt  <= 0;',
			'            baud_cnt <= 0;',
			'            shift    <= 10\'h3FF;',
			'        end else if (!busy && tx_valid) begin',
			'            shift    <= {1\'b1, tx_data, 1\'b0};',
			'            busy     <= 1\'b1;',
			'            tx_ready <= 1\'b0;',
			'            bit_cnt  <= 0;',
			'            baud_cnt <= 0;',
			'        end else if (busy) begin',
			'            if (baud_cnt == DIVIDER-1) begin',
			'                baud_cnt <= 0;',
			'                tx_pin   <= shift[0];',
			'                shift    <= {1\'b1, shift[9:1]};',
			'                bit_cnt  <= bit_cnt + 1\'b1;',
			'                if (bit_cnt == 4\'d10) begin',
			'                    busy     <= 1\'b0;',
			'                    tx_ready <= 1\'b1;',
			'                end',
			'            end else baud_cnt <= baud_cnt + 1\'b1;',
			'        end',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+bram\s*$/i,
		label: 'gen bram — synchronous single-port block RAM',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module bram #(',
			'    parameter ADDR_WIDTH = 10,    // 1K depth',
			'    parameter DATA_WIDTH = 32',
			')(',
			'    input  wire                    clk,',
			'    input  wire                    we,',
			'    input  wire [ADDR_WIDTH-1:0]   addr,',
			'    input  wire [DATA_WIDTH-1:0]   din,',
			'    output reg  [DATA_WIDTH-1:0]   dout',
			');',
			'',
			'    (* ram_style = "block" *)',
			'    reg [DATA_WIDTH-1:0] mem [0:(1<<ADDR_WIDTH)-1];',
			'',
			'    always @(posedge clk) begin',
			'        if (we) mem[addr] <= din;',
			'        dout <= mem[addr];   // read-first synchronous read',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+(clk|clock)\s*-?\s*divider\s*$/i,
		label: 'gen clock divider — integer-N clock divider',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module clk_divider #(',
			'    parameter DIV = 4   // must be >= 2',
			')(',
			'    input  wire clk_in,',
			'    input  wire rst_n,',
			'    output reg  clk_out',
			');',
			'',
			'    reg [$clog2(DIV)-1:0] cnt;',
			'',
			'    always @(posedge clk_in or negedge rst_n) begin',
			'        if (!rst_n) begin',
			'            cnt     <= 0;',
			'            clk_out <= 1\'b0;',
			'        end else if (cnt == DIV/2 - 1) begin',
			'            cnt     <= 0;',
			'            clk_out <= ~clk_out;',
			'        end else cnt <= cnt + 1\'b1;',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+debounce(r)?\s*$/i,
		label: 'gen debouncer — push-button debouncer',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module debouncer #(',
			'    parameter CLK_HZ      = 100_000_000,',
			'    parameter STABLE_TIME = 10_000_000   // 10ms @ 100MHz',
			')(',
			'    input  wire clk,',
			'    input  wire rst_n,',
			'    input  wire btn_raw,',
			'    output reg  btn_clean',
			');',
			'',
			'    reg [$clog2(STABLE_TIME)-1:0] cnt;',
			'    reg                            btn_sync_0, btn_sync_1;',
			'',
			'    // CDC: 2-stage synchronizer for async push-button',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) {btn_sync_0, btn_sync_1} <= 2\'b00;',
			'        else        {btn_sync_1, btn_sync_0} <= {btn_sync_0, btn_raw};',
			'    end',
			'',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) begin',
			'            cnt       <= 0;',
			'            btn_clean <= 1\'b0;',
			'        end else if (btn_sync_1 != btn_clean) begin',
			'            if (cnt == STABLE_TIME-1) begin',
			'                btn_clean <= btn_sync_1;',
			'                cnt       <= 0;',
			'            end else cnt <= cnt + 1\'b1;',
			'        end else cnt <= 0;',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+(rr|round-?robin|round\s+robin)\s*(arbiter)?\s*$/i,
		label: 'gen round-robin arbiter — fair N-port grant',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module rr_arbiter #(',
			'    parameter N = 4',
			')(',
			'    input  wire           clk,',
			'    input  wire           rst_n,',
			'    input  wire [N-1:0]   req,',
			'    output reg  [N-1:0]   grant',
			');',
			'',
			'    reg [$clog2(N)-1:0] last;   // last granted index',
			'',
			'    integer i;',
			'    reg     found;',
			'    always @(*) begin',
			'        grant = {N{1\'b0}};',
			'        found = 1\'b0;',
			'        // Scan starting from (last+1), wrap around.',
			'        for (i = 1; i <= N; i = i + 1) begin',
			'            if (!found && req[(last + i) % N]) begin',
			'                grant[(last + i) % N] = 1\'b1;',
			'                found = 1\'b1;',
			'            end',
			'        end',
			'    end',
			'',
			'    always @(posedge clk or negedge rst_n) begin',
			'        if (!rst_n) last <= 0;',
			'        else if (|grant) begin',
			'            // Update last to whichever bit was granted.',
			'            for (i = 0; i < N; i = i + 1)',
			'                if (grant[i]) last <= i[$clog2(N)-1:0];',
			'        end',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+(one-?hot|onehot)\s+(encoder|encode)?\s*$/i,
		label: 'gen one-hot encoder — binary → one-hot',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module onehot_encoder #(',
			'    parameter WIDTH = 4   // output one-hot width; binary input = $clog2(WIDTH)',
			')(',
			'    input  wire [$clog2(WIDTH)-1:0] bin_in,',
			'    output reg  [WIDTH-1:0]          oh_out',
			');',
			'',
			'    integer i;',
			'    always @(*) begin',
			'        oh_out = {WIDTH{1\'b0}};',
			'        for (i = 0; i < WIDTH; i = i + 1)',
			'            if (bin_in == i[$clog2(WIDTH)-1:0]) oh_out[i] = 1\'b1;',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
	{
		trigger: /\/\/\s*gen\s+priority\s+(encoder|encode)?\s*$/i,
		label: 'gen priority encoder — MSB-first one-hot → binary',
		languages: VERILOG_LANGS,
		body: [
			'',
			'module priority_encoder #(',
			'    parameter WIDTH = 8',
			')(',
			'    input  wire [WIDTH-1:0]          req,',
			'    output reg                        valid,',
			'    output reg  [$clog2(WIDTH)-1:0]   idx',
			');',
			'',
			'    integer i;',
			'    always @(*) begin',
			'        valid = |req;',
			'        idx   = {$clog2(WIDTH){1\'b0}};',
			'        // Highest-index requestor wins.',
			'        for (i = 0; i < WIDTH; i = i + 1)',
			'            if (req[i]) idx = i[$clog2(WIDTH)-1:0];',
			'    end',
			'',
			'endmodule',
		].join('\n'),
	},
];

/**
 * Discoverability companion to the inline-completions provider: when the user
 * types `// gen ` (with at least one trailing space) in a Verilog/SystemVerilog
 * file, surface every chipos EDA snippet trigger as a regular completion
 * popup. Picking one completes the trigger comment, which then materializes
 * via the inline-completions ghost-text provider below.
 *
 * Without this, users had to read docs / use the picker quickPick to know
 * triggers exist; now the editor's standard completion popup teaches them.
 */
class ChipOSEdaTriggerCompletionsProvider implements CompletionItemProvider {

	readonly _debugDisplayName = 'chipos.edaTriggerCompletions';
	readonly triggerCharacters = [' '];

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	provideCompletionItems(
		model: ITextModel,
		position: Position,
		_context: CompletionContext,
		_token: CancellationToken,
	): CompletionList | null {
		const langId = model.getLanguageId();
		if (!VERILOG_LANGS.has(langId)) {
			return null;
		}
		const lineText = model.getLineContent(position.lineNumber);
		const beforeCursor = lineText.substring(0, position.column - 1);
		// Allow "// gen " plus any partial alphanumeric/dash suffix.
		const match = /^\s*\/\/\s*gen\s+([\w-]*)$/i.exec(beforeCursor);
		if (!match) {
			return null;
		}
		const [, partial] = match;
		const partialLower = partial.toLowerCase();

		const suggestions: CompletionItem[] = [];
		for (const snippet of SNIPPETS) {
			// Snippet label format: "gen <trigger> — <description>" (em dash separator).
			// 2026-05-20: use the unicode escape — instead of a literal em dash
			// in the regex. esbuild's `charset: 'ascii'` mode (set in
			// build/lib/optimize.ts and build/next/index.ts) does NOT transform
			// regex literals -- a literal em dash here survives all the way into
			// the minified workbench bundle and trips the post-minify non-ASCII
			// guard. The regex matches the SAME character either way (— is
			// U+2014 em dash), but the source is now pure ASCII.
			const labelMatch = /^gen\s+(.+?)\s+\u2014\s+(.+)$/.exec(snippet.label);
			if (!labelMatch) {
				continue;
			}
			const [, triggerName, description] = labelMatch;
			if (partialLower && !triggerName.toLowerCase().includes(partialLower)) {
				continue;
			}
			suggestions.push({
				label: { label: triggerName, description },
				insertText: triggerName,
				kind: CompletionItemKind.Snippet,
				range: new Range(
					position.lineNumber,
					position.column - partial.length,
					position.lineNumber,
					position.column,
				),
				sortText: triggerName,
				filterText: triggerName,
			});
		}
		this._logService.trace(`[ChipOS EdaTriggerCompletions] partial="${partial}" matched ${suggestions.length}`);
		return { suggestions };
	}
}

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

		// Companion: regular completion popup teaches users which `// gen …`
		// triggers exist. Restricted to Verilog/SV files (snippets are
		// Verilog-shaped) and shown only after the user types `// gen ` so
		// it doesn't compete with general IntelliSense in unrelated lines.
		const triggerProvider = new ChipOSEdaTriggerCompletionsProvider(logService);
		this._register(languageFeaturesService.completionProvider.register({ pattern: '**' }, triggerProvider));

		logService.info('[ChipOS] InlineCompletions provider registered (v1.5 — 14 magic-comment snippets + trigger-name discovery popup; LLM endpoint pending)');
	}
}

registerWorkbenchContribution2(ChipOSInlineCompletionsContribution.ID, ChipOSInlineCompletionsContribution, WorkbenchPhase.AfterRestored);

/** Public snapshot of all EDA snippets — used by the right-click
 *  "Insert EDA Snippet" quick pick (chiposEdaSnippetPicker.ts) to
 *  surface them without needing to remember magic-comment triggers. */
export function getChipOSEdaSnippets(): readonly IChipOSEdaSnippet[] {
	return SNIPPETS.map(s => ({ label: s.label, body: s.body, languages: s.languages }));
}
