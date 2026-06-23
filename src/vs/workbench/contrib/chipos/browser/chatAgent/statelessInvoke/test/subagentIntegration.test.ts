/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Feature #9 — subagent end-to-end integration (IDE side, host-agnostic).
 *
 * The full `@name` → delegation → tool-whitelist-block flow spans three pure
 * building blocks that `chipOSChatAgent` only wires I/O around. The big chat
 * agent (5.7k LOC of VS Code DI) can't run in the unit harness, so this test
 * chains the SAME pure stages the agent uses, asserting the three feature
 * claims as ONE traversal:
 *
 *   1. ROUTING — a user message `@rtl-coder ...` resolves to that agent and,
 *      because its frontmatter declares `mode: subagent` with a restricted
 *      `tools` list, the turn builds a `selected_agent` request field that
 *      carries the isolation flag + the allow-list to the reasoner. A typo'd
 *      mode degrades (no isolation) and is detectable, not silently swallowed.
 *
 *   2. ACTIVE CARD — the reasoner's `subagent_event` frames fold into the
 *      `ChatSubagentContentPart` parent card + nested child tool rows that
 *      render the delegation live.
 *
 *   3. WHITELIST HARD-BLOCK (non-silent) — when the read-only sub-role attempts
 *      `write_file`, the reasoner blocks it AT DISPATCH (role_tool_filter, never
 *      forwarded to the worker) and surfaces the block message back as the
 *      tool's result. The IDE must render that rejection VISIBLY on the child
 *      row (a "· blocked …" badge), NOT drop it silently. We assert both the
 *      card-path surfacing (subagent_event result badge) AND the top-level
 *      `tool_result` errorKind passthrough the dispatcher provides.
 *
 * Reasoner-side enforcement itself (the dispatch refusal) is pinned in
 * backend_v2 reasoning tests (test_remote_tool_proxy_role_filter.py,
 * test_feat005_user_subagent.py); here we lock the IDE-side contract that
 * consumes it.
 */

import assert from 'assert';
import { dispatchStatelessEvent, type DispatchResult } from '../eventDispatcher.js';
import type { InvokeEvent } from '../types.js';
import {
	buildSelectedAgent,
	computeSubagentToolUpdates,
	createSubagentCardState,
	isSubagentMode,
	parseAgentMention,
} from '../subagentCard.js';

function ev(type: InvokeEvent['type'], data: Record<string, unknown> = {}, sequence_id = 1): InvokeEvent {
	return { type, sequence_id, data };
}

// Pure-helper stubs mirroring chipOSChatAgent's wiring: identity friendly name,
// a file_path arg formatter, and write_file as the only file-write tool.
const friendly = (raw: string) => raw;
const formatArgs = (args: Record<string, unknown> | undefined) => (typeof args?.file_path === 'string' ? args.file_path : '');
const isFileWrite = (toolName: string) => toolName === 'write_file' || toolName === 'edit_file';

/** Unwrap an IMarkdownString-or-string label to its plain text for assertions. */
function text(raw: unknown): string | undefined {
	if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
		return (raw as { value: string }).value;
	}
	return raw as string | undefined;
}

suite('subagent integration (Feature #9): @name → delegate → whitelist hard-block', () => {

	// ── Stage 1: routing ────────────────────────────────────────────────────

	test('1. an @<name> mention with mode:subagent + restricted tools builds an isolated selected_agent', () => {
		// chipOSChatAgent.ts:3612 parses the mention; resources/chiposAgentsService
		// resolves the .chipos/agents/rtl-coder.md frontmatter into this definition.
		const agentName = parseAgentMention('@rtl-coder please fix the testbench', new Set());
		assert.strictEqual(agentName, 'rtl-coder', 'the @mention resolves to the agent name');

		const def = {
			name: 'rtl-coder',
			instructions: 'You are a Verilog reviewer. Read only.',
			description: 'read-only RTL reviewer',
			mode: 'subagent',
			tools: ['read_file', 'grep'],
		};

		// The isolation gate the IDE and reasoner agree on (subagentCard.SUBAGENT_MODE
		// ⇔ agent_core._normalize_agent_mode == "subagent").
		assert.ok(isSubagentMode(def.mode), 'mode:subagent routes to the isolated sub-role, not a persona overlay');

		const selected = buildSelectedAgent(def);
		assert.deepStrictEqual(selected, {
			name: 'rtl-coder',
			instructions: 'You are a Verilog reviewer. Read only.',
			description: 'read-only RTL reviewer',
			tools: ['read_file', 'grep'],
			mode: 'subagent',
		}, 'the request carries the persona + the tool allow-list + the isolation flag to the reasoner');
	});

	test('1b. a typo mode degrades to a persona overlay (detectable, not silently isolated)', () => {
		// A non-canonical spelling must read as NOT-subagent so chipOSChatAgent can
		// warn the author instead of silently running with zero tool gating.
		assert.strictEqual(isSubagentMode('sub-agent'), false);
		assert.strictEqual(isSubagentMode('subagnt'), false);
		// The definition still travels (persona overlay on the MAIN agent), so the
		// turn is not lost — it just isn't isolated.
		const selected = buildSelectedAgent({ name: 'x', instructions: 'p', mode: 'sub-agent' });
		assert.strictEqual(selected.mode, 'sub-agent', 'the raw mode survives so the IDE can detect + warn');
	});

	test('1c. an @stem that names an attached file is NOT treated as an agent mention', () => {
		// chipos repurposes `@` for file attachments; a file whose stem matches an
		// agent must not hijack the turn into that persona.
		assert.strictEqual(parseAgentMention('look at @counter the bug', new Set(['counter'])), undefined);
		assert.strictEqual(parseAgentMention('look at @counter the bug', new Set()), 'counter');
	});

	// ── Stages 2 + 3: active card render + whitelist hard-block surfacing ────

	test('2+3. delegation renders a live card and the blocked write_file surfaces VISIBLY (non-silent)', () => {
		const state = createSubagentCardState();
		const role = 'rtl-coder';

		// The sub-role's first (allowed) tool: read_file. First frame synthesizes
		// the parent card; the tool_start nests a child under it.
		const readStart = computeSubagentToolUpdates(
			subEvt({ taskId: role, kind: 'tool_start', toolName: 'read_file', args: { file_path: 'rtl/counter.v' } }),
			state, friendly, formatArgs, isFileWrite,
		);
		const parentUpdate = readStart.updates.find(u => u.toolName === 'task');
		assert.ok(parentUpdate, 'Stage 2: a parent delegation card is synthesized for the sub-role');
		assert.strictEqual(
			(parentUpdate!.toolSpecificData as { agentName?: string } | undefined)?.agentName, role,
			'the card header names the delegated sub-role',
		);
		const readChild = readStart.updates.find(u => u.toolName === 'read_file');
		assert.ok(readChild, 'Stage 2: the read_file step nests as a child tool row');
		assert.strictEqual(readChild!.subagentInvocationId, parentUpdate!.toolCallId, 'the child is tagged with the parent card id');

		// Now the sub-role ATTEMPTS write_file. The reasoner blocked it at dispatch
		// (role_tool_filter) and never ran it; the block message arrives as the
		// tool's result on the tool_end frame. (The tool_start still renders so the
		// user sees the attempt; what matters is the visible block on completion.)
		computeSubagentToolUpdates(
			subEvt({ taskId: role, kind: 'tool_start', toolName: 'write_file', args: { file_path: 'rtl/counter.v' } }),
			state, friendly, formatArgs, isFileWrite,
		);
		const blockMsg = "Tool 'write_file' is not permitted for this sub-role";
		const writeEnd = computeSubagentToolUpdates(
			subEvt({ taskId: role, kind: 'tool_end', toolName: 'write_file', result: `🚫 ${blockMsg}` }),
			state, friendly, formatArgs, isFileWrite,
		);
		const blockedRow = writeEnd.updates.find(u => u.toolName === 'write_file' && u.isComplete);
		assert.ok(blockedRow, 'the blocked write_file completes a child row (not silently dropped)');
		const label = text(blockedRow!.pastTenseMessage) ?? '';
		assert.ok(
			label.includes(blockMsg),
			`Stage 3: the whitelist block is rendered on the row, VISIBLE to the user (got: "${label}")`,
		);
	});

	test('3b. a top-level tool_result with error_kind role_tool_filter passes the errorKind through (badge, not a silent pass)', () => {
		// On paths where the block surfaces as a top-level tool_result (rather than
		// a subagent_event), the dispatcher must propagate is_error + error_kind so
		// the renderer shows a block badge — the SAME contract as hook_deny.
		const r: DispatchResult = dispatchStatelessEvent(ev('tool_result', {
			tool_id: 'tc-w',
			tool_name: 'write_file',
			content: "Tool 'write_file' is not permitted for this sub-role",
			is_error: true,
			error_kind: 'role_tool_filter',
		}));
		assert.deepStrictEqual(r, {
			toolInvocation: {
				callId: 'tc-w',
				isComplete: true,
				outputPreview: "Tool 'write_file' is not permitted for this sub-role",
				isError: true,
				errorKind: 'role_tool_filter',
			},
		}, 'the block is surfaced as an errored tool result with the role_tool_filter kind — never swallowed');
	});
});

// ── helper ──────────────────────────────────────────────────────────────────

type SubFrame = NonNullable<DispatchResult['subagentEvent']>;
function subEvt(partial: Partial<SubFrame> & Pick<SubFrame, 'taskId' | 'kind'>): SubFrame {
	return { toolName: undefined, args: undefined, filePath: undefined, snapshotContent: undefined, result: undefined, ...partial };
}
