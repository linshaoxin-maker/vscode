/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * subagentCard — pure builders that fold stateless `subagent_event` directives
 * into the `IChatExternalToolInvocationUpdate` parts that drive the native
 * `ChatSubagentContentPart` collapsible card.
 *
 * WHY PURE: on the fused agent_core path the reasoner delegates to composite
 * roles (e.g. `lint_fix_loop` → `rtl-coder`) reasoner-side, so — unlike the
 * agentic path's real model `task` tool call — there is NO parent tool call to
 * anchor the card on. The FIRST frame per role synthesizes a PARENT subagent
 * toolInvocation (the card header, named after the role) and each `tool_start`
 * / `tool_end` becomes a CHILD toolInvocation tagged with the card id
 * (`subagentInvocationId`) so the renderer nests it inside that card. This
 * module owns the bookkeeping — parent-synthesized-once, FIFO child pairing,
 * end-of-turn finalize — as dependency-light functions, so `chipOSChatAgent`
 * only does the I/O (emit progress + drive the editing session). Mirrors the
 * pure `dispatchStatelessEvent` so the branching logic stays unit-testable.
 *
 * The chat-service imports are TYPE-ONLY, so this stays runtime-decoupled.
 */

import { localize } from '../../../../../../nls.js';
import type { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { buildToolRowLabel, withResultBadge } from './toolRowFormat.js';
import type { DispatchResult } from './eventDispatcher.js';
import type { IChatExternalToolInvocationUpdate, IChatSubagentToolInvocationData } from '../../../../chat/common/chatService/chatService.js';

/**
 * Turn-scoped bookkeeping for the sub-agent cards rendered this invoke. Owned
 * by the calling `_invokeStateless` closure and reset per invoke.
 */
export interface ISubagentCardState {
	/** role (task_id) → synthesized parent card toolCallId. */
	readonly parentIds: Map<string, string>;
	/** `${role}::${tool}` → FIFO queue of open child toolCallIds (pairs each tool_end with the matching tool_start). */
	readonly openChildren: Map<string, string[]>;
	/** `${role}::${tool}` → monotonic counter for stable-unique child keys. */
	readonly childSeq: Map<string, number>;
	/**
	 * childKey → the markdown label built at `tool_start` ("verb `object`").
	 * The `tool_end` frame carries no args, so without this the completed row
	 * would collapse back to the bare verb (e.g. "读取文件") and lose the file it
	 * acted on. We stash the start-time label and reuse it as the pastTense
	 * message so a finished row still reads "读取文件 `card_demo_buggy.v`".
	 */
	readonly childLabels: Map<string, IMarkdownString>;
	/** role → number of tool steps the sub-agent ran (drives the card header "· N 步"). */
	readonly cardSteps: Map<string, number>;
}

export function createSubagentCardState(): ISubagentCardState {
	return { parentIds: new Map(), openChildren: new Map(), childSeq: new Map(), childLabels: new Map(), cardSteps: new Map() };
}

/**
 * Build the child-row label as markdown so the object (file path / command /
 * pattern) renders monospace — matching how Cursor / Claude Code / Codex show
 * `Read <file>` with the target in code style. `friendly` stays plain; only the
 * detail is wrapped in an inline-code span (callers already delimit commands
 * with backticks / patterns with slashes, so a bare path is the common case).
 */
/** Result of folding one `subagent_event` frame into card updates. */
export interface ISubagentToolUpdates {
	/** toolInvocation progress parts to emit, in order (parent before child). */
	readonly updates: IChatExternalToolInvocationUpdate[];
	/** tool_start on a file-write tool with a resolvable path → caller should start an external edit for this child. */
	readonly startEdit?: { readonly childKey: string; readonly filePath: string; readonly snapshotContent?: string };
	/** tool_end → caller should stop the external edit for this child (if one was started). */
	readonly stopEditChildKey?: string;
}

function queueKeyOf(role: string, toolName: string): string {
	return `${role}::${toolName}`;
}

/**
 * Fold one `subagent_event` frame into the card updates. Mutates `state`
 * (parent map / FIFO child queues / per-tool counter). Deterministic: the same
 * frame sequence on a fresh state always yields the same ids.
 */
export function computeSubagentToolUpdates(
	evt: NonNullable<DispatchResult['subagentEvent']>,
	state: ISubagentCardState,
	friendlyToolName: (raw: string) => string,
	formatArgs: (args: Record<string, unknown> | undefined) => string,
	isFileWriteTool: (toolName: string) => boolean,
	resolveLinkPath?: (args: Record<string, unknown> | undefined) => string | undefined,
): ISubagentToolUpdates {
	const role = evt.taskId;
	const updates: IChatExternalToolInvocationUpdate[] = [];

	// Synthesize the parent card on the first frame for this role. No model
	// `task` tool call exists on this path, so we own the card header.
	let parentId = state.parentIds.get(role);
	if (!parentId) {
		parentId = `substateless_parent_${role}`;
		state.parentIds.set(role, parentId);
		updates.push({
			kind: 'externalToolInvocationUpdate',
			toolCallId: parentId,
			toolName: 'task',
			isComplete: false,
			invocationMessage: localize('chipos.subagent.delegating', "Delegating to {0}", role),
			toolSpecificData: {
				kind: 'subagent',
				description: localize('chipos.subagent.delegatedTask', "Delegated task"),
				agentName: role,
			} satisfies IChatSubagentToolInvocationData,
		});
	}

	const toolName = evt.toolName ?? 'tool';
	const friendly = friendlyToolName(toolName);
	const qKey = queueKeyOf(role, toolName);

	if (evt.kind === 'tool_start') {
		const seq = state.childSeq.get(qKey) ?? 0;
		state.childSeq.set(qKey, seq + 1);
		state.cardSteps.set(role, (state.cardSteps.get(role) ?? 0) + 1);
		const childKey = `substateless_${role}_${toolName}_${seq}`;
		const queue = state.openChildren.get(qKey);
		if (queue) {
			queue.push(childKey);
		} else {
			state.openChildren.set(qKey, [childKey]);
		}

		const argDetail = formatArgs(evt.args);
		const label = buildToolRowLabel(friendly, argDetail, resolveLinkPath?.(evt.args));
		state.childLabels.set(childKey, label);
		updates.push({
			kind: 'externalToolInvocationUpdate',
			toolCallId: childKey,
			toolName,
			isComplete: false,
			invocationMessage: label,
			subagentInvocationId: parentId,
		});

		// File-write tool with a resolvable path → ask the caller to drive the
		// editing session so the file diff renders inside the card.
		if (isFileWriteTool(toolName) && evt.args) {
			const raw = evt.args.file_path ?? evt.args.path ?? evt.args.file ?? evt.args.file_name;
			if (typeof raw === 'string' && raw) {
				return { updates, startEdit: { childKey, filePath: raw, snapshotContent: evt.snapshotContent } };
			}
		}
		return { updates };
	}

	// tool_end → complete the oldest matching open child (FIFO pairing, so a
	// role that runs the same tool twice still pairs ends to the right starts).
	const queue = state.openChildren.get(qKey);
	const childKey = queue?.shift();
	if (queue && queue.length === 0) {
		state.openChildren.delete(qKey);
	}
	if (!childKey) {
		return { updates }; // tool_end with no matching tool_start — defensive.
	}
	// Reuse the start-time "verb `object`" label so the finished row keeps the
	// file/command it acted on (the tool_end frame carries no args), then append
	// the terse outcome ("· ✓ 通过" / "· 12 行") the reasoner derived — the
	// "verb object result" triple the reference tools all show. Falls back to the
	// bare verb only if the start label was somehow never recorded.
	const startLabel = state.childLabels.get(childKey)
		?? ({ value: friendly, supportThemeIcons: false } as IMarkdownString);
	state.childLabels.delete(childKey);
	const endLabel = withResultBadge(startLabel, evt.result);
	updates.push({
		kind: 'externalToolInvocationUpdate',
		toolCallId: childKey,
		toolName,
		isComplete: true,
		pastTenseMessage: endLabel,
		subagentInvocationId: parentId,
	});
	return { updates, stopEditChildKey: childKey };
}

/**
 * End-of-turn: close any cards still open (the stateless path has no `complete`
 * frame). Returns completion updates for each dangling child (whose `tool_end`
 * never arrived) followed by each parent card, then clears the state.
 * Completing the parent WITHOUT `toolSpecificData` PRESERVES its existing
 * subagent data in the model (it only replaces when a new value is supplied),
 * so the card stays grouped on re-render.
 */
export function computeSubagentFinalizeUpdates(
	state: ISubagentCardState,
	friendlyToolName: (raw: string) => string,
): IChatExternalToolInvocationUpdate[] {
	const updates: IChatExternalToolInvocationUpdate[] = [];
	for (const [qKey, childKeys] of state.openChildren) {
		const sep = qKey.indexOf('::');
		const role = qKey.slice(0, sep);
		const toolName = qKey.slice(sep + 2);
		const parentId = state.parentIds.get(role);
		for (const childKey of childKeys) {
			updates.push({
				kind: 'externalToolInvocationUpdate',
				toolCallId: childKey,
				toolName,
				isComplete: true,
				pastTenseMessage: state.childLabels.get(childKey) ?? friendlyToolName(toolName),
				subagentInvocationId: parentId,
			});
		}
	}
	state.openChildren.clear();
	state.childSeq.clear();
	state.childLabels.clear();
	for (const [role, parentId] of state.parentIds) {
		const steps = state.cardSteps.get(role) ?? 0;
		// Supplying toolSpecificData REPLACES the card's subagent data, so the
		// collapsed header self-describes ("rtl-coder · 3 步 · 完成") instead of the
		// static "Delegated task" placeholder. (Goal/verdict need a reasoner
		// `goal`/`status` field — follow-up; step count is derivable today.)
		updates.push({
			kind: 'externalToolInvocationUpdate',
			toolCallId: parentId,
			toolName: 'task',
			isComplete: true,
			pastTenseMessage: steps > 0
				? localize('chipos.subagent.doneSteps', "{0} · {1} 步 · 完成", role, steps)
				: localize('chipos.subagent.completed', "{0} · 完成", role),
			toolSpecificData: {
				kind: 'subagent',
				agentName: role,
				description: steps > 0
					? localize('chipos.subagent.doneDesc', "{0} 步 · 完成", steps)
					: localize('chipos.subagent.doneDescNoSteps', "完成"),
			} satisfies IChatSubagentToolInvocationData,
		});
	}
	state.parentIds.clear();
	state.cardSteps.clear();
	return updates;
}
