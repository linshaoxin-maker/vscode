/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { computePluginMcpSync, pluginMcpWorkerName, PLUGIN_MCP_PREFIX } from '../pluginMcpSync.js';
import { PluginMcpServer } from '../chiposPluginsService.js';

/** FEAT-011b — pure plugin-MCP → worker reconciliation. */
suite('pluginMcpSync (FEAT-011b)', () => {

	const srv = (pluginId: string, name: string, config: Record<string, unknown>): PluginMcpServer => ({ pluginId, name, config });

	test('reconciles: register NEW discovered (prefixed name in config), drop stale plugin-tagged, never touch user servers', () => {
		const discovered = [srv('eda', 'vivado', { command: 'vivado-mcp', args: ['--stdio'] })];
		const plan = computePluginMcpSync(discovered, ['user-mcp', 'plugin.old.gone']);
		assert.deepStrictEqual(plan, {
			toRegister: [{ name: 'plugin.eda.vivado', config: { command: 'vivado-mcp', args: ['--stdio'], name: 'plugin.eda.vivado' } }],
			toRemove: ['plugin.old.gone'], // user-mcp untouched
		});
	});

	test('idempotent once synced: an already-registered plugin server yields no work', () => {
		assert.deepStrictEqual(
			computePluginMcpSync([srv('eda', 'vivado', { command: 'vivado-mcp' })], ['plugin.eda.vivado']),
			{ toRegister: [], toRemove: [] },
		);
	});

	test('no discovered servers removes every plugin-tagged server but keeps user servers', () => {
		assert.deepStrictEqual(
			computePluginMcpSync([], ['user-a', 'plugin.p.s1', 'plugin.q.s2']),
			{ toRegister: [], toRemove: ['plugin.p.s1', 'plugin.q.s2'] },
		);
	});

	test('worker name is plugin.<id>.<name>', () => {
		assert.strictEqual(pluginMcpWorkerName('eda', 'vivado'), `${PLUGIN_MCP_PREFIX}eda.vivado`);
	});
});
