/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';

/**
 * FEAT-004 B6 — in-memory audit trail of executable (tier-2) hook evaluations
 * (STRIDE-R repudiation). chatAgent records one entry per `_handleStatelessHookEval`
 * decision; the "ChipOS: Show Hook Execution Log" command renders the recent ones.
 *
 * NOTE: only EXECUTABLE/function hooks pass through the IDE (the renderer hands them
 * to the main-process child). Declarative deny/observe hooks are evaluated reasoner-
 * side and are NOT visible here — the log is intentionally scoped to executable hooks.
 */

export interface HookLogEntry {
	/** Epoch ms when the decision was recorded. */
	readonly at: number;
	readonly pluginId: string;
	readonly point: string;
	readonly toolName: string;
	readonly decision: string;
	readonly reason?: string;
}

export const IChiposHookLogService = createDecorator<IChiposHookLogService>('chiposHookLogService');

export interface IChiposHookLogService {
	readonly _serviceBrand: undefined;
	record(entry: HookLogEntry): void;
	/** Recent entries, newest first, capped. */
	recent(): readonly HookLogEntry[];
}

export class ChiposHookLogService implements IChiposHookLogService {
	declare readonly _serviceBrand: undefined;

	private static readonly MAX = 200;
	private readonly _entries: HookLogEntry[] = [];

	record(entry: HookLogEntry): void {
		this._entries.push(entry);
		if (this._entries.length > ChiposHookLogService.MAX) {
			this._entries.shift();
		}
	}

	recent(): readonly HookLogEntry[] {
		return this._entries.slice().reverse();
	}
}

registerSingleton(IChiposHookLogService, ChiposHookLogService, InstantiationType.Delayed);
