/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

// `validatedIpcMain` adds sender + origin validation that bare `ipcMain` lacks;
// it rejects any channel not under `vscode:`. See sidecarManagerMain.ts.
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { CHIPOS_GIT_EXEC_CHANNEL, IChiposGitExecArgs, IChiposGitExecResult } from '../common/chiposGit.js';
import { ChiposGitRunner } from '../node/chiposGitRunner.js';

/**
 * ChipOS git IPC handler — registers the renderer → main channel that runs a `git`
 * subcommand in the main process (which has Node) rather than in the sandboxed
 * renderer (which has no `require` in a packaged app, so renderer-side git calls
 * silently no-op'd). Call once from the main bootstrap (app.ts), alongside
 * registerSidecarIpcHandlers() / registerPluginHookIpcHandlers().
 *
 * The runner only ever spawns `git` (the binary is hardcoded), so the renderer
 * cannot run an arbitrary executable through this channel — only arbitrary git
 * subcommands, exactly the capability the renderer already had via bare require.
 */

let _runner: ChiposGitRunner | undefined;

export function registerGitIpcHandlers(): void {
	validatedIpcMain.handle(CHIPOS_GIT_EXEC_CHANNEL, async (_event, args: IChiposGitExecArgs): Promise<IChiposGitExecResult> => {
		try {
			_runner = _runner ?? new ChiposGitRunner();
			return await _runner.exec(args);
		} catch (e) {
			// Never let a runner fault leak as a thrown IPC reply.
			return { ok: false, stdout: '', stderr: String((e as Error)?.message ?? e), code: null, killed: false };
		}
	});
}
