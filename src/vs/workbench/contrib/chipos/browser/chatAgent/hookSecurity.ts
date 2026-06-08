/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ReasonerHookDefinition } from './statelessInvoke/types.js';

/**
 * FEAT-004 B6 — pure hook-security helpers (kept dependency-free so they unit-test
 * in node and chatAgent stays a thin caller).
 */

/**
 * Decide which hooks reach `InvokeRequest.hooks` this turn:
 *   - `disable` (the `chipos.hooks.disable` global kill switch) → none at all
 *     (declarative AND executable), so the reasoner registers no subscribers (BDD-004-04).
 *   - else when executable plugins are off → drop tier-2 `kind: 'function'` hooks
 *     (an installed plugin's function hook stays fully inert until opted in).
 *   - else → all.
 */
export function filterHooksForInvoke(
	allHooks: readonly ReasonerHookDefinition[],
	opts: { readonly executablePlugins: boolean; readonly disable: boolean },
): ReasonerHookDefinition[] {
	if (opts.disable) {
		return [];
	}
	if (!opts.executablePlugins) {
		return allHooks.filter(h => (h as { kind?: string }).kind !== 'function');
	}
	return [...allHooks];
}

/** Keys whose values are masked before a hook context crosses to an isolated child (STRIDE-I). */
const SENSITIVE_KEY = /(?:token|secret|password|passwd|api[-_]?key|apikey|auth|credential|cookie|access[-_]?key|bearer)/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

/**
 * FEAT-004 B6 — deep-redact sensitive values from a hook context's args before it
 * is handed to an executable (possibly untrusted plugin) hook, so the hook cannot
 * read/exfiltrate secrets (STRIDE-I). Masks values whose KEY looks sensitive;
 * recurses through objects/arrays (depth-capped); non-objects pass through. Returns
 * a redacted clone — the original args are untouched.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(v => redactSensitive(v, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactSensitive(v, depth + 1);
	}
	return out;
}
