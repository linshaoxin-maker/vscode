/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * P2-14 fix: per-window runtime overrides for endpoint URLs.
 *
 * BACKGROUND
 * ----------
 * The chipos-remote-ssh extension forwards remote ports to random local ports
 * and needs to tell the workbench-side resolvers (`resolveReasoningUrl`,
 * `workerHttpUrl` getter) about the chosen tunnel URL. Historically it did
 * this via `vscode.workspace.getConfiguration().update(..., Global)`, which
 * is wrong for two reasons:
 *
 *   1. Global scope leaks across windows: a B1 SSH-Remote window writing
 *      `reasoningUrl=http://127.0.0.1:46781` would pollute a B2 Local window
 *      that opens later — B2 reads Global settings and tries to dial the
 *      stale tunnel URL.
 *   2. Workspace scope (the obvious alternative) writes to disk
 *      (`.vscode/settings.json`), and for SSH-Remote workspaces that's the
 *      REMOTE filesystem — visible to other users sharing the project. Tunnel
 *      URLs are inherently per-window, not per-project.
 *
 * SOLUTION
 * --------
 * In-memory runtime overrides held by a workbench singleton. Each electron
 * window gets its own service instance (registered Delayed in
 * electron-browser/chiposContribution.ts), so by construction overrides
 * cannot leak across windows. State is process-local; nothing hits disk.
 *
 * PRECEDENCE (consulted by chiposEndpoints resolvers)
 * ---------------------------------------------------
 *   1. runtime override (this service) — highest priority, set by
 *      chipos-remote-ssh after port forwarding completes
 *   2. settings.json (user / workspace) — explicit user override
 *   3. product.json `chiposDefaults.*` — build-time defaults
 *   4. hardcoded fallback
 *
 * The chipos-remote-ssh extension calls `chipos.runtime.setOverride` /
 * `chipos.runtime.clearOverride` workbench commands; on disconnect/deactivate
 * it clears the overrides so the next deployment-mode change starts clean.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type ChipOSRuntimeOverrideKey = 'reasoningUrl' | 'workerHttpUrl';

export interface IChipOSRuntimeOverridesService {
	readonly _serviceBrand: undefined;

	/** Fired when any override changes (set/clear). Listeners typically refresh
	 * URL-derived state (HTTP client base, SSE re-subscribe, etc.). */
	readonly onDidChangeOverrides: Event<ChipOSRuntimeOverrideKey>;

	/**
	 * Set a runtime override. Pass `undefined` to clear (equivalent to
	 * `clearOverride`). Empty string is treated as undefined for safety —
	 * an empty URL is never a meaningful override.
	 */
	setOverride(key: ChipOSRuntimeOverrideKey, value: string | undefined): void;

	/** Read the current runtime override for `key`, or undefined when unset. */
	getOverride(key: ChipOSRuntimeOverrideKey): string | undefined;

	/** Clear a single override. */
	clearOverride(key: ChipOSRuntimeOverrideKey): void;

	/** Clear ALL overrides. Called on disconnect/deactivate so a subsequent
	 *  Local mode session doesn't see stale tunnel URLs. */
	clearAllOverrides(): void;
}

export const IChipOSRuntimeOverridesService = createDecorator<IChipOSRuntimeOverridesService>('chiposRuntimeOverridesService');

export class ChipOSRuntimeOverridesService extends Disposable implements IChipOSRuntimeOverridesService {

	declare readonly _serviceBrand: undefined;

	private readonly _overrides = new Map<ChipOSRuntimeOverrideKey, string>();
	private readonly _onDidChangeOverrides = this._register(new Emitter<ChipOSRuntimeOverrideKey>());
	readonly onDidChangeOverrides: Event<ChipOSRuntimeOverrideKey> = this._onDidChangeOverrides.event;

	setOverride(key: ChipOSRuntimeOverrideKey, value: string | undefined): void {
		const normalized = value && value.length > 0 ? value : undefined;
		const current = this._overrides.get(key);
		if (current === normalized) {
			return; // no-op
		}
		if (normalized === undefined) {
			this._overrides.delete(key);
		} else {
			this._overrides.set(key, normalized);
		}
		this._onDidChangeOverrides.fire(key);
	}

	getOverride(key: ChipOSRuntimeOverrideKey): string | undefined {
		return this._overrides.get(key);
	}

	clearOverride(key: ChipOSRuntimeOverrideKey): void {
		this.setOverride(key, undefined);
	}

	clearAllOverrides(): void {
		const keys = Array.from(this._overrides.keys());
		this._overrides.clear();
		// Fire one event per cleared key — listeners that key off a specific
		// override (e.g. only reasoningUrl) shouldn't re-resolve when an
		// unrelated key changes.
		for (const k of keys) {
			this._onDidChangeOverrides.fire(k);
		}
	}
}
