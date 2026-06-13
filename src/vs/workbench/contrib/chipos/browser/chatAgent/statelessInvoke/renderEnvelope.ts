/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * RenderEnvelope unwrap + three-layer degrade (/invoke v1.1 S5 / F-1-ide, §8 + D10).
 *
 * S5 makes the reasoner wrap every `family === 'render'` card (sim / lint / ppa /
 * coverage / diff / spec / …) in a uniform {@link RenderEnvelopeShape} at the
 * SSEEmitSink boundary: `{ kind, schema_version, payload, fallback }`. The REAL card
 * data then lives in `data.payload`, NOT `data` itself — so the dispatcher's render
 * cases (which read `event.data` directly, e.g. `data.tests` for `sim_report`) would
 * read the wrong shape and render empty/garbled cards. This module is the IDE's
 * unwrap + degrade gate, called once at the top of {@link dispatchStatelessEvent}.
 *
 * Three layers (the surface side of the S5 contract, §8):
 *   1. NOT an envelope (legacy bare frame) → pass through verbatim, NOT degraded.
 *      ⭐ BACKWARD COMPAT RED LINE (D-2): prod still emits bare frames until the S5
 *      sink is deployed, so the client MUST keep rendering them exactly as today.
 *      A surface recognizes BOTH wire shapes; the sink flips second.
 *   2. envelope + `kind` natively renderable + `schema_version` ≤ what the IDE knows
 *      → unwrap to `env.payload` (the dedicated render case renders unchanged).
 *   3. envelope + `kind` unknown / `schema_version` too new / `kind === 'ui_spec'`
 *      → degrade to `env.fallback` (NEVER dropped, D10). `ui_spec` is the D-1
 *      generative-UI placeholder — Beta-1 does not implement it, so it also degrades.
 *
 * Pure — NO `vscode` / workbench imports, no I/O. Factored to lift verbatim into the
 * planned shared TS client SDK (③, F-1-sdk) that the IDE + extension + CLI will share;
 * until then it deliberately mirrors `vscode-extension/src/pipeline/renderEnvelope.ts`.
 * Mirrors `RenderEnvelope` in `backend_v2/packages/shared/src/shared/contracts/invoke.py`
 * (and the IDE wire type {@link RenderEnvelope} in `./types.ts`).
 */

/** The on-wire envelope, structurally (kept local so this module is dependency-free). */
interface RenderEnvelopeShape {
	kind: string;
	schema_version?: number;
	payload?: unknown;
	fallback?: unknown;
}

/** Outcome of unwrapping one render frame. */
export interface ResolvedRender {
	/** What the surface should render: bare data, the unwrapped payload, or the fallback. */
	data: unknown;
	/** True only on layer 3 (the IDE could not natively render the card). */
	degraded: boolean;
	/**
	 * The envelope `kind` when `data` WAS an envelope (layer 2 or 3), else undefined.
	 * Lets the degrade path label the fallback card with the original card name.
	 */
	kind?: string;
}

/**
 * The render kinds the IDE dispatcher renders NATIVELY with a dedicated `case` in
 * {@link dispatchUnwrappedEvent}. `kind` = the reasoner event `type` (snake_case) =
 * `RenderEnvelope.kind`. Membership decides unwrap-vs-degrade in
 * {@link resolveRenderEnvelope}.
 *
 * ⭐ MUST equal { backend `family === 'render'` types } ∩ { kinds the IDE has a case
 * for }. The backend wraps EVERY render-family event in an envelope (`_TYPE_TO_FAMILY`
 * / `RENDER_EVENT_TYPES` in `shared/contracts/invoke.py`), so a render-family kind the
 * IDE renders but OMITS here would wrongly DEGRADE to its raw fallback. `todo` is
 * exactly that case — it is render-family (wrapped) AND has a dedicated `case 'todo'`,
 * so it MUST be present; omitting it dumped the todo list as raw JSON on every
 * `write_todos` turn (F-1-ide bug fix, caught in pre-launch review).
 *
 * DELIBERATELY ABSENT — render-family kinds the IDE has NO case for, which correctly
 * degrade to their purpose-built `fallback`: `plan`, `timing_highlight`,
 * `pre_review_report`, `review_gate`. (`loop_progress` / `verification_progress` are
 * backend `control`, never wrapped, so they never reach this gate at all.)
 */
export const IDE_RENDER_KINDS: ReadonlySet<string> = new Set([
	'sim_report',
	'lint_report',
	'coverage_report',
	'ppa_report',
	'negotiation_view',
	'diff_preview',
	'spec_review',
	'task_summary',
	'todo',
	// backend `control` family → never enveloped, so this is a no-op; kept only because
	// the IDE has a dedicated `case 'parallel_progress'` (would unwrap right if ever wrapped).
	'parallel_progress',
]);

/**
 * Highest `payload` schema version the IDE understands per kind (§4
 * RenderCapability.max_schema_version). A frame whose `schema_version` exceeds the
 * known ceiling degrades (layer 3) — the surface refuses to mis-render a payload it
 * may not understand. Kinds absent here default to {@link DEFAULT_MAX_SCHEMA_VERSION}.
 *
 * Beta-1: every native card is at v1, so this is empty (the floor); add an entry when
 * a card learns a newer payload shape.
 */
export const IDE_RENDER_SCHEMA_VERSIONS: Readonly<Record<string, number>> = {};

/** Schema version assumed for a known kind not listed in the per-kind map. */
export const DEFAULT_MAX_SCHEMA_VERSION = 1;

/**
 * The D-1 generative-UI kind. Beta-1 does NOT implement a declarative renderer, so a
 * `ui_spec` envelope always takes the fallback (layer 3) even though its kind is
 * "known" in the contract sense.
 */
const UI_SPEC_KIND = 'ui_spec';

/**
 * Structural envelope test (S5 / §8). True iff `data` is a plain object carrying the
 * three required envelope keys: `kind` (string) + `payload` + `fallback`.
 *
 * SHAPE-based on purpose: the stable routing band `family === 'render'` may not have
 * been threaded down to this layer, so the shape is the most robust discriminator. A
 * legacy bare card (sim_report payload, lint report, …) does NOT carry all three keys,
 * so it is never mistaken for an envelope — the backward-compat guarantee (D-2).
 */
export function isRenderEnvelope(data: unknown): data is RenderEnvelopeShape {
	if (data === null || typeof data !== 'object' || Array.isArray(data)) {
		return false;
	}
	const o = data as Record<string, unknown>;
	// `kind` MUST be a string; `payload` + `fallback` MUST be present as own keys
	// (any value, including null — presence is what distinguishes the envelope).
	return (
		typeof o.kind === 'string' &&
		Object.prototype.hasOwnProperty.call(o, 'payload') &&
		Object.prototype.hasOwnProperty.call(o, 'fallback')
	);
}

/**
 * Resolve one render frame through the three-layer S5 contract.
 *
 * @param data the frame payload at the dispatcher boundary — post-S5 a
 *   {@link RenderEnvelopeShape}, pre-S5 a bare card payload.
 * @param knownKinds kinds the IDE renders natively (default {@link IDE_RENDER_KINDS}).
 * @param maxSchemaVersions per-kind schema ceiling (default
 *   {@link IDE_RENDER_SCHEMA_VERSIONS}); a kind absent here uses
 *   {@link DEFAULT_MAX_SCHEMA_VERSION}.
 * @returns `{ data, degraded, kind? }` — `data` is what to forward to the render case.
 */
export function resolveRenderEnvelope(
	data: unknown,
	knownKinds: ReadonlySet<string> = IDE_RENDER_KINDS,
	maxSchemaVersions: Readonly<Record<string, number>> = IDE_RENDER_SCHEMA_VERSIONS,
): ResolvedRender {
	// ── Layer 1: legacy bare frame → verbatim passthrough (backward compat, D-2) ──
	if (!isRenderEnvelope(data)) {
		return { data, degraded: false };
	}

	const env = data;
	const kind = env.kind;
	const fallback = coerceFallback(env);

	// ui_spec (D-1 generative UI) is a contract placeholder — always degrade in Beta-1.
	if (kind === UI_SPEC_KIND) {
		return { data: fallback, degraded: true, kind };
	}

	// ── Layer 3a: unknown kind → fallback (never dropped, D10) ──
	if (!knownKinds.has(kind)) {
		return { data: fallback, degraded: true, kind };
	}

	// ── Layer 3b: schema too new → fallback (refuse to mis-render an unknown shape) ──
	// Missing/non-numeric schema_version means "no version info" → treat as v1 and pass.
	const wireVersion = coerceSchemaVersion(env.schema_version);
	const ceiling = Object.prototype.hasOwnProperty.call(maxSchemaVersions, kind)
		? maxSchemaVersions[kind]
		: DEFAULT_MAX_SCHEMA_VERSION;
	if (wireVersion > ceiling) {
		return { data: fallback, degraded: true, kind };
	}

	// ── Layer 2: known kind + compatible schema → unwrap to the rich payload ──
	// `payload` is normally an object; if a malformed frame ships a non-object payload,
	// fall back to an empty object so the dedicated render case never crashes.
	const payload = env.payload;
	const safePayload = payload !== null && typeof payload === 'object' ? payload : {};
	return { data: safePayload, degraded: false, kind };
}

/**
 * Normalize the mandatory `fallback` (D10) into a shape the IDE fallback render path
 * understands (`.text` / `.summary` / `.message` / `.artifact_ref`). A well-formed
 * envelope always carries an object fallback; this only guards a malformed/missing one
 * so the degrade path is still non-empty (never a silent drop).
 */
function coerceFallback(env: RenderEnvelopeShape): Record<string, unknown> {
	const fb = env.fallback;
	if (fb !== null && typeof fb === 'object' && !Array.isArray(fb)) {
		return fb as Record<string, unknown>;
	}
	if (typeof fb === 'string' && fb.trim().length > 0) {
		return { text: fb };
	}
	// Last resort: synthesize a label from the kind so the card is never empty.
	return { text: env.kind };
}

/** Coerce a wire schema_version to a finite number; absent/garbage → v1 (pass). */
function coerceSchemaVersion(v: unknown): number {
	if (typeof v === 'number' && Number.isFinite(v)) {
		return v;
	}
	return 1;
}
