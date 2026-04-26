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

// Phase 1 Unified Auth: register auth services
import { IChipOSTokenManager, ChipOSTokenManager } from '../../../../workbench/contrib/chipos/browser/auth/chiposTokenManager.js';
import { IChipOSAuthService, ChipOSAuthService } from '../../../../workbench/contrib/chipos/browser/auth/chiposAuthService.js';
registerSingleton(IChipOSTokenManager, ChipOSTokenManager, InstantiationType.Delayed);
registerSingleton(IChipOSAuthService, ChipOSAuthService, InstantiationType.Delayed);

// Phase 2 Usage polling: status bar widget showing /api/billing/usage
import { IChipOSUsageService, ChipOSUsageService } from '../../../../workbench/contrib/chipos/browser/billing/chiposUsageService.js';
registerSingleton(IChipOSUsageService, ChipOSUsageService, InstantiationType.Delayed);

// P2-14: per-window runtime URL overrides (replaces Global config writes
// from chipos-remote-ssh). See chiposRuntimeOverrides.ts header for rationale.
import { IChipOSRuntimeOverridesService, ChipOSRuntimeOverridesService } from '../../../../workbench/contrib/chipos/common/chiposRuntimeOverrides.js';
registerSingleton(IChipOSRuntimeOverridesService, ChipOSRuntimeOverridesService, InstantiationType.Delayed);

import '../../../../workbench/contrib/chipos/common/chiposContribution.js';
