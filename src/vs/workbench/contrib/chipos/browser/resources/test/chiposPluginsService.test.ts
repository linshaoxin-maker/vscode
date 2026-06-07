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
		// No git service in tests; installFromGit is always driven with an injected
		// cloneToTemp, so the resolver is never invoked.
		const instantiationService = { invokeFunction: () => { throw new Error('no git in tests'); } } as any;
		service = new ChiposPluginsService(fileService, pathService, config as unknown as IConfigurationService, instantiationService);
	});

	const pluginRoot = (id: string): URI => URI.joinPath(HOME, '.chipos-ide', 'plugins', id);
	const write = (uri: URI, contents: string): Promise<unknown> => fileService.writeFile(uri, VSBuffer.fromString(contents));

	/** Install a fixture plugin contributing one rule, one command, one skill and one hook. */
	async function installFixture(id: string): Promise<void> {
		const root = pluginRoot(id);
		await write(URI.joinPath(root, '.chipos-plugin', 'plugin.json'), `{"name":"${id}","version":"1.0.0"}`);
		await write(URI.joinPath(root, 'rules', 'r.mdc'), 'plugin rule body');
		await write(URI.joinPath(root, 'commands', 'c.md'), 'plugin command body');
		await write(URI.joinPath(root, 'skills', 's', 'SKILL.md'), '---\ndescription: a skill\n---\nbody');
		await write(URI.joinPath(root, 'hooks', 'h.json'), '{"point":"tool.before_dispatch","action":"deny","tool_name":"run_in_terminal"}');
	}

	test('an enabled plugin contributes its rule/command/skill/hook; disabling removes all four', async () => {
		await installFixture('p');

		assert.strictEqual((await service.getPluginRules()).length, 1);
		assert.strictEqual((await service.getPluginCommands()).length, 1);
		assert.strictEqual((await service.getPluginSkills()).length, 1);
		assert.strictEqual((await service.getPluginHooks()).length, 1);

		await service.setPluginEnabled('p', false);

		assert.strictEqual((await service.getPluginRules()).length, 0);
		assert.strictEqual((await service.getPluginCommands()).length, 0);
		assert.strictEqual((await service.getPluginSkills()).length, 0);
		assert.strictEqual((await service.getPluginHooks()).length, 0);
	});

	test('plugin hook carries source=plugin and source_ref=<plugin id>', async () => {
		await installFixture('p');

		const hooks = await service.getPluginHooks();
		assert.strictEqual(hooks.length, 1);
		assert.strictEqual(hooks[0].source, 'plugin');
		assert.strictEqual(hooks[0].source_ref, 'p');
		assert.strictEqual(hooks[0].point, 'tool.before_dispatch');
		assert.strictEqual(hooks[0].action, 'deny');
	});

	test('getPluginHooks parses a guard.json array, skips disabled plugins, and tolerates a missing hooks dir', async () => {
		// Plugin contributing a hooks/guard.json array of [{point,action,tool_name?,reason?}].
		const guardRoot = pluginRoot('guard');
		await write(URI.joinPath(guardRoot, '.chipos-plugin', 'plugin.json'), '{"name":"guard","version":"1.0.0"}');
		await write(URI.joinPath(guardRoot, 'hooks', 'guard.json'), JSON.stringify([
			{ point: 'tool.before_dispatch', action: 'deny', tool_name: 'run_in_terminal', reason: 'no shell' },
			{ point: 'tool.after_result', action: 'observe' },
		]));

		// A plugin with NO hooks/ dir contributes nothing (and must not throw).
		const bareRoot = pluginRoot('bare');
		await write(URI.joinPath(bareRoot, '.chipos-plugin', 'plugin.json'), '{"name":"bare","version":"1.0.0"}');

		// Enabled: both array entries are parsed, both tagged source=plugin / source_ref=<id>.
		assert.deepStrictEqual(await service.getPluginHooks(), [
			{ point: 'tool.before_dispatch', action: 'deny', source: 'plugin', source_ref: 'guard', tool_name: 'run_in_terminal', reason: 'no shell' },
			{ point: 'tool.after_result', action: 'observe', source: 'plugin', source_ref: 'guard' },
		]);

		// Disabled (id in chipos.plugins.disabled): contributes no hooks.
		await service.setPluginEnabled('guard', false);
		assert.deepStrictEqual(await service.getPluginHooks(), []);
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

	suite('installFromGit (FEAT-002b)', () => {
		const TEMP = URI.from({ scheme: SCHEME, path: '/clone-tmp' });

		// A fake clone that "checks out" a plugin (just a manifest) into a temp
		// dir on the in-memory FS, standing in for the real git clone.
		const fakeClone = (manifest: string) => async (): Promise<URI> => {
			await write(URI.joinPath(TEMP, '.chipos-plugin', 'plugin.json'), manifest);
			return TEMP;
		};

		test('rejects a non-allow-listed host before cloning (default allow-list = github.com)', async () => {
			let cloned = false;
			await assert.rejects(
				service.installFromGit('https://evil.example.com/x', async () => { cloned = true; return TEMP; }),
				/untrusted host/i,
			);
			assert.strictEqual(cloned, false);
			assert.strictEqual((await service.getInstalledPlugins()).length, 0);
		});

		test('clones an allow-listed repo, installs it, and removes the temp clone', async () => {
			const result = await service.installFromGit('https://github.com/owner/gitplug.git', fakeClone('{"name":"gitplug","version":"3.1.0"}'));

			assert.strictEqual(result.manifest.name, 'gitplug');
			assert.strictEqual(await fileService.exists(pluginRoot('gitplug')), true);
			assert.strictEqual(await fileService.exists(TEMP), false); // temp clone cleaned
		});

		test('removes the temp clone even when the install fails (bad manifest)', async () => {
			await assert.rejects(
				service.installFromGit('https://github.com/owner/bad.git', fakeClone('{"name":"bad"}')), // missing version
				/version/i,
			);
			assert.strictEqual(await fileService.exists(TEMP), false);
			assert.strictEqual((await service.getInstalledPlugins()).length, 0);
		});

		test('honours chipos.plugins.allowedGitDomains config', async () => {
			await config.updateValue('chipos.plugins.allowedGitDomains', ['gitlab.com']);
			await assert.rejects(service.installFromGit('https://github.com/x.git', fakeClone('{"name":"x","version":"1.0.0"}')), /untrusted host/i);

			const result = await service.installFromGit('https://gitlab.com/owner/gl.git', fakeClone('{"name":"gl","version":"1.0.0"}'));
			assert.strictEqual(result.manifest.name, 'gl');
		});
	});
});
