/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { PluginMcpServer } from './chiposPluginsService.js';

/**
 * FEAT-011b — pure reconciliation between the enabled plugins' contributed MCP
 * servers ({@link PluginMcpServer} from chiposPluginsService.getPluginMcp) and what
 * the worker currently has. Kept dependency-free so it unit-tests in node and the
 * driver (which talks to the worker) stays a thin caller.
 */

/** Worker-side name prefix for a plugin-contributed MCP server. */
export const PLUGIN_MCP_PREFIX = 'plugin.';

/** Collision-safe worker name for a plugin server: `plugin.<pluginId>.<name>`. */
export function pluginMcpWorkerName(pluginId: string, name: string): string {
	return `${PLUGIN_MCP_PREFIX}${pluginId}.${name}`;
}

export interface PluginMcpSyncPlan {
	/** Servers to upsert on the worker (worker-name + raw config carrying that name). */
	readonly toRegister: ReadonlyArray<{ readonly name: string; readonly config: Record<string, unknown> }>;
	/** Stale plugin-tagged worker server names to remove (plugin disabled/uninstalled). */
	readonly toRemove: string[];
}

/**
 * Reconcile the discovered plugin MCP servers against the worker's current server
 * names. Returns the upserts + the stale plugin-tagged removals.
 *
 * - `toRegister`: discovered servers NOT already on the worker, named
 *   `plugin.<id>.<name>` (collision-safe against user-added servers and across
 *   plugins), config carrying that name so the worker's `add_mcp_server` adds it.
 *   Only *new* servers are returned so the plan is empty once synced — the driver can
 *   run on every refresh without re-reloading the worker (idempotent steady state).
 * - `toRemove`: worker servers under the `plugin.` prefix that no longer correspond to
 *   an enabled plugin's contribution (the plugin was disabled or uninstalled).
 *
 * Non-plugin worker servers (user-added via the EDA Tools tab) are NEVER touched —
 * only the `plugin.`-prefixed namespace is reconciled. (A plugin server whose config
 * changed but keeps its name is not re-registered — a known MVP bound; remove + reopen
 * re-syncs it.)
 */
export function computePluginMcpSync(
	discovered: readonly PluginMcpServer[],
	existingNames: readonly string[],
): PluginMcpSyncPlan {
	const existing = new Set(existingNames);
	const desired = new Map<string, Record<string, unknown>>();
	for (const s of discovered) {
		const workerName = pluginMcpWorkerName(s.pluginId, s.name);
		// Carry the worker name into the config so add_mcp_server adds it under that name.
		desired.set(workerName, { ...s.config, name: workerName });
	}
	const toRegister = [...desired.entries()]
		.filter(([name]) => !existing.has(name))
		.map(([name, config]) => ({ name, config }));
	const toRemove = existingNames.filter(n => n.startsWith(PLUGIN_MCP_PREFIX) && !desired.has(n));
	return { toRegister, toRemove };
}
