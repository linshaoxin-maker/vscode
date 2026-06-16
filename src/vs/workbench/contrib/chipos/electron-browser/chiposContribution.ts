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

// FEAT H-3: executable-hook runner. Desktop forwards hook evaluation to the
// main-process node child via IPC (the sandboxed renderer cannot fork). No web
// impl — the host treats an absent service as fail-closed.
import { IChiposPluginHookService } from '../../../../workbench/contrib/chipos/common/chiposPluginHookService.js';
import { ChiposPluginHookElectron } from '../../../../workbench/contrib/chipos/electron-browser/chiposPluginHookElectron.js';
registerSingleton(IChiposPluginHookService, ChiposPluginHookElectron, InstantiationType.Delayed);

// ChipOS git runner. Desktop forwards `git` invocations to the main process via
// IPC (the sandboxed renderer has no `require('child_process')`). No web impl —
// callers resolve this service optionally and degrade (no git context / clone).
import { IChiposGitService } from '../../../../workbench/contrib/chipos/common/chiposGitService.js';
import { ChiposGitElectron } from '../../../../workbench/contrib/chipos/electron-browser/chiposGitElectron.js';
registerSingleton(IChiposGitService, ChiposGitElectron, InstantiationType.Delayed);

// Phase 1 Unified Auth: register auth services
import { IChipOSTokenManager, ChipOSTokenManager } from '../../../../workbench/contrib/chipos/browser/auth/chiposTokenManager.js';
import { IChipOSAuthService, ChipOSAuthService } from '../../../../workbench/contrib/chipos/browser/auth/chiposAuthService.js';
import { IChipOSOrgService, ChipOSOrgService } from '../../../../workbench/contrib/chipos/browser/auth/chiposOrgService.js';
registerSingleton(IChipOSTokenManager, ChipOSTokenManager, InstantiationType.Delayed);
registerSingleton(IChipOSAuthService, ChipOSAuthService, InstantiationType.Delayed);
registerSingleton(IChipOSOrgService, ChipOSOrgService, InstantiationType.Delayed);

// Phase 2 Usage polling: status bar widget showing /api/billing/usage
import { IChipOSUsageService, ChipOSUsageService } from '../../../../workbench/contrib/chipos/browser/billing/chiposUsageService.js';
registerSingleton(IChipOSUsageService, ChipOSUsageService, InstantiationType.Delayed);

// P2-14: per-window runtime URL overrides (replaces Global config writes
// from chipos-remote-ssh). See chiposRuntimeOverrides.ts header for rationale.
import { IChipOSRuntimeOverridesService, ChipOSRuntimeOverridesService } from '../../../../workbench/contrib/chipos/common/chiposRuntimeOverrides.js';
registerSingleton(IChipOSRuntimeOverridesService, ChipOSRuntimeOverridesService, InstantiationType.Delayed);

// ROADMAP §11 P2-d closure: side-effect import so EdaEnvHandler subscribes
// to the worker-stderr `[EdaEnv]` IPC channel at startup. Surfaces a
// notification + "Open install guide" button per missing EDA tool the
// worker reports during its environment scan.
import '../../../../workbench/contrib/chipos/electron-sandbox/edaEnvHandler.js';

// Tool resolver UX (Phase A): right-click actions on WORKER TOOLS panel rows.
// Action2 ctors register on import; menu contributions appear keyed by
// `viewItem == chiposImplTool:<impl>:<state>` set in workerToolManager's
// `_toImplToolItem`. Without this import the panel shows tool rows but the
// context menu is empty.
import '../../../../workbench/contrib/chipos/browser/edaToolActions.js';

import '../../../../workbench/contrib/chipos/common/chiposContribution.js';
