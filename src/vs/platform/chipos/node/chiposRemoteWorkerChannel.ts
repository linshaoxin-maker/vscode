/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * IServerChannel adapter for IChiposRemoteWorkerService.
 *
 * Registered in serverServices.ts so the local IDE can `getChannel('chipos-worker')`
 * via IRemoteAgentService.
 */

import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IChiposRemoteWorkerService, IEnsureRemoteWorkerArgs, IReleaseRemoteWorkerArgs } from '../common/chiposRemoteWorker.js';

export class ChiposRemoteWorkerChannel<TContext> implements IServerChannel<TContext> {

	constructor(
		private readonly _service: IChiposRemoteWorkerService,
	) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not supported: ${event}`);
	}

	async call<T>(_ctx: TContext, command: string, args?: unknown): Promise<T> {
		switch (command) {
			case 'ensureWorker':
				return await this._service.ensureWorker(args as IEnsureRemoteWorkerArgs) as T;
			case 'releaseWorker':
				return await this._service.releaseWorker(args as IReleaseRemoteWorkerArgs) as unknown as T;
			default:
				throw new Error(`Invalid call: ${command}`);
		}
	}
}
