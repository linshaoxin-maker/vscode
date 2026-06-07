/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { CHIPOS_PLUGIN_HOOK_EVAL_CHANNEL, IPluginHookEvalArgs, IPluginHookDecision } from '../../../../platform/chipos/common/chiposPluginHook.js';
import { IChiposPluginHookService } from '../common/chiposPluginHookService.js';

/**
 * Electron implementation of {@link IChiposPluginHookService}: forwards each hook
 * evaluation to the main process over IPC, where the node child is forked. This is
 * the renderer end of the fix for the packaged-app sandbox (no `require` in the
 * renderer). Mirrors sidecarManagerElectron's ipcRenderer.invoke pattern.
 */
export class ChiposPluginHookElectron implements IChiposPluginHookService {
	declare readonly _serviceBrand: undefined;

	evaluate(args: IPluginHookEvalArgs): Promise<IPluginHookDecision> {
		return ipcRenderer.invoke(CHIPOS_PLUGIN_HOOK_EVAL_CHANNEL, args) as Promise<IPluginHookDecision>;
	}
}
