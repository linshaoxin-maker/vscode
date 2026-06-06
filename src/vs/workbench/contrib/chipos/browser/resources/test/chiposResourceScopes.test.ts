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
import {
	RESOURCE_LAYOUTS, ResourceKind, ResourceScope,
	workspaceResourceDir, userGlobalResourceDir, resourcePlanes,
	disabledConfigKey, resourceStateId, isResourceEnabled, setResourceEnabled,
	scanResourcePlane, findImportableResources, copyResourceEntry,
} from '../chiposResourceScopes.js';

/** Minimal Map-backed IConfigurationService — only getValue/updateValue are used. */
function fakeConfig(initial?: Record<string, unknown>): IConfigurationService {
	const store = new Map<string, unknown>(Object.entries(initial ?? {}));
	return {
		getValue: (key: string) => store.get(key),
		updateValue: async (key: string, value: unknown) => { store.set(key, value); },
	} as unknown as IConfigurationService;
}

const SCHEME = 'test-res';
const fakePathService = { userHome: async () => URI.from({ scheme: SCHEME, path: '/home/u' }) } as unknown as IPathService;

suite('chiposResourceScopes', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	suite('plane resolution', () => {
		test('workspace + user-global dirs and ordered planes (workspace first)', async () => {
			const folder = URI.from({ scheme: SCHEME, path: '/ws' });
			assert.strictEqual(workspaceResourceDir(folder, 'skills').path, '/ws/.chipos/skills');
			assert.strictEqual((await userGlobalResourceDir(fakePathService, 'rules')).path, '/home/u/.chipos-ide/rules');

			const planes = await resourcePlanes(fakePathService, [folder], 'hooks');
			assert.deepStrictEqual(planes.map(p => [p.scope, p.dir.path]), [
				['workspace', '/ws/.chipos/hooks'],
				['user', '/home/u/.chipos-ide/hooks'],
			]);
		});
	});

	suite('enable/disable state (scope-qualified)', () => {
		test('disabling one scope leaves the same name in the other scope enabled', async () => {
			const config = fakeConfig();
			const kind: ResourceKind = 'skills';
			assert.strictEqual(isResourceEnabled(config, kind, 'workspace', 'deploy'), true);

			await setResourceEnabled(config, kind, 'workspace', 'deploy', false);
			assert.deepStrictEqual(config.getValue(disabledConfigKey(kind)), ['workspace:deploy']);
			assert.strictEqual(isResourceEnabled(config, kind, 'workspace', 'deploy'), false);
			// same name, other scope, still enabled
			assert.strictEqual(isResourceEnabled(config, kind, 'user', 'deploy'), true);

			// re-enabling removes just that id
			await setResourceEnabled(config, kind, 'workspace', 'deploy', true);
			assert.deepStrictEqual(config.getValue(disabledConfigKey(kind)), []);
		});

		test('id format + key naming', () => {
			assert.strictEqual(resourceStateId('user' as ResourceScope, 'x'), 'user:x');
			assert.strictEqual(disabledConfigKey('commands'), 'chipos.commands.disabled');
		});
	});

	suite('scanResourcePlane', () => {
		let fileService: FileService;
		setup(() => {
			fileService = ds.add(new FileService(new NullLogService()));
			ds.add(fileService.registerProvider(SCHEME, ds.add(new InMemoryFileSystemProvider())));
		});
		const write = (p: string, body = 'x') => fileService.writeFile(URI.from({ scheme: SCHEME, path: p }), VSBuffer.fromString(body));

		test('flat kind: matching files only, extension stripped for the name', async () => {
			await write('/ws/.chipos/rules/style.mdc');
			await write('/ws/.chipos/rules/review.md');
			await write('/ws/.chipos/rules/notes.png');
			await fileService.createFolder(URI.from({ scheme: SCHEME, path: '/ws/.chipos/rules/sub' }));
			const dir = URI.from({ scheme: SCHEME, path: '/ws/.chipos/rules' });
			const found = await scanResourcePlane(fileService, dir, 'workspace', RESOURCE_LAYOUTS.rules);
			assert.deepStrictEqual(found.map(r => r.name).sort(), ['review', 'style']);
			assert.strictEqual(found.every(r => r.scope === 'workspace' && r.entry.path === r.editFile.path), true);
		});

		test('hooks keep the extension in the id (per-file granularity)', async () => {
			await write('/ws/.chipos/hooks/no-terminal.json', '{"point":"tool.before_dispatch"}');
			const dir = URI.from({ scheme: SCHEME, path: '/ws/.chipos/hooks' });
			const found = await scanResourcePlane(fileService, dir, 'workspace', RESOURCE_LAYOUTS.hooks);
			assert.deepStrictEqual(found.map(r => r.name), ['no-terminal.json']);
		});

		test('skill kind: only subdirs with the marker; editFile is SKILL.md', async () => {
			await write('/ws/.chipos/skills/explain/SKILL.md', '---\ndescription: d\n---\nbody');
			await fileService.createFolder(URI.from({ scheme: SCHEME, path: '/ws/.chipos/skills/empty' }));
			const dir = URI.from({ scheme: SCHEME, path: '/ws/.chipos/skills' });
			const found = await scanResourcePlane(fileService, dir, 'user', RESOURCE_LAYOUTS.skills);
			assert.strictEqual(found.length, 1);
			assert.strictEqual(found[0].name, 'explain');
			assert.strictEqual(found[0].editFile.path, '/ws/.chipos/skills/explain/SKILL.md');
		});

		test('missing directory yields [] (never throws)', async () => {
			const dir = URI.from({ scheme: SCHEME, path: '/nope' });
			assert.deepStrictEqual(await scanResourcePlane(fileService, dir, 'user', RESOURCE_LAYOUTS.rules), []);
		});
	});

	suite('findImportableResources + copyResourceEntry', () => {
		let fileService: FileService;
		setup(() => {
			fileService = ds.add(new FileService(new NullLogService()));
			ds.add(fileService.registerProvider(SCHEME, ds.add(new InMemoryFileSystemProvider())));
		});
		const u = (p: string) => URI.from({ scheme: SCHEME, path: p });
		const write = (p: string, body = 'x') => fileService.writeFile(u(p), VSBuffer.fromString(body));

		test('flat: finds files at the tree root and in a <kind>/ subdir', async () => {
			await write('/clone/a.md');
			await write('/clone/commands/b.md');
			const found = await findImportableResources(fileService, u('/clone'), RESOURCE_LAYOUTS.commands);
			assert.deepStrictEqual(found.map(f => f.path.split('/').pop()).sort(), ['a.md', 'b.md']);
		});

		test('skill: finds a root-as-skill folder and skills/<id> subdirs', async () => {
			await write('/single/SKILL.md', '---\n---\nbody'); // the picked folder IS a skill
			const single = await findImportableResources(fileService, u('/single'), RESOURCE_LAYOUTS.skills);
			assert.deepStrictEqual(single.map(f => f.path), ['/single']);

			await write('/repo/skills/foo/SKILL.md', 'b');
			const repo = await findImportableResources(fileService, u('/repo'), RESOURCE_LAYOUTS.skills);
			assert.deepStrictEqual(repo.map(f => f.path), ['/repo/skills/foo']);
		});

		test('copyResourceEntry copies a flat file and returns the stripped name', async () => {
			await write('/src/x.mdc', 'rule');
			const name = await copyResourceEntry(fileService, u('/src/x.mdc'), RESOURCE_LAYOUTS.rules, u('/dest/.chipos/rules'), false);
			assert.strictEqual(name, 'x');
			assert.strictEqual((await fileService.readFile(u('/dest/.chipos/rules/x.mdc'))).value.toString(), 'rule');
		});

		test('copyResourceEntry copies a skill folder (with its marker)', async () => {
			await write('/src/mysk/SKILL.md', 'sk');
			const name = await copyResourceEntry(fileService, u('/src/mysk'), RESOURCE_LAYOUTS.skills, u('/dest/.chipos/skills'), false);
			assert.strictEqual(name, 'mysk');
			assert.strictEqual(await fileService.exists(u('/dest/.chipos/skills/mysk/SKILL.md')), true);
		});
	});
});
