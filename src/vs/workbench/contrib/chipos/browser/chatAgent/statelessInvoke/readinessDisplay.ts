/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Five-layer readiness DISPLAY (audit F-6, IDE leg) — the layered "为什么这个工作流现在跑不了"
 * breakdown the CLI shows as `/status` and the extension shows via `chipos.showReadiness`.
 *
 * The IDE workflow gate ({@link evaluateWorkflowGate}) blocks a doomed `/lint` `/sim` … with a
 * single actionable line; when it BLOCKS this appends the per-layer status so the user sees
 * exactly WHICH layer failed (connection / identity / worker pool / capability), rendered from
 * the SAME shared model ({@link deriveWorkflowReadiness}) the other two surfaces use — so the
 * layered verdict never drifts across CLI / extension / IDE.
 *
 * Pure (no workbench services): the gate maps its signals in, this renders the lines, so it is
 * unit-tested without a host. Chinese literals match the sibling gate messages (this module is
 * kept nls-free + dependency-light on purpose, exactly like workflowGate.ts).
 */

import { deriveWorkflowReadiness, type ReadinessInput, type ReadinessLevel } from './vendor/workflow/readiness.js';

/** ✓ / ! / ✗ / ? mark for a readiness level (shared by the L5 line + the layer rows). */
function levelMark(level: ReadinessLevel): string {
	switch (level) {
		case 'ready': return '✓';
		case 'degraded': case 'waiting': return '!';
		case 'blocked': return '✗';
		default: return '?';
	}
}

/**
 * Render the five-layer readiness as display lines (title + one row per layer + the L5 verdict).
 * `now` is injected for the register-window math (deterministic in tests).
 */
export function formatReadinessLines(i: ReadinessInput, now: number): string[] {
	const lines: string[] = ['就绪状态（五层，逐层独立核实）'];

	// L1 connection.
	const down = i.reachable === false || i.connectionState === 'error' || i.connectionState === 'disconnected';
	const connecting = i.connectionState === 'connecting' || i.connectionState === 'reconnecting';
	lines.push(`${down ? '✗' : connecting ? '!' : '✓'} 连接      ${down ? 'reasoner 连不上' : connecting ? '连接建立中' : 'reasoner 已连接'}`);

	// L2 identity.
	const authBad = i.authFailed || i.loggedIn === false;
	lines.push(`${authBad ? '✗' : '✓'} 身份      ${i.authFailed ? '登录已失效 (401)' : i.loggedIn === false ? '未登录' : '已登录'}`);

	// L3 worker pool (bare /health count).
	const pool = i.poolCount;
	lines.push(`${(pool ?? 0) > 0 ? '✓' : pool === 0 ? '✗' : '?'} worker 池 ${pool === undefined ? '未探测' : `${pool} 个在线`}${(pool ?? 0) > 0 ? '（数量≠本会话可用）' : ''}`);

	// L4 capability (registry verdict), when assessed.
	if (i.capability && i.capability.state !== 'unknown') {
		const c = i.capability;
		const detail =
			c.state === 'bound' ? `本工作区已绑定 (${c.bound?.worker_id ?? 'worker'})`
				: c.state === 'generic' ? `通用 worker ×${c.genericCount} 可承接`
					: c.state === 'mismatch' ? `${c.total} 个在线但均绑定其它工作区`
						: '0 个 worker 在线';
		const mark = c.state === 'bound' || c.state === 'generic' ? '✓' : c.state === 'mismatch' ? '!' : '✗';
		lines.push(`${mark} 工具能力  ${detail}`);
	}

	// L5 composite verdict.
	const r = deriveWorkflowReadiness(i, now);
	lines.push(`${levelMark(r.level)} 就绪      ${r.reason}`);
	return lines;
}
