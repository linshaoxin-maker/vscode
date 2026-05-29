/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * [ChipOS] ADR-018 — resume-from-break retry classification.
 *
 * Pure decision: once a stateless turn has FAILED (after the in-flight
 * auto-resume exhausted its retries), can the turn be CONTINUED from the last
 * checkpoint (POST /resume — preserving already-rendered output) or must the
 * user RESEND the whole prompt?
 *
 * Drives the error card's button variant:
 *   resumable  → PRIMARY "继续 (从中断处)" + secondary "Retry" (resend)
 *   !resumable → "Retry" (resend) only
 *
 * Kept side-effect-free + DI-free so the mapping is unit-tested in isolation
 * from the chipOSChatAgent.ts orchestration. Mirrors the verdict vocabulary of
 * `classifySseFailure`, plus a 404 marker that only the /resume path can raise.
 */

export interface StatelessFailureContext {
	/** SSE-failure verdict (see `classifySseFailure`). */
	verdict: 'surface-http' | 'surface-replay-expired' | 'surface-other' | 'replay';
	/** HTTP status, when `verdict === 'surface-http'`. */
	httpStatus?: number;
	/** A /resume returned 404 — the server-side turn is gone (finished / never existed). */
	resumeNotFound?: boolean;
}

/**
 * True when the failed turn can be continued from where it broke. Continuation
 * (`_resumeStatelessTurn`) degrades gracefully if the server has since dropped
 * the turn (404 → "turn finished") or evicted its replay buffer (410 →
 * "expired"), so an optimistic `true` is always safe — worst case the user gets
 * a resend prompt from the resume attempt itself.
 */
export function isStatelessTurnResumable(ctx: StatelessFailureContext): boolean {
	// 410 — the reconnect buffer expired server-side; nothing left to continue.
	if (ctx.verdict === 'surface-replay-expired') {
		return false;
	}
	// 404 — the turn is gone (finished or never existed).
	if (ctx.resumeNotFound) {
		return false;
	}
	switch (ctx.verdict) {
		// 5xx is a transient server fault → the turn is likely still live.
		// 4xx is a deterministic client/protocol error → resend.
		case 'surface-http':
			return (ctx.httpStatus ?? 0) >= 500;
		// Unknown / network shape → optimistically offer continue.
		case 'surface-other':
			return true;
		// Auto-resume exhausted its retries on transient errors → the turn is
		// (probably) still running server-side; offer continue.
		case 'replay':
			return true;
		default:
			return false;
	}
}
