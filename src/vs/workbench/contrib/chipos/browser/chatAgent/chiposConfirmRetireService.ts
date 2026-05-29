/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChipOSConfirmRetireService — agent → confirm-card retire channel.
 *
 * The stateless reasoner path (ADR-018) can re-emit a confirm card after a
 * reasoner restart: when the reasoner crashes while a permission card is up,
 * the IDE's /resume rehydrate re-drives the agent loop, which emits a FRESH
 * `confirm_request` (new request_id). The ORIGINAL card — parked against a
 * now-dead request_id on the old reasoner — would otherwise linger with live
 * buttons next to the new card (two cards, one logical confirm).
 *
 * `ChipOSChatAgent` already owns a card → agent channel (the
 * `_chipos.resolveStatelessConfirm` command). This service is the reverse:
 * the agent fires `retire(requestId)` and the matching
 * `ChipOSPermissionCardContentPart` (subscribed by request_id) swaps its live
 * buttons to a "superseded" pill so only the new card stays actionable.
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IChipOSConfirmRetireService = createDecorator<IChipOSConfirmRetireService>('chiposConfirmRetireService');

export interface IChipOSConfirmRetireService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires the request_id of a confirm card that has been superseded (e.g. by
	 * a reasoner-restart rehydrate that re-emitted the confirm with a fresh
	 * request_id). The card matching that request_id retires its live buttons.
	 */
	readonly onRetire: Event<string>;

	/** Signal that the card for `requestId` should retire its live buttons. */
	retire(requestId: string): void;
}

export class ChipOSConfirmRetireService extends Disposable implements IChipOSConfirmRetireService {
	declare readonly _serviceBrand: undefined;

	private readonly _onRetire = this._register(new Emitter<string>());
	readonly onRetire = this._onRetire.event;

	retire(requestId: string): void {
		this._onRetire.fire(requestId);
	}
}

registerSingleton(IChipOSConfirmRetireService, ChipOSConfirmRetireService, InstantiationType.Delayed);
