/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { ChiposPluginsService } from '../chiposPluginsService.js';

/** Minimal IConfigurationService backing only the get/update used by the service. */
class StubConfigurationService {
	private readonly _store = new Map<string, unknown>();
	getValue<T>(key: string): T | undefined { return this._store.get(key) as T; }
	async updateValue(key: string, value: unknown): Promise<void> { this._store.set(key, value); }
}

suite('ChiposPluginsService', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();
	const SCHEME = 'test-plugins';
	const HOME = URI.from({ scheme: SCHEME, path: '/home/user' });

	let fileService: FileService;
	let config: StubConfigurationService;
	let service: ChiposPluginsService;

	setup(() => {
		fileService = ds.add(new FileService(new NullLogService()));
		ds.add(fileService.registerProvider(SCHEME, ds.add(new InMemoryFileSystemProvider())));
		config = new StubConfigurationService();
		const pathService = { userHome: async () => HOME } as unknown as IPathService;
		service = new ChiposPluginsService(fileService, pathService, config as unknown as IConfigurationService);
	});

	const pluginRoot = (id: string): URI => URI.joinPath(HOME, '.chipos-ide', 'plugins', id);
	const write = (uri: URI, contents: string): Promise<unknown> => fileService.writeFile(uri, VSBuffer.fromString(contents));

	/** Install a fixture plugin contributing one rule, one command and one skill. */
	async function installFixture(id: string): Promise<void> {
		const root = pluginRoot(id);
		await write(URI.joinPath(root, '.chipos-plugin', 'plugin.json'), `{"name":"${id}","version":"1.0.0"}`);
		await write(URI.joinPath(root, 'rules', 'r.mdc'), 'plugin rule body');
		await write(URI.joinPath(root, 'commands', 'c.md'), 'plugin command body');
		await write(URI.joinPath(root, 'skills', 's', 'SKILL.md'), '---\ndescription: a skill\n---\nbody');
	}

	test('an enabled plugin contributes its rule/command/skill; disabling removes all three', async () => {
		await installFixture('p');

		assert.strictEqual((await service.getPluginRules()).length, 1);
		assert.strictEqual((await service.getPluginCommands()).length, 1);
		assert.strictEqual((await service.getPluginSkills()).length, 1);

		await service.setPluginEnabled('p', false);

		assert.strictEqual((await service.getPluginRules()).length, 0);
		assert.strictEqual((await service.getPluginCommands()).length, 0);
		assert.strictEqual((await service.getPluginSkills()).length, 0);
	});

	test('setPluginEnabled round-trips through config; isPluginEnabled reflects it', async () => {
		assert.strictEqual(service.isPluginEnabled('p'), true); // default: not disabled

		await service.setPluginEnabled('p', false);
		assert.strictEqual(service.isPluginEnabled('p'), false);
		assert.deepStrictEqual(config.getValue<string[]>('chipos.plugins.disabled'), ['p']);

		await service.setPluginEnabled('p', true);
		assert.strictEqual(service.isPluginEnabled('p'), true);
		assert.deepStrictEqual(config.getValue<string[]>('chipos.plugins.disabled'), []);
	});

	test('summaries list disabled plugins too, with enabled=false and counts intact', async () => {
		await installFixture('p');
		await service.setPluginEnabled('p', false);

		const summaries = await service.getInstalledPluginSummaries();
		assert.strictEqual(summaries.length, 1);
		assert.strictEqual(summaries[0].enabled, false);
		assert.deepStrictEqual(
			{ rules: summaries[0].ruleCount, commands: summaries[0].commandCount, skills: summaries[0].skillCount },
			{ rules: 1, commands: 1, skills: 1 },
		);
	});

	test('uninstall deletes the plugin folder and clears a stale disabled entry', async () => {
		await installFixture('p');
		await service.setPluginEnabled('p', false);
		assert.strictEqual(await fileService.exists(pluginRoot('p')), true);

		await service.uninstall('p');

		assert.strictEqual(await fileService.exists(pluginRoot('p')), false);
		assert.strictEqual((await service.getInstalledPlugins()).length, 0);
		// disabled set cleaned so a future reinstall of the same id starts enabled
		assert.deepStrictEqual(config.getValue<string[]>('chipos.plugins.disabled'), []);
	});

	test('disabling one plugin leaves another enabled plugin contributing', async () => {
		await installFixture('keep');
		await installFixture('drop');
		await service.setPluginEnabled('drop', false);

		const rules = await service.getPluginRules();
		assert.strictEqual(rules.length, 1);
		assert.strictEqual(rules[0].sourceRef, 'keep');
	});
});
