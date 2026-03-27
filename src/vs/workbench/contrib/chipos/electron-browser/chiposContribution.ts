/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISidecarManagerService } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { SidecarManagerElectron } from '../../../../workbench/contrib/chipos/electron-sandbox/sidecarManagerElectron.js';

// FEAT-R30: Electron desktop 使用 SidecarManagerElectron（通过 IPC 委托 main 进程 spawn）。
// Web IDE 模式仍使用 SidecarManagerBrowser（在 workbench.web.main.ts 中注册）。
registerSingleton(ISidecarManagerService, SidecarManagerElectron, InstantiationType.Delayed);

import '../../../../workbench/contrib/chipos/common/chiposContribution.js';
