/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure exponential-backoff policy for self-healing a dropped local worker.
 *
 * Historically a worker that died mid-session only surfaced a manual
 * "Worker: Reconnect" status-bar button and then waited for a click — so a
 * dropped worker could sit dead indefinitely. The IDE-spawned (BackendMode.Local)
 * worker manager uses this to schedule automatic restarts first, falling back to
 * the manual button once `maxAttempts` is exhausted (so a persistently-broken
 * worker doesn't spin forever).
 */

export interface IWorkerAutoRestartOptions {
	/** First-attempt delay (ms), doubled each subsequent attempt. Default 2000. */
	readonly baseMs?: number;
	/** Upper bound on a single attempt's delay (ms). Default 30000. */
	readonly capMs?: number;
	/** Stop auto-restarting (return null) once this many attempts were scheduled. Default 10. */
	readonly maxAttempts?: number;
}

export interface IWorkerAutoRestartPlan {
	/** How long to wait before firing this restart attempt. */
	readonly delayMs: number;
	/** The attempt counter AFTER scheduling this one — feed back on the next call. */
	readonly nextAttempt: number;
}

/**
 * Given how many auto-restart attempts have already been scheduled, return the
 * delay for the next one — or `null` to stop (leave the manual "Reconnect"
 * affordance). Pure + deterministic so the backoff is unit-testable.
 */
export function planWorkerAutoRestart(attemptsSoFar: number, options?: IWorkerAutoRestartOptions): IWorkerAutoRestartPlan | null {
	// Defaults: a *patient* schedule. A worker killed mid-session can take tens of
	// seconds before restartWorker() can actually re-spawn it cleanly (the old pid's
	// instance.json / port must settle), so the budget must span well past that —
	// giving up too early (e.g. 5 attempts in ~30s) leaves the worker dead. With
	// these: 2s,4s,8s,16s,30s,30s,30s,30s,30s,30s ≈ a 3.5-min self-heal window.
	const base = options?.baseMs ?? 2000;
	const cap = options?.capMs ?? 30000;
	const max = options?.maxAttempts ?? 10;
	if (attemptsSoFar >= max) {
		return null;
	}
	const delayMs = Math.min(base * Math.pow(2, attemptsSoFar), cap);
	return { delayMs, nextAttempt: attemptsSoFar + 1 };
}

// ── ①a worker 健康换新 (2026-06-29) ──────────────────────────────────────────
// Proactively recycle a long-running / heavily-reconnected LOCAL worker in an
// idle window. Companion to the worker-side mcp_loader stdio retry: it stops a
// worker from degrading (long uptime + many gRPC reconnects → async-state decay
// → create_session stdio crash) past the point the retry can save it. Pure +
// deterministic so the decision is unit-testable; the side-effecting poll +
// restartWorker() call lives in SidecarManagerElectron. The same logic ships in
// the CLI/extension WorkerLifecycle so all three surfaces behave alike.

/** Health fields read off the worker's GET /api/v1/worker/status (①b). */
export interface IWorkerHealthSnapshot {
	/** Worker process uptime in milliseconds. */
	readonly uptimeMs: number;
	/** Tool tasks currently running — recycle ONLY when 0 (never mid-turn). */
	readonly runningTasks: number;
	/** Cumulative gRPC disconnects; undefined on older worker binaries. */
	readonly disconnectCount?: number;
	/**
	 * Cumulative MCP-stdio create_session exhaustions (①c); undefined on older
	 * worker binaries. >=1 ⟹ the worker's async loop has decayed past the mcp_loader
	 * retry's reach — recycle even when uptime/disconnects look healthy.
	 */
	readonly mcpStdioExhaustedCount?: number;
}

export interface IWorkerRecycleThresholds {
	/** Recycle once uptime crosses this (ms). <=0 disables. Default 4h. */
	readonly maxUptimeMs?: number;
	/** Recycle once disconnectCount crosses this. <=0 disables. Default 20. */
	readonly maxDisconnectCount?: number;
	/** Recycle once mcpStdioExhaustedCount crosses this. <=0 disables. Default 1. */
	readonly maxMcpStdioExhausted?: number;
}

/** Default thresholds: 4h uptime / 20 reconnects / 1 stdio-exhaustion (match CLI + extension). */
export const DEFAULT_WORKER_RECYCLE_THRESHOLDS: Required<IWorkerRecycleThresholds> = {
	maxUptimeMs: 4 * 60 * 60 * 1000,
	maxDisconnectCount: 20,
	maxMcpStdioExhausted: 1,
};

/**
 * Pure decision: should an OWNED worker be recycled? Returns a short human
 * reason (for the log line) or null. Gated on idle — a worker mid-turn
 * (runningTasks > 0) is never recycled, so a recycle never interrupts a running
 * EDA turn.
 */
export function shouldRecycleWorker(snap: IWorkerHealthSnapshot, thresholds?: IWorkerRecycleThresholds): string | null {
	const maxUptimeMs = thresholds?.maxUptimeMs ?? DEFAULT_WORKER_RECYCLE_THRESHOLDS.maxUptimeMs;
	const maxDisconnectCount = thresholds?.maxDisconnectCount ?? DEFAULT_WORKER_RECYCLE_THRESHOLDS.maxDisconnectCount;
	const maxMcpStdioExhausted = thresholds?.maxMcpStdioExhausted ?? DEFAULT_WORKER_RECYCLE_THRESHOLDS.maxMcpStdioExhausted;
	if (snap.runningTasks > 0) {
		return null;
	}
	// ①c: MCP-stdio degradation is the strongest, most actionable signal — the
	// worker self-reports its create_session retry EXHAUSTED, so the async loop is
	// already broken. Churn-driven decay trips this with uptime < 4h AND
	// disconnectCount 0 (both other gates blind), so check it first.
	if (maxMcpStdioExhausted > 0 && (snap.mcpStdioExhaustedCount ?? 0) >= maxMcpStdioExhausted) {
		return `mcp-stdio exhausted ${snap.mcpStdioExhaustedCount} >= ${maxMcpStdioExhausted}`;
	}
	if (maxUptimeMs > 0 && snap.uptimeMs >= maxUptimeMs) {
		return `uptime ${Math.round(snap.uptimeMs / 60_000)}min >= ${Math.round(maxUptimeMs / 60_000)}min`;
	}
	if (maxDisconnectCount > 0 && (snap.disconnectCount ?? 0) >= maxDisconnectCount) {
		return `disconnects ${snap.disconnectCount} >= ${maxDisconnectCount}`;
	}
	return null;
}
