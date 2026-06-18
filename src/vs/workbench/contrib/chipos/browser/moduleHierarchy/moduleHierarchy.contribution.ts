/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IModuleHierarchyService, ModuleHierarchyService } from './moduleHierarchyService.js';

// The Module Hierarchy *view* (TreeView + TreeViewPane + title actions) is
// registered alongside the other ChipOS tree views inside
// `ChipOSContribution._initialize()` in `common/chiposContribution.ts`, so it
// shares the `chipos.tools` view container and the workbench lifecycle gating.
// Only the DI service is registered here, mirroring how `workerToolManager.ts`
// registers `IWorkerToolManagerService`.
registerSingleton(IModuleHierarchyService, ModuleHierarchyService, InstantiationType.Delayed);
