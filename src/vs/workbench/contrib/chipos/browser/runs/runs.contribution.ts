/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IRunStorageService, RunStorageService } from './runStorageService.js';

// The Runs *view* (TreeView + TreeViewPane + title actions + detail command)
// is registered alongside the other ChipOS tree views inside
// `ChipOSContribution._initialize()` in `common/chiposContribution.ts`, so it
// shares the `chipos.tools` view container and the workbench lifecycle gating.
// Only the DI service is registered here, mirroring how
// `moduleHierarchy.contribution.ts` registers `IModuleHierarchyService`.
registerSingleton(IRunStorageService, RunStorageService, InstantiationType.Delayed);
