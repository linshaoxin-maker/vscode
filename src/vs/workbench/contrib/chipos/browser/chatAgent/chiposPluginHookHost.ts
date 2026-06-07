/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tier-2 executable-hook host (FEAT, H-3) — RENDERER side.
 *
 * Enforces per-plugin consent and delegates the actual subprocess run to the
 * main process via {@link IChiposPluginHookService}. The fork CANNOT happen in the
 * renderer: a packaged app's renderer is sandboxed (no Node `require`), which made
 * the previous renderer-side fork silently fail-closed. The node child is now
 * forked in electron-main (chiposPluginHookRunner.ts) and reached over IPC.
 *
 * Security model — FAIL-CLOSED:
 *   - per-plugin consent is enforced here ({@link ChiposPluginHookHost.hasConsent});
 *     the `chipos.hooks.executablePlugins` flag and workspace-trust gate belong to
 *     the H-3 caller, not this class.
 *   - the ctx is `structuredClone`d before crossing the IPC boundary (and is frozen
 *     in the child), so plugin code cannot mutate live IDE state.
 *   - no consent, no service (e.g. web), or a service fault resolves to `deny` when
 *     {@link HookEvalRequest.failClosed} is set.
 */

import { IPluginHookDecision } from '../../../../../platform/chipos/common/chiposPluginHook.js';
import { IChiposPluginHookService } from '../../common/chiposPluginHookService.js';

/** A single hook evaluation request handed to {@link ChiposPluginHookHost.evaluate}. */
export interface HookEvalRequest {
	readonly evalId: string;
	readonly pluginId: string;
	readonly modulePath: string;
	readonly exportName: string;
	readonly ctx: object;
	readonly timeoutMs: number;
	readonly failClosed: boolean;
}

/** The decision returned from a hook evaluation (shared shape with the main-process runner). */
export type HookDecision = IPluginHookDecision;

/**
 * Per-chat-agent consent gate in front of the shared main-process hook runner. The
 * H-3 caller owns this instance's lifecycle and must call {@link dispose} when done;
 * nothing global is registered here.
 */
export class ChiposPluginHookHost {

	private readonly _consented = new Set<string>();

	constructor(
		private readonly _hookService?: IChiposPluginHookService,
	) { }

	/** Record that the user has consented to running `pluginId`'s executable hooks. */
	grantConsent(pluginId: string): void {
		this._consented.add(pluginId);
	}

	/** Whether the user has consented to running `pluginId`'s executable hooks. */
	hasConsent(pluginId: string): boolean {
		return this._consented.has(pluginId);
	}

	/**
	 * Evaluate one hook via the main-process runner. Returns the plugin's decision,
	 * or the fail-closed default ({@link HookEvalRequest.failClosed} ? deny : proceed)
	 * on no-consent / no-service / IPC fault.
	 */
	async evaluate(req: HookEvalRequest): Promise<HookDecision> {
		if (!this.hasConsent(req.pluginId)) {
			return { decision: req.failClosed ? 'deny' : 'proceed', reason: 'plugin not consented' };
		}
		if (!this._hookService) {
			// No main-process runner wired (e.g. web): cannot run plugin code safely.
			return { decision: req.failClosed ? 'deny' : 'proceed', reason: 'no hook service' };
		}
		try {
			return await this._hookService.evaluate({
				modulePath: req.modulePath,
				exportName: req.exportName,
				// Clone so plugin code (which runs in the main child) can never get a
				// handle to live renderer state through the request object.
				ctx: structuredClone(req.ctx),
				timeoutMs: req.timeoutMs,
				failClosed: req.failClosed,
			});
		} catch {
			return { decision: req.failClosed ? 'deny' : 'proceed', reason: 'hook service error' };
		}
	}

	/** No-op: the child lifecycle is owned by the main-process runner. Kept for caller API parity. */
	dispose(): void {
		// nothing renderer-side to dispose
	}
}
