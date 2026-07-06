/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-side AI4EDA workflow PREFLIGHT gate (audit F-6, IDE leg).
 *
 * The IDE dispatched `/lint` `/sim` … straight into the stateless invoke with no
 * readiness check — so a workflow launched at a reasoner with NO online worker burned a
 * real turn on tool timeouts and then the model FABRICATED a report (a false-green worse
 * than an error). This wires the IDE into the SAME canonical decision the CLI + extension
 * use ({@link decideWorkflowPreflight}, vendored), so the gate verdict never drifts.
 *
 * Honest scope (IDE leg): the natural signal at the invoke chokepoint is the reasoner's
 * remote worker-pool size (workers_connected) — so this gates the no-worker case. The
 * connection / login layers are handled by the IDE's own stream-error + auth flows.
 */

import { decideWorkflowPreflight, type PreflightSignals, type PreflightReason } from './vendor/workflow/preflight.js';
import { type ReadinessInput } from './vendor/workflow/readiness.js';
import { formatReadinessLines } from './readinessDisplay.js';

/**
 * The 7 canonical AI4EDA workflow commands (mirrors packages/cockpit-core AI4EDA_WORKFLOWS
 * / the IDE's cockpit/core/workflows.ts). Inlined so this stays a dependency-light,
 * unit-testable module — keep in sync with the shared catalog.
 */
export const AI4EDA_WORKFLOW_COMMANDS: readonly string[] = [
	'/lint', '/sim', '/synth', '/ppa', '/cov', '/tb', '/review',
];

/** Return the matched `/command` when `query` starts an AI4EDA workflow, else null. */
export function matchWorkflowCommand(query: string): string | null {
	const q = query.trimStart();
	for (const command of AI4EDA_WORKFLOW_COMMANDS) {
		if (q === command || q.startsWith(command + ' ')) {
			return command;
		}
	}
	return null;
}

export interface WorkflowGateVerdict {
	readonly command: string;
	/** True when the dispatch is CERTAIN to fail and should be halted. */
	readonly block: boolean;
	/** True when the deps are unready but a send MIGHT still work → confirm with the user. */
	readonly ask: boolean;
	readonly reason: PreflightReason;
	/** A user-facing, actionable message for a blocked/asked dispatch (empty otherwise). */
	readonly message: string;
}

/**
 * Evaluate a workflow dispatch. Returns null when `query` is NOT an AI4EDA workflow (the
 * gate never touches ordinary chat). With `remoteWorkers` in the signals, `ask` fires only
 * when the pool is empty — so a ready dispatch is never interrupted.
 */
export function evaluateWorkflowGate(query: string, signals: PreflightSignals, now: number = Date.now()): WorkflowGateVerdict | null {
	const command = matchWorkflowCommand(query);
	if (!command) {
		return null;
	}
	const decision = decideWorkflowPreflight(signals);
	const block = decision.action === 'block';
	const ask = decision.action === 'ask';
	return {
		command,
		block,
		ask,
		reason: decision.reason,
		// On a hard BLOCK, append the five-layer breakdown (audit F-6 display) so the user
		// sees WHICH layer failed — rendered from the SAME shared model the CLI /status and
		// the extension render, single-sourced. The concise top line stays the actionable ask.
		message: block ? `${blockMessage(command, decision.reason)}\n\n${formatReadinessLines(signalsToReadinessInput(signals), now).join('\n')}`
			: ask ? askMessage(command) : '',
	};
}

/**
 * Map the gate's preflight signals onto the readiness-display input (remoteWorkers → poolCount).
 * Capability is intentionally NOT forwarded: `PreflightSignals.capability` is a bare state STRING
 * whereas the display's `ReadinessInput.capability` is the richer `{state, bound, genericCount,
 * total}` object — different shapes. The invoke-chokepoint gate only ever supplies the
 * connection / identity / worker-pool layers anyway (it has no registry assessment), so L4 stays
 * unassessed and the display omits that row rather than mis-rendering a string as an object.
 */
function signalsToReadinessInput(s: PreflightSignals): ReadinessInput {
	return {
		connectionState: s.connectionState,
		authFailed: s.authFailed,
		loggedIn: s.loggedIn,
		poolCount: s.remoteWorkers,
	};
}

function blockMessage(command: string, reason: PreflightReason): string {
	switch (reason) {
		case 'connection-down':
			return `ChipOS: 与 reasoner 的连接已断，${command} 现在发不出去。恢复连接后重试。`;
		case 'auth-failed':
			return `ChipOS: 登录凭据被拒 (401)，${command} 无法执行。请重新登录。`;
		case 'logged-out':
			return `ChipOS: 未登录，${command} 需要登录后 worker 才能注册工具。请先登录。`;
		case 'deterministic-no-worker':
			return `ChipOS: 本会话无可用 worker，${command} 发送必然空转（工具失败后模型会凭源码臆造结果）。启动 worker 后重试。`;
		default:
			return `ChipOS: ${command} 的 EDA 依赖未就绪。`;
	}
}

/** The confirm prompt shown when a workflow's EDA deps are unready but a send may work. */
export function askMessage(command: string): string {
	return `${command} 的 EDA 依赖未就绪（当前无在线 worker）。仍要发送吗？`;
}

// ── remote worker-pool probe (workers_connected) ───────────────────────────────────────

/** Parse `workers_connected` from a /health body. Undefined when absent/unusable. */
export function parseWorkersConnected(body: unknown): number | undefined {
	if (!body || typeof body !== 'object') {
		return undefined;
	}
	const v = (body as Record<string, unknown>).workers_connected;
	return typeof v === 'number' && isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Best-effort GET `<baseUrl>/health` → the `workers_connected` count (undefined on any
 * failure). NEVER throws — an undefined result leaves `remoteWorkers` unknown, which the
 * shared decision treats as "no pool signal" rather than a false verdict.
 */
export async function probeWorkersConnected(
	baseUrl: string | undefined,
	token: string | undefined,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 2500,
): Promise<number | undefined> {
	if (!baseUrl) {
		return undefined;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => {
		try { controller.abort(); } catch { /* best-effort */ }
	}, timeoutMs);
	try {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		const resp = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, { method: 'GET', headers, signal: controller.signal });
		if (!resp.ok) {
			return undefined;
		}
		return parseWorkersConnected(await resp.json());
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
