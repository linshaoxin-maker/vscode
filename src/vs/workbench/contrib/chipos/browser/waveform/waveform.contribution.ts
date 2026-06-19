/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ChiposWaveformService, IChiposWaveformService } from './chiposWaveformService.js';

// The waveform *control* is a thin, programmatic wrapper around the
// `lramseyer.vaporview` builtin extension (custom editor + add/reveal commands).
// It has no view of its own — the dev command + (later) the agent
// `viewer_action` driver call `IChiposWaveformService.openWaveform()`. Only the
// DI service is registered here, mirroring `moduleHierarchy.contribution.ts`.
registerSingleton(IChiposWaveformService, ChiposWaveformService, InstantiationType.Delayed);
