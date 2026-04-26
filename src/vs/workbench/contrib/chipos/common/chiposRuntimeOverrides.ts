/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * P2-14 fix: per-window runtime override for the Worker HTTP URL.
 *
 * BACKGROUND
 * ----------
 * Deployment model A: Reasoner is cloud-hosted and reached directly by the
 * IDE (chat) and the Worker (gRPC). The only thing that traverses the SSH
 * tunnel is the IDE → Worker HTTP path, used by the Worker Tools panel +
 * any IDE-side HTTP client. After `forwardPort` lands chipos-remote-ssh
 * gets a `127.0.0.1:<random>` URL on the IDE side that needs to reach the
 * workbench-side resolvers without leaking into other windows.
 *
 * Historically this was done via `vscode.workspace.getConfiguration()
 * .update(..., Global)`, which is wrong:
 *   1. Global scope leaks across windows — a B1 SSH window's tunnel URL
 *      would pollute a B2 Local window opened later.
 *   2. Workspace scope writes to disk; for SSH-Remote workspaces that's
 *      the REMOTE filesystem and visible to other users sharing the
 *      project — tunnel URLs are inherently per-window not per-project.
 *
 * SOLUTION
 * --------
 * In-memory runtime override held by a workbench singleton. Each electron
 * window gets its own service instance (registered Delayed in
 * electron-browser/chiposContribution.ts) so by construction the value
 * cannot leak across windows. Process-local; nothing hits disk.
 *
 * SCOPE
 * -----
 * Only `workerHttpUrl` is overridable. Earlier drafts also exposed
 * `reasoningUrl` here, but in model A chat traffic does NOT go through
 * the SSH tunnel (Reasoner is cloud-direct), so a runtime override on
 * reasoningUrl has no real caller. The type is narrowed to a single key
 * so the compiler enforces it — the next person who reaches for this
 * service to "set a tunnel URL for the chat path" will get a TS error
 * pointing them at the deployment-model docs instead of letting the
 * misuse compile through.
 *
 * PRECEDENCE (consulted by `resolveWorkerHttpUrl`)
 * ------------------------------------------------
 *   1. runtime override (this service) — highest, set by chipos-remote-ssh
 *      after `forwardPort` completes
 *   2. `chipos.backend.workerHttpUrl` setting — explicit user override
 *   3. derive from `reasoningUrl` host + `workerHttpPort` (caller decides)
 *
 * The chipos-remote-ssh extension calls `chipos.runtime.setOverride` /
 * `chipos.runtime.clearOverride` workbench commands; on
 * disconnect/deactivate it clears the override so a subsequent
 * Local-mode session doesn't see a stale tunnel URL.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Keys overridable at runtime. Currently only `workerHttpUrl` — see header
 * for why reasoningUrl was deliberately removed. If a future deployment
 * model needs more keys, ADD here AND update the doc on resolveReasoningUrl
 * / chiposEndpoints to explain when the new tier should fire.
 */
export type ChipOSRuntimeOverrideKey = 'workerHttpUrl';

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
		// override shouldn't re-resolve when an unrelated key changes.
		for (const k of keys) {
			this._onDidChangeOverrides.fire(k);
		}
	}
}
