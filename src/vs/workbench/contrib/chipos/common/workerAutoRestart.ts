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
	/** First-attempt delay (ms), doubled each subsequent attempt. Default 1000. */
	readonly baseMs?: number;
	/** Upper bound on a single attempt's delay (ms). Default 16000. */
	readonly capMs?: number;
	/** Stop auto-restarting (return null) once this many attempts were scheduled. Default 5. */
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
	const base = options?.baseMs ?? 1000;
	const cap = options?.capMs ?? 16000;
	const max = options?.maxAttempts ?? 5;
	if (attemptsSoFar >= max) {
		return null;
	}
	const delayMs = Math.min(base * Math.pow(2, attemptsSoFar), cap);
	return { delayMs, nextAttempt: attemptsSoFar + 1 };
}
