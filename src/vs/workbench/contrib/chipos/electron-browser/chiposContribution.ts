/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISidecarManagerService } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { SidecarManager } from '../../../../workbench/contrib/chipos/node/sidecarManager.js';

registerSingleton(ISidecarManagerService, SidecarManager, InstantiationType.Delayed);

import '../../../../workbench/contrib/chipos/common/chiposContribution.js';
