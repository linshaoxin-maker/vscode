/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IPluginHookEvalArgs, IPluginHookDecision } from '../../../../platform/chipos/common/chiposPluginHook.js';

export const IChiposPluginHookService = createDecorator<IChiposPluginHookService>('chiposPluginHookService');

/**
 * Renderer-facing handle to the main-process executable-hook runner (FEAT, H-3).
 *
 * The implementation (electron-browser) forwards to electron-main over IPC, where
 * the node child is forked. There is NO web/browser implementation: the sandboxed
 * renderer cannot fork, so the host (chiposPluginHookHost.ts) treats an absent
 * service as fail-closed.
 */
export interface IChiposPluginHookService {
	readonly _serviceBrand: undefined;
	evaluate(args: IPluginHookEvalArgs): Promise<IPluginHookDecision>;
}
