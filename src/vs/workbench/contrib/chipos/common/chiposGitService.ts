/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IChiposGitExecArgs, IChiposGitExecResult } from '../../../../platform/chipos/common/chiposGit.js';

export const IChiposGitService = createDecorator<IChiposGitService>('chiposGitService');

/**
 * Renderer-facing handle to the main-process git runner.
 *
 * The implementation (electron-browser) forwards to electron-main over IPC, where
 * `git` is actually spawned. There is NO web/browser implementation: the sandboxed
 * renderer cannot fork, so callers resolve this service optionally
 * (`invokeFunction(acc => acc.get(IChiposGitService))` in a try/catch) and degrade
 * gracefully — git context is dropped, file-stat counting falls back to
 * IFileService, and clone-from-git reports "git is not available".
 */
export interface IChiposGitService {
	readonly _serviceBrand: undefined;
	exec(args: IChiposGitExecArgs): Promise<IChiposGitExecResult>;
}
