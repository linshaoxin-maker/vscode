/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared wire contract for the tier-2 executable-hook runner (FEAT, H-3).
 *
 * The sandboxed renderer has no Node `require`, so a consented plugin's hook
 * cannot be forked there in a packaged app. These types describe the
 * renderer → main IPC used to run the hook in an isolated node child IN THE MAIN
 * PROCESS instead. Kept in `platform/chipos/common` so the node runner, the
 * electron-main registration, and the workbench service interface all share one
 * definition.
 */

/** IPC channel: renderer → main, run a consented plugin hook in an isolated node child. */
export const CHIPOS_PLUGIN_HOOK_EVAL_CHANNEL = 'vscode:chipos:pluginHookEval';

/** Arguments for one executable-hook evaluation, sent renderer → main. Must be structuredClone-able. */
export interface IPluginHookEvalArgs {
	/** Absolute path to the plugin's hook module (resolved + traversal-guarded in the renderer). */
	readonly modulePath: string;
	/** Named export on the module to invoke. */
	readonly exportName: string;
	/** The hook context handed to the plugin code. Cloned across IPC and frozen in the child. */
	readonly ctx: object;
	/** Hard deadline; on expiry the child is killed and the decision is fail-closed. */
	readonly timeoutMs: number;
	/** When true (the default), every failure path resolves to `deny`. */
	readonly failClosed: boolean;
}

/** The decision returned from the main-process hook runner. */
export interface IPluginHookDecision {
	readonly decision: 'proceed' | 'deny' | 'ask' | 'amend';
	readonly amendedArgs?: object;
	readonly agentMessage?: string;
	readonly userMessage?: string;
	readonly reason?: string;
}
