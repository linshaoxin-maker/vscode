/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

// `validatedIpcMain` adds sender + origin validation that bare `ipcMain` lacks;
// it rejects any channel not under `vscode:`. See sidecarManagerMain.ts.
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { CHIPOS_PLUGIN_HOOK_EVAL_CHANNEL, IPluginHookEvalArgs, IPluginHookDecision } from '../common/chiposPluginHook.js';
import { ChiposPluginHookRunner } from '../node/chiposPluginHookRunner.js';

/**
 * Tier-2 executable-hook IPC handler (FEAT, H-3) — registers the renderer → main
 * channel that runs a consented plugin's hook in an isolated node child. The fork
 * happens here (main has Node) rather than in the sandboxed renderer, which has no
 * `require` in a packaged app. Call once from the main bootstrap (app.ts),
 * alongside registerSidecarIpcHandlers().
 *
 * A single lazily-created runner serves all windows. Consent / flag / trust gating
 * is the renderer's responsibility (chiposPluginHookHost.ts); by the time a request
 * reaches here the user has already consented to this plugin.
 */

let _runner: ChiposPluginHookRunner | undefined;

export function registerPluginHookIpcHandlers(): void {
	validatedIpcMain.handle(CHIPOS_PLUGIN_HOOK_EVAL_CHANNEL, async (_event, args: IPluginHookEvalArgs): Promise<IPluginHookDecision> => {
		try {
			_runner = _runner ?? new ChiposPluginHookRunner();
			return await _runner.evaluate(args);
		} catch {
			// Never let a runner fault leak as a thrown IPC reply — fail-closed.
			return { decision: args && args.failClosed === false ? 'proceed' : 'deny', reason: 'main-eval-error' };
		}
	});
}
