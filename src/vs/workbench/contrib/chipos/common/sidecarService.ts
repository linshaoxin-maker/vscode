/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const enum SidecarState {
	NotStarted = 'NotStarted',
	Spawning = 'Spawning',
	HealthChecking = 'HealthChecking',
	Connected = 'Connected',
	Disconnected = 'Disconnected',
	Error = 'Error',
}

export const ISidecarManagerService = createDecorator<ISidecarManagerService>('chiposSidecarManagerService');

export interface ISidecarManagerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<SidecarState>;
	readonly state: SidecarState;
	readonly port: number;

	/**
	 * Returns the WebSocket URL for connecting to the sidecar backend.
	 * Format: `ws://127.0.0.1:{port}/ws/agent`
	 */
	readonly wsUrl: string;

	spawn(): Promise<void>;
	kill(): Promise<void>;

	/**
	 * Set a manual URL for development mode. When set, {@link spawn}
	 * skips process creation and immediately transitions to Connected.
	 */
	setManualUrl(url: string | undefined): void;
}
