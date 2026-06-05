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
import { PluginManifestError, installLocalPlugin, parsePluginManifest } from '../pluginInstaller.js';

suite('pluginInstaller', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	suite('parsePluginManifest', () => {
		test('valid manifest parses name/version, defaults id to name, source chipos', () => {
			const m = parsePluginManifest('{"name":"my-plugin","version":"1.2.0","description":"d"}');
			assert.deepStrictEqual(
				{ id: m.id, name: m.name, version: m.version, description: m.description, source: m.source },
				{ id: 'my-plugin', name: 'my-plugin', version: '1.2.0', description: 'd', source: 'chipos' },
			);
		});

		test('missing name is rejected', () => {
			assert.throws(() => parsePluginManifest('{"version":"1.0.0"}'), PluginManifestError);
		});

		test('missing version is rejected', () => {
			assert.throws(() => parsePluginManifest('{"name":"x"}'), PluginManifestError);
		});

		test('invalid JSON is rejected', () => {
			assert.throws(() => parsePluginManifest('{not valid json'), PluginManifestError);
		});

		test('cursor source is tagged source=cursor', () => {
			const m = parsePluginManifest('{"name":"c","version":"0.1.0"}', 'cursor');
			assert.strictEqual(m.source, 'cursor');
		});
	});

	suite('installLocalPlugin', () => {
		const SCHEME = 'test-plugins';
		let fileService: FileService;

		setup(() => {
			fileService = ds.add(new FileService(new NullLogService()));
			ds.add(fileService.registerProvider(SCHEME, ds.add(new InMemoryFileSystemProvider())));
		});

		const dir = (path: string): URI => URI.from({ scheme: SCHEME, path });
		const write = (uri: URI, contents: string): Promise<unknown> => fileService.writeFile(uri, VSBuffer.fromString(contents));
		const read = async (uri: URI): Promise<string> => (await fileService.readFile(uri)).value.toString();

		test('copies a valid plugin tree into <pluginsRoot>/<id>/ and returns its manifest', async () => {
			const src = dir('/src/my-plugin');
			await write(URI.joinPath(src, '.chipos-plugin', 'plugin.json'), '{"name":"my-plugin","version":"2.0.0"}');
			await write(URI.joinPath(src, 'rules', 'style.mdc'), 'be terse');
			const root = dir('/home/.chipos-ide/plugins');

			const result = await installLocalPlugin(fileService, src, root);

			assert.strictEqual(result.manifest.name, 'my-plugin');
			assert.strictEqual(result.installedAt.toString(), URI.joinPath(root, 'my-plugin').toString());
			assert.strictEqual(await read(URI.joinPath(root, 'my-plugin', 'rules', 'style.mdc')), 'be terse');
		});

		test('rejects a folder whose manifest is missing required fields', async () => {
			const src = dir('/src/bad');
			await write(URI.joinPath(src, '.chipos-plugin', 'plugin.json'), '{"version":"1.0.0"}');
			await assert.rejects(installLocalPlugin(fileService, src, dir('/root')), PluginManifestError);
		});

		test('rejects a folder with no manifest at all', async () => {
			const src = dir('/src/empty');
			await write(URI.joinPath(src, 'readme.txt'), 'nothing here');
			await assert.rejects(installLocalPlugin(fileService, src, dir('/root')), PluginManifestError);
		});

		test('imports a Cursor .cursor-plugin manifest tagged source=cursor', async () => {
			const src = dir('/src/curs');
			await write(URI.joinPath(src, '.cursor-plugin', 'plugin.json'), '{"name":"curs","version":"0.3.0"}');
			const root = dir('/root');

			const result = await installLocalPlugin(fileService, src, root);

			assert.strictEqual(result.manifest.source, 'cursor');
			assert.strictEqual(await fileService.exists(URI.joinPath(root, 'curs', '.cursor-plugin', 'plugin.json')), true);
		});

		test('reinstall overwrites an existing install of the same id (clean replace, not merge)', async () => {
			const root = dir('/root');
			const src1 = dir('/src/v1');
			await write(URI.joinPath(src1, '.chipos-plugin', 'plugin.json'), '{"name":"p","version":"1.0.0"}');
			await write(URI.joinPath(src1, 'rules', 'a.mdc'), 'A');
			await installLocalPlugin(fileService, src1, root);

			const src2 = dir('/src/v2');
			await write(URI.joinPath(src2, '.chipos-plugin', 'plugin.json'), '{"name":"p","version":"2.0.0"}');
			await write(URI.joinPath(src2, 'rules', 'b.mdc'), 'B');
			const result = await installLocalPlugin(fileService, src2, root);

			assert.strictEqual(result.manifest.version, '2.0.0');
			assert.strictEqual(await fileService.exists(URI.joinPath(root, 'p', 'rules', 'a.mdc')), false);
			assert.strictEqual(await fileService.exists(URI.joinPath(root, 'p', 'rules', 'b.mdc')), true);
		});
	});
});
