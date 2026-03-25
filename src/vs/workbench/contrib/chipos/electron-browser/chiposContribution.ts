/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISidecarManagerService } from '../../../../workbench/contrib/chipos/common/sidecarService.js';
import { SidecarManagerBrowser } from '../../../../workbench/contrib/chipos/browser/sidecarManagerBrowser.js';

// NOTE: VS Code's renderer is sandboxed (sandbox: true) — static ESM imports of
// bare Node.js specifiers (child_process, fs, net …) fail at module-link time.
// The node/sidecarManager.ts must NOT be imported here.
// SidecarManagerBrowser provides a renderer-safe implementation that connects to
// pre-started backends via URL. For local auto-spawn (Scenario A), a future
// IPC-based SidecarManagerElectron should delegate spawning to the main/utility process.
registerSingleton(ISidecarManagerService, SidecarManagerBrowser, InstantiationType.Delayed);

import '../../../../workbench/contrib/chipos/common/chiposContribution.js';
