/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * `subagentCard` unit tests — lock the pure bookkeeping that turns stateless
 * `subagent_event` frames into the `IChatExternalToolInvocationUpdate` parts
 * that drive the native `ChatSubagentContentPart` collapsible card:
 *   - the parent card is synthesized exactly once per role;
 *   - each tool_start nests a child tagged with the parent card id;
 *   - tool_end pairs FIFO with the matching tool_start (so a role running the
 *     same tool twice still pairs ends to the right starts);
 *   - file-write tool_starts surface an external-edit intent;
 *   - end-of-turn finalize closes dangling children + parents and resets state.
 */

import assert from 'assert';
import type { DispatchResult } from '../eventDispatcher.js';
import { computeSubagentFinalizeUpdates, computeSubagentToolUpdates, createSubagentCardState } from '../subagentCard.js';

type SubagentFrame = NonNullable<DispatchResult['subagentEvent']>;

function frame(partial: Partial<SubagentFrame> & Pick<SubagentFrame, 'taskId' | 'kind'>): SubagentFrame {
	return {
		toolName: undefined,
		args: undefined,
		filePath: undefined,
		snapshotContent: undefined,
		...partial,
	};
}

// Stub injectables: identity friendly-name, a recognizable arg formatter, and
// `edit_file` as the only file-write tool.
const friendly = (raw: string) => raw;
const formatArgs = (args: Record<string, unknown> | undefined) => typeof args?.file_path === 'string' ? args.file_path : '';
const isFileWrite = (toolName: string) => toolName === 'edit_file';

// Compact projection of the fields that matter for grouping/rendering.
function proj(updates: ReadonlyArray<{ toolCallId: string; toolName: string; isComplete: boolean; subagentInvocationId?: string; invocationMessage?: unknown; pastTenseMessage?: unknown; toolSpecificData?: { kind: string } }>) {
	return updates.map(u => {
		const raw = u.invocationMessage ?? u.pastTenseMessage;
		// Child labels are now IMarkdownString ({ value }) so the file/command
		// renders monospace; unwrap to the plain value for assertions.
		const message = (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>))
			? (raw as { value: string }).value
			: raw;
		return {
			toolCallId: u.toolCallId,
			toolName: u.toolName,
			isComplete: u.isComplete,
			subagentInvocationId: u.subagentInvocationId,
			toolSpecificKind: u.toolSpecificData?.kind,
			message,
		};
	});
}

suite('subagentCard.computeSubagentToolUpdates', () => {

	test('first tool_start synthesizes the parent card then the nested child', () => {
		const state = createSubagentCardState();
		const r = computeSubagentToolUpdates(
			frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'read_file', args: { file_path: 'rtl/a.v' } }),
			state, friendly, formatArgs, isFileWrite,
		);
		assert.deepStrictEqual(proj(r.updates), [
			// parent: subagent toolSpecificData, NO subagentInvocationId → card header
			{ toolCallId: 'substateless_parent_rtl-coder', toolName: 'task', isComplete: false, subagentInvocationId: undefined, toolSpecificKind: 'subagent', message: 'Delegating to rtl-coder' },
			// child: tagged with the parent card id → nests inside the card
			{ toolCallId: 'substateless_rtl-coder_read_file_0', toolName: 'read_file', isComplete: false, subagentInvocationId: 'substateless_parent_rtl-coder', toolSpecificKind: undefined, message: 'read_file `rtl/a.v`' },
		]);
		// read_file is not a file-write tool → no external-edit intent.
		assert.strictEqual(r.startEdit, undefined);
	});

	test('parent synthesized once per role; child keys are stable-unique per (role, tool)', () => {
		const state = createSubagentCardState();
		computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'read_file' }), state, friendly, formatArgs, isFileWrite);
		const r2 = computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'read_file' }), state, friendly, formatArgs, isFileWrite);
		// No second parent; child counter advanced.
		assert.deepStrictEqual(proj(r2.updates), [
			{ toolCallId: 'substateless_rtl-coder_read_file_1', toolName: 'read_file', isComplete: false, subagentInvocationId: 'substateless_parent_rtl-coder', toolSpecificKind: undefined, message: 'read_file' },
		]);
	});

	test('tool_end pairs FIFO with the matching tool_start', () => {
		const state = createSubagentCardState();
		// Two concurrent edit_file starts, then two ends — ends pair to starts in order.
		computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file', args: { file_path: 'a.v' } }), state, friendly, formatArgs, isFileWrite);
		computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file', args: { file_path: 'b.v' } }), state, friendly, formatArgs, isFileWrite);
		const end1 = computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_end', toolName: 'edit_file', filePath: 'a.v' }), state, friendly, formatArgs, isFileWrite);
		const end2 = computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_end', toolName: 'edit_file', filePath: 'b.v' }), state, friendly, formatArgs, isFileWrite);
		assert.deepStrictEqual(
			[end1.stopEditChildKey, end2.stopEditChildKey],
			['substateless_rtl-coder_edit_file_0', 'substateless_rtl-coder_edit_file_1'],
		);
		assert.deepStrictEqual(proj(end1.updates), [
			{ toolCallId: 'substateless_rtl-coder_edit_file_0', toolName: 'edit_file', isComplete: true, subagentInvocationId: 'substateless_parent_rtl-coder', toolSpecificKind: undefined, message: 'edit_file `a.v`' },
		]);
	});

	test('tool_end appends the reasoner result badge after the "verb `object`" label', () => {
		const state = createSubagentCardState();
		computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'read_file', args: { file_path: 'rtl/x.v' } }), state, friendly, formatArgs, isFileWrite);
		const end = computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_end', toolName: 'read_file', result: '12 行' }), state, friendly, formatArgs, isFileWrite);
		assert.deepStrictEqual(proj(end.updates), [
			{ toolCallId: 'substateless_rtl-coder_read_file_0', toolName: 'read_file', isComplete: true, subagentInvocationId: 'substateless_parent_rtl-coder', toolSpecificKind: undefined, message: 'read_file `rtl/x.v` · 12 行' },
		]);
	});

	test('tool_end with no open child emits nothing extra (parent already exists)', () => {
		const state = createSubagentCardState();
		computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'read_file' }), state, friendly, formatArgs, isFileWrite);
		const end = computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_end', toolName: 'grep' }), state, friendly, formatArgs, isFileWrite);
		assert.deepStrictEqual(end.updates, []);
		assert.strictEqual(end.stopEditChildKey, undefined);
	});

	test('file-write tool_start surfaces a startEdit intent carrying the file path + snapshot', () => {
		const state = createSubagentCardState();
		const r = computeSubagentToolUpdates(
			frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file', args: { file_path: 'rtl/foo.v' }, snapshotContent: 'before' }),
			state, friendly, formatArgs, isFileWrite,
		);
		assert.deepStrictEqual(r.startEdit, {
			childKey: 'substateless_rtl-coder_edit_file_0',
			filePath: 'rtl/foo.v',
			snapshotContent: 'before',
		});
	});
});

suite('subagentCard.computeSubagentFinalizeUpdates', () => {

	test('closes dangling children then parents and clears the state', () => {
		const state = createSubagentCardState();
		// rtl-coder: one open child (no tool_end). lint-fixer: parent only.
		computeSubagentToolUpdates(frame({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'read_file' }), state, friendly, formatArgs, isFileWrite);
		computeSubagentToolUpdates(frame({ taskId: 'lint-fixer', kind: 'tool_end', toolName: 'noop' }), state, friendly, formatArgs, isFileWrite);

		const finalize = computeSubagentFinalizeUpdates(state, friendly);
		assert.deepStrictEqual(proj(finalize), [
			// dangling child closed first…
			{ toolCallId: 'substateless_rtl-coder_read_file_0', toolName: 'read_file', isComplete: true, subagentInvocationId: 'substateless_parent_rtl-coder', toolSpecificKind: undefined, message: 'read_file' },
			// …then each parent (no toolSpecificData → preserves the subagent header).
			{ toolCallId: 'substateless_parent_rtl-coder', toolName: 'task', isComplete: true, subagentInvocationId: undefined, toolSpecificKind: undefined, message: 'Sub-agent completed' },
			{ toolCallId: 'substateless_parent_lint-fixer', toolName: 'task', isComplete: true, subagentInvocationId: undefined, toolSpecificKind: undefined, message: 'Sub-agent completed' },
		]);
		// State fully reset → a re-finalize is a no-op.
		assert.deepStrictEqual(computeSubagentFinalizeUpdates(state, friendly), []);
	});
});
