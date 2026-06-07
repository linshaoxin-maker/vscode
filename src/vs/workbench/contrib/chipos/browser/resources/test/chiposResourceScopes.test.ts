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
	RESOURCE_LAYOUTS, ECOSYSTEM_RESOURCE_DIRS, ResourceKind, ResourceScope,
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
		test('workspace + user-global dirs and ordered planes (no ecosystem dirs → chipos only)', async () => {
			const folder = URI.from({ scheme: SCHEME, path: '/ws' });
			assert.strictEqual(workspaceResourceDir(folder, 'skills').path, '/ws/.chipos/skills');
			assert.strictEqual((await userGlobalResourceDir(fakePathService, 'rules')).path, '/home/u/.chipos-ide/rules');

			// hooks have no ecosystem form, so only the chipos planes appear.
			const planes = await resourcePlanes(fakePathService, [folder], 'hooks');
			assert.deepStrictEqual(planes.map(p => [p.scope, p.dir.path]), [
				['workspace', '/ws/.chipos/hooks'],
				['user', '/home/u/.chipos-ide/hooks'],
			]);
		});

		test('ecosystem planes follow the chipos plane within each scope (first-wins precedence)', async () => {
			const a = URI.from({ scheme: SCHEME, path: '/ws-a' });
			const b = URI.from({ scheme: SCHEME, path: '/ws-b' });
			// commands has both a Claude and a Cursor ecosystem dir.
			const planes = await resourcePlanes(fakePathService, [a, b], 'commands');
			assert.deepStrictEqual(planes.map(p => [p.scope, p.dir.path]), [
				['workspace', '/ws-a/.chipos/commands'],
				['workspace', '/ws-a/.claude/commands'],
				['workspace', '/ws-a/.cursor/commands'],
				['workspace', '/ws-b/.chipos/commands'],
				['workspace', '/ws-b/.claude/commands'],
				['workspace', '/ws-b/.cursor/commands'],
				['user', '/home/u/.chipos-ide/commands'],
				['user', '/home/u/.claude/commands'],
				['user', '/home/u/.cursor/commands'],
			]);
		});

		test('rules + skills resolve their single ecosystem dir under both scopes', async () => {
			const folder = URI.from({ scheme: SCHEME, path: '/ws' });
			const rules = await resourcePlanes(fakePathService, [folder], 'rules');
			assert.deepStrictEqual(rules.map(p => [p.scope, p.dir.path]), [
				['workspace', '/ws/.chipos/rules'],
				['workspace', '/ws/.cursor/rules'],
				['user', '/home/u/.chipos-ide/rules'],
				['user', '/home/u/.cursor/rules'],
			]);
			const skills = await resourcePlanes(fakePathService, [folder], 'skills');
			assert.deepStrictEqual(skills.map(p => [p.scope, p.dir.path]), [
				['workspace', '/ws/.chipos/skills'],
				['workspace', '/ws/.claude/skills'],
				['user', '/home/u/.chipos-ide/skills'],
				['user', '/home/u/.claude/skills'],
			]);
		});

		test('ECOSYSTEM_RESOURCE_DIRS covers every kind (hooks intentionally empty)', () => {
			assert.deepStrictEqual(ECOSYSTEM_RESOURCE_DIRS, {
				rules: [['.cursor', 'rules']],
				commands: [['.claude', 'commands'], ['.cursor', 'commands']],
				skills: [['.claude', 'skills']],
				hooks: [],
			});
		});
	});

	suite('resourcePlanes ecosystem support', () => {
		// A tiny fake IPathService whose userHome() is a fixed file:// URI, plus one
		// workspace folder — exactly the inputs resourcePlanes() consumes.
		const HOME = URI.file('/home/u');
		const FOLDER = URI.file('/ws');
		const ecoPathService = { userHome: async () => HOME } as unknown as IPathService;
		const planePaths = async (kind: ResourceKind): Promise<string[]> =>
			(await resourcePlanes(ecoPathService, [FOLDER], kind)).map(p => p.dir.path);

		test('commands: chipos + Claude + Cursor planes under both the folder and home', async () => {
			const paths = await planePaths('commands');
			// Every chipos and ecosystem command plane the spec requires is present.
			for (const expected of [
				URI.joinPath(FOLDER, '.chipos', 'commands').path,
				URI.joinPath(FOLDER, '.claude', 'commands').path,
				URI.joinPath(FOLDER, '.cursor', 'commands').path,
				URI.joinPath(HOME, '.chipos-ide', 'commands').path,
				URI.joinPath(HOME, '.claude', 'commands').path,
				URI.joinPath(HOME, '.cursor', 'commands').path,
			]) {
				assert.ok(paths.includes(expected), `missing command plane ${expected} in ${JSON.stringify(paths)}`);
			}
			// Snapshot the full ordered set so a drift in either order or membership fails.
			assert.deepStrictEqual(paths, [
				'/ws/.chipos/commands',
				'/ws/.claude/commands',
				'/ws/.cursor/commands',
				'/home/u/.chipos-ide/commands',
				'/home/u/.claude/commands',
				'/home/u/.cursor/commands',
			]);
		});

		test('rules: includes the Cursor plane but NOT a .claude/rules plane', async () => {
			const paths = await planePaths('rules');
			assert.ok(paths.includes(URI.joinPath(FOLDER, '.cursor', 'rules').path), 'expected the folder .cursor/rules plane');
			// rules has no Claude ecosystem form — assert none leaks in, under either scope.
			assert.ok(!paths.some(p => p.endsWith('/.claude/rules')), `no .claude/rules plane expected, got ${JSON.stringify(paths)}`);
			assert.deepStrictEqual(paths, [
				'/ws/.chipos/rules',
				'/ws/.cursor/rules',
				'/home/u/.chipos-ide/rules',
				'/home/u/.cursor/rules',
			]);
		});

		test('hooks: chipos planes only — no .claude/.cursor dirs (no ecosystem form)', async () => {
			const paths = await planePaths('hooks');
			assert.ok(paths.includes(URI.joinPath(FOLDER, '.chipos', 'hooks').path), 'expected the folder .chipos/hooks plane');
			assert.ok(paths.includes(URI.joinPath(HOME, '.chipos-ide', 'hooks').path), 'expected the home .chipos-ide/hooks plane');
			assert.ok(!paths.some(p => p.includes('/.claude/') || p.includes('/.cursor/')), `no ecosystem hook planes expected, got ${JSON.stringify(paths)}`);
			assert.deepStrictEqual(paths, [
				'/ws/.chipos/hooks',
				'/home/u/.chipos-ide/hooks',
			]);
		});

		test('the chipos plane precedes the ecosystem planes of the same scope (first-wins)', async () => {
			// commands carries ecosystem planes in both scopes — check chipos comes first in each.
			const planes = await resourcePlanes(ecoPathService, [FOLDER], 'commands');
			const idxIn = (scope: ResourceScope, pathEnd: string): number =>
				planes.findIndex(p => p.scope === scope && p.dir.path.endsWith(pathEnd));

			// workspace scope: .chipos/commands before .claude/commands and .cursor/commands
			assert.ok(idxIn('workspace', '/.chipos/commands') < idxIn('workspace', '/.claude/commands'));
			assert.ok(idxIn('workspace', '/.chipos/commands') < idxIn('workspace', '/.cursor/commands'));
			// user scope: .chipos-ide/commands before .claude/commands and .cursor/commands
			assert.ok(idxIn('user', '/.chipos-ide/commands') < idxIn('user', '/.claude/commands'));
			assert.ok(idxIn('user', '/.chipos-ide/commands') < idxIn('user', '/.cursor/commands'));
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
