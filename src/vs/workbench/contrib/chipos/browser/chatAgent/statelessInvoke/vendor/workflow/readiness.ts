/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/workflow/readiness.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Canonical AI4EDA "five-layer readiness" model (audit F-6, second slice) — the pure,
 * surface-neutral derivation of「工作流现在能不能跑」from the five layers the CLI's
 * `/status` shows: L1 connection · L2 identity · L3 worker pool · L4 registry capability
 * · L5 the composite verdict. Extracted from the CLI (chipos-cli workerReadiness.ts) so
 * the extension + IDE can render the SAME layered status instead of only a coarse
 * connected/disconnected — the readiness verdict is now single-sourced, exactly like the
 * workflow-preflight decision it complements.
 *
 * Reasons stay Chinese: the whole ChipOS surface is Chinese-first (the reasoner emits
 * Chinese, the CLI + the gate messages are Chinese), so all three surfaces render the
 * same line — no per-surface reason table to drift.
 *
 * Canonical in @chipos/invoke-client; VENDORED into each surface's src/vendor/ via
 * scripts/sync-vendor.mjs — DO NOT fork the logic.
 */

/** L5 verdict levels, in decreasing readiness. */
export type ReadinessLevel = 'ready' | 'degraded' | 'waiting' | 'blocked' | 'unknown';

export interface WorkflowReadiness {
  readonly level: ReadinessLevel;
  /** One human line naming the deciding layer (never a vague "不可用"). */
  readonly reason: string;
}

/** Registry-verified worker capability state (mirrors the surfaces' WorkerCapability). */
export type ReadinessCapabilityState = 'bound' | 'generic' | 'mismatch' | 'empty' | 'unknown';

/** Minimal capability shape the derivation reads (a surface's richer type is compatible). */
export interface ReadinessCapability {
  readonly state: ReadinessCapabilityState;
  readonly bound?: { readonly worker_id?: string };
  readonly genericCount: number;
  readonly total: number;
}

/** Minimal toolchain shape the derivation reads. */
export interface ReadinessToolchain {
  readonly state: 'ok' | 'degraded' | 'unknown';
  readonly tools: ReadonlyArray<{ readonly name: string; readonly ok: boolean }>;
}

/** Local worker bring-up phase. */
export type ReadinessWorkerPhase = 'starting' | 'ready' | 'unavailable';

/** Surface-neutral inputs — each surface projects its own state onto these. */
export interface ReadinessInput {
  /** Live transport state (`connected` | `connecting` | `reconnecting` | …). */
  readonly connectionState: string;
  /** Last /health verdict (undefined = not probed yet). */
  readonly reachable?: boolean;
  readonly authFailed?: boolean;
  /** Logged-in (stored credentials present). */
  readonly loggedIn?: boolean;
  /** /health workers_connected (L3), when known. */
  readonly poolCount?: number;
  /** L4 assessment (undefined = never assessed). */
  readonly capability?: ReadinessCapability;
  /** Local worker bring-up phase ('' = skipped). */
  readonly localPhase?: ReadinessWorkerPhase | '';
  /** epoch-ms the local worker turned 'ready' (the HTTP-ready→gRPC-registered grace window). */
  readonly localReadySinceMs?: number;
  /** Local toolchain probe. */
  readonly toolchain?: ReadinessToolchain;
}

/** HTTP-ready precedes reasoner-side gRPC registration by seconds; treat as 「注册中」. */
export const REGISTER_WINDOW_MS = 60_000;

/** True while the local worker is plausibly still REGISTERING to the reasoner. */
export function inRegisterWindow(
  phase: ReadinessWorkerPhase | '' | undefined,
  readySinceMs: number | undefined,
  now: number,
): boolean {
  if (phase === 'starting') return true;
  return phase === 'ready' && typeof readySinceMs === 'number' && now - readySinceMs < REGISTER_WINDOW_MS;
}

/**
 * Derive the L5 verdict from the five layers. Pure + total. Layer ORDER is the contract:
 * connection → identity → registry capability (outranks the bare pool count) → pool
 * fallback → unknown. `now` is injected (the register-window math) so the function stays
 * deterministic for tests.
 */
export function deriveWorkflowReadiness(i: ReadinessInput, now: number): WorkflowReadiness {
  // L1 connection.
  if (i.reachable === false || i.connectionState === 'error' || i.connectionState === 'disconnected') {
    return { level: 'blocked', reason: 'reasoner 连不上 — 检查网络/CHIPOS_REASONER_URL' };
  }
  if (i.connectionState === 'connecting' || i.connectionState === 'reconnecting') {
    return { level: 'waiting', reason: 'reasoner 连接建立中' };
  }
  // L2 identity.
  if (i.authFailed) {
    return { level: 'blocked', reason: '登录已失效(401)— /login 重新登录' };
  }
  if (i.loggedIn === false) {
    return { level: 'blocked', reason: '未登录 — /login 后 worker 才能自启并注册工具' };
  }
  // L4 capability (the registry verdict outranks the bare pool count).
  const cap = i.capability;
  if (cap && cap.state !== 'unknown') {
    if (cap.state === 'bound' || cap.state === 'generic') {
      // Executor exists. Toolchain state refines ready→degraded.
      if (i.toolchain?.state === 'degraded') {
        const missing = i.toolchain.tools.filter((t) => !t.ok).map((t) => t.name).join(', ');
        return { level: 'degraded', reason: `工具部分缺失(${missing || '部分工具'})— 相关步骤可能失败` };
      }
      const who = cap.state === 'bound'
        ? `本工作区 worker 已绑定(${cap.bound?.worker_id ?? 'worker'})`
        : `通用 worker ×${cap.genericCount} 可承接`;
      return { level: 'ready', reason: who };
    }
    if (cap.state === 'mismatch') {
      if (inRegisterWindow(i.localPhase, i.localReadySinceMs, now)) {
        return { level: 'waiting', reason: '本地 worker 已启动,注册到 reasoner 中(秒级)' };
      }
      return { level: 'blocked', reason: `远端 ${cap.total} 个 worker 均绑定其它工作区(历史残留)` };
    }
    // empty
    if (inRegisterWindow(i.localPhase, i.localReadySinceMs, now)) {
      return { level: 'waiting', reason: '本地 worker 已启动,注册到 reasoner 中(秒级)' };
    }
    return { level: 'blocked', reason: '远端 0 个 worker 在线 — 无执行方' };
  }
  // L4 unknown → fall back to the L3 count (older deployments without /workers).
  if (typeof i.poolCount === 'number') {
    if (i.poolCount > 0) {
      return { level: 'degraded', reason: `远端 ${i.poolCount} 个 worker 在线(能力未验证 — 部署端无 /workers 明细)` };
    }
    if (inRegisterWindow(i.localPhase, i.localReadySinceMs, now)) {
      return { level: 'waiting', reason: '本地 worker 已启动,注册到 reasoner 中(秒级)' };
    }
    return { level: 'blocked', reason: '远端 0 个 worker 在线 — 无执行方' };
  }
  return { level: 'unknown', reason: '尚未完成状态探测' };
}
