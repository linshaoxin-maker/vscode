/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/workflow/preflight.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Canonical AI4EDA workflow PREFLIGHT decision (audit F-6) — the pure, surface-neutral
 * "should this `/lint` `/sim` … dispatch PROCEED, WARN, ASK, or BLOCK?" logic.
 *
 * Extracted from the CLI (chipos-cli/src/host/workflowPreflight.ts) so EVERY surface
 * — the CLI's ANSI dependency card, the extension's webview, the IDE's status popover —
 * makes the SAME gate decision before dispatch instead of firing a turn that is
 * CERTAIN to fail. The live failure this guards (2026-07 audit): with no usable worker
 * a `/lint` passthrough burns a real LLM turn on 5 "Worker tool … temporarily
 * unavailable" timeouts and then the model fabricates a lint report from source — a
 * FALSE-GREEN worse than an error. Only the CLI had the gate; F-6 unifies it here.
 *
 * This module returns ONLY the {@link PreflightAction} + a structured
 * {@link PreflightReason}. Presentation (the layered card, the Chinese remediation
 * copy, the ANSI/DOM) stays in each surface, keyed off the reason — so this stays a
 * dependency-free decision that is trivially unit-tested.
 *
 * Canonical source in @chipos/invoke-client; VENDORED into each surface's src/vendor/
 * via scripts/sync-vendor.mjs — DO NOT fork the decision.
 */

export type PreflightAction = 'proceed' | 'warn' | 'ask' | 'block';

/** Local EDA toolchain probe state (mirrors the surfaces' ToolchainStatus.state). */
export type PreflightToolchainState = 'ok' | 'degraded' | 'unknown';

/**
 * Registry-verified worker capability for THIS workspace:
 *   bound    — a worker is bound to this workspace (will execute).
 *   generic  — an unbound general worker can pick it up.
 *   mismatch — workers are online but ALL bound to OTHER workspaces (the /lint 空转 trap).
 *   empty    — 0 workers online.
 *   unknown  — no registry detail (older deployment) → fall back to the pool count.
 */
export type PreflightCapabilityState = 'bound' | 'generic' | 'mismatch' | 'empty' | 'unknown';

/** Surface-neutral inputs — each surface projects its own state onto these. */
export interface PreflightSignals {
  /** Live reasoner transport state: connected | connecting | reconnecting | disconnected | error. */
  readonly connectionState: string;
  /** Stored credentials present? `undefined` = unknown (legacy caller) → no identity gate. */
  readonly loggedIn?: boolean;
  /** Credentials present but REJECTED this session (401). */
  readonly authFailed?: boolean;
  /** Local toolchain probe state. `undefined` = not probed yet → treated as unknown. */
  readonly toolchain?: PreflightToolchainState;
  /** Registry-verified worker capability. `undefined` = unknown → pool-count fallback. */
  readonly capability?: PreflightCapabilityState;
  /** Deployment remote-pool size from /health (fallback when capability is unknown). */
  readonly remoteWorkers?: number;
  /** The remote-pool warn already shown ONCE this session → then proceed silently. */
  readonly warnedRemoteOnce?: boolean;
  /**
   * Is the local worker still inside the gRPC register window? A mismatch/empty verdict
   * INSIDE the window may bind within seconds (keep the send_anyway escape); OUTSIDE the
   * window it is a deterministic no-worker → block. `undefined` (legacy) never blocks.
   */
  readonly inRegisterWindow?: boolean;
  /** Current approve mode — `full_auto` never blocks on a question (warns instead). */
  readonly approveMode: string;
}

/**
 * Why the gate reached its verdict — the surface renders remediation off this:
 *   connection-down        — reasoner transport is hard-down; nothing can be sent.
 *   auth-failed            — 401; a send is a guaranteed remote error.
 *   logged-out             — no credentials; the worker can't register tools.
 *   toolchain-ok           — local toolchain verified → run silently.
 *   toolchain-degraded     — some tools missing; the flow may still work (warn).
 *   capability-verified    — a bound/generic worker WILL execute (warn once, then proceed).
 *   remote-pool            — pool count > 0 but capability unverified (warn once).
 *   deterministic-no-worker— mismatch/empty AND outside the register window → certain fail.
 *   dependency-unready     — mismatch/empty/no-signal inside/at the window → ask (or warn under full_auto).
 */
export type PreflightReason =
  | 'connection-down'
  | 'auth-failed'
  | 'logged-out'
  | 'toolchain-ok'
  | 'toolchain-degraded'
  | 'capability-verified'
  | 'remote-pool'
  | 'deterministic-no-worker'
  | 'dependency-unready';

export interface PreflightDecision {
  readonly action: PreflightAction;
  readonly reason: PreflightReason;
}

/**
 * Decide the gate verdict for a workflow dispatch. Pure + total (every input shape
 * returns a decision). The layer ORDER is the contract — the most fundamental
 * blocker wins: connection → identity → local toolchain → verified executor →
 * pool fallback → the unready dependency card.
 */
export function decideWorkflowPreflight(i: PreflightSignals): PreflightDecision {
  // L1 connection (audit F-8): a workflow sent while the transport is HARD-down
  // reaches nothing; block with a connection verdict instead of offering send_anyway.
  // Transient connecting/reconnecting is NOT blocked here (the surface queues those).
  if (i.connectionState === 'error' || i.connectionState === 'disconnected') {
    return { action: 'block', reason: 'connection-down' };
  }

  // L2 identity — a send with rejected/absent credentials is a guaranteed 401.
  if (i.authFailed) return { action: 'block', reason: 'auth-failed' };
  if (i.loggedIn === false) return { action: 'block', reason: 'logged-out' };

  // Local toolchain verified.
  if (i.toolchain === 'ok') return { action: 'proceed', reason: 'toolchain-ok' };
  if (i.toolchain === 'degraded') return { action: 'warn', reason: 'toolchain-degraded' };

  // L4 registry-verified executor for THIS workspace → the turn will run.
  if (i.capability === 'bound' || i.capability === 'generic') {
    return { action: i.warnedRemoteOnce ? 'proceed' : 'warn', reason: 'capability-verified' };
  }

  // L4 unknown (no /workers route) → the bare /health pool-count heuristic.
  if ((i.capability === undefined || i.capability === 'unknown') && (i.remoteWorkers ?? 0) > 0) {
    return { action: i.warnedRemoteOnce ? 'proceed' : 'warn', reason: 'remote-pool' };
  }

  // mismatch / empty / no signal at all → the layered dependency card.
  // A mismatch/empty verdict OUTSIDE the register window is a DETERMINISTIC no-worker:
  // the send is certain to burn 5 tool timeouts then invite a fabricated report → block
  // (even under full_auto, same as the 401 block). Inside/at the window it may bind soon.
  const deterministicNoWorker =
    (i.capability === 'mismatch' || i.capability === 'empty') && i.inRegisterWindow === false;
  if (deterministicNoWorker) return { action: 'block', reason: 'deterministic-no-worker' };

  if (i.approveMode === 'full_auto') return { action: 'warn', reason: 'dependency-unready' };
  return { action: 'ask', reason: 'dependency-unready' };
}
