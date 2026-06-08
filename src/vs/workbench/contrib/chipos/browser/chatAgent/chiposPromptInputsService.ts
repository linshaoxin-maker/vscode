/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { CollectResult } from '../resources/promptResourceAttachmentCollector.js';

/**
 * FEAT-008 — holds the prompt resources collected for the MOST RECENT stateless
 * invoke, so the "ChipOS: Show Prompt Inputs" command can render what actually
 * went into this turn's prompt (GAP-20 observability). chatAgent writes via
 * {@link setLast} right after collection; the command reads via {@link getLast}.
 * In-memory, last-write-wins (a single value across chats is enough for a debug view).
 */

export interface PromptInputsSnapshot {
	readonly result: CollectResult;
	/** Active file the rules were collected against (drives glob rules); for display context. */
	readonly activeFile?: string;
}

export const IChiposPromptInputsService = createDecorator<IChiposPromptInputsService>('chiposPromptInputsService');

export interface IChiposPromptInputsService {
	readonly _serviceBrand: undefined;
	setLast(snapshot: PromptInputsSnapshot): void;
	getLast(): PromptInputsSnapshot | undefined;
}

export class ChiposPromptInputsService implements IChiposPromptInputsService {
	declare readonly _serviceBrand: undefined;

	private _last: PromptInputsSnapshot | undefined;

	setLast(snapshot: PromptInputsSnapshot): void {
		this._last = snapshot;
	}

	getLast(): PromptInputsSnapshot | undefined {
		return this._last;
	}
}

registerSingleton(IChiposPromptInputsService, ChiposPromptInputsService, InstantiationType.Delayed);
