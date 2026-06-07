/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { CHIPOS_GIT_EXEC_CHANNEL, IChiposGitExecArgs, IChiposGitExecResult } from '../../../../platform/chipos/common/chiposGit.js';
import { IChiposGitService } from '../common/chiposGitService.js';

/**
 * Electron implementation of {@link IChiposGitService}: forwards each git
 * invocation to the main process over IPC, where `git` is spawned. This is the
 * renderer end of the fix for the packaged-app sandbox (no `require` in the
 * renderer). Mirrors chiposPluginHookElectron's ipcRenderer.invoke pattern.
 */
export class ChiposGitElectron implements IChiposGitService {
	declare readonly _serviceBrand: undefined;

	exec(args: IChiposGitExecArgs): Promise<IChiposGitExecResult> {
		return ipcRenderer.invoke(CHIPOS_GIT_EXEC_CHANNEL, args) as Promise<IChiposGitExecResult>;
	}
}
