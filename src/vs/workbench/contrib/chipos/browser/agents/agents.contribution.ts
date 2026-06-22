/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

// Side-effect import: pulling in `agentActivityStore` runs its
// `registerSingleton(IAgentActivityStore, …)` line, wiring the DI service.
// The Agents *view* (TreeView + TreeViewPane + title actions) is registered
// alongside the other ChipOS tree views inside `ChipOSContribution._initialize()`
// in `common/chiposContribution.ts`, so it shares the `chipos.tools` view
// container and the workbench lifecycle gating. Mirrors how
// `runs.contribution.ts` pulls in the `IRunStorageService` registration.
import './agentActivityStore.js';
