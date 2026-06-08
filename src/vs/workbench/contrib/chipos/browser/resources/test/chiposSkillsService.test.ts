/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { ChiposSkillsService } from '../chiposSkillsService.js';
import { ChiposPluginsService } from '../chiposPluginsService.js';

/** Minimal IConfigurationService backing only get/update. */
class StubConfig {
	private readonly _s = new Map<string, unknown>();
	constructor(initial?: Record<string, unknown>) { for (const [k, v] of Object.entries(initial ?? {})) { this._s.set(k, v); } }
	getValue<T>(key: string): T | undefined { return this._s.get(key) as T; }
	async updateValue(key: string, value: unknown): Promise<void> { this._s.set(key, value); }
}

/**
 * FEAT-003 / B5 — ChiposSkillsService.readBody: project + user planes (ungated),
 * plugin-contributed skills gated on workspace trust ("untrusted plugin"), and the
 * maxBodySize truncation. In-memory FS + stub trust/instantiation (the plugin path
 * createInstances a real ChiposPluginsService over the same in-mem FS).
 */
suite('ChiposSkillsService.readBody (FEAT-003 / B5)', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();
	const SCHEME = 'test-skills';
	const HOME = URI.from({ scheme: SCHEME, path: '/home/user' });
	const ROOT = URI.from({ scheme: SCHEME, path: '/ws' });
	let fileService: FileService;

	setup(() => {
		fileService = ds.add(new FileService(new NullLogService()));
		ds.add(fileService.registerProvider(SCHEME, ds.add(new InMemoryFileSystemProvider())));
	});

	const write = (uri: URI, c: string): Promise<unknown> => fileService.writeFile(uri, VSBuffer.fromString(c));

	const makeService = (opts: { trusted: boolean; config?: Record<string, unknown> }): ChiposSkillsService => {
		const config = new StubConfig(opts.config) as unknown as IConfigurationService;
		const workspaceService = { getWorkspace: () => ({ folders: [{ uri: ROOT }] }) } as unknown as IWorkspaceContextService;
		const pathService = { userHome: async () => HOME } as unknown as IPathService;
		const trust = { isWorkspaceTrusted: () => opts.trusted } as unknown as IWorkspaceTrustManagementService;
		const plugins = new ChiposPluginsService(fileService, pathService, config, {} as IInstantiationService);
		const insta = { createInstance: (ctor: unknown) => { if (ctor === ChiposPluginsService) { return plugins; } throw new Error('unexpected createInstance'); } } as unknown as IInstantiationService;
		return new ChiposSkillsService(fileService, workspaceService, pathService, config, insta, trust);
	};

	test('workspace skill → body; unknown → not found; traversal → invalid', async () => {
		await write(URI.joinPath(ROOT, '.chipos', 'skills', 'ws', 'SKILL.md'), '---\ndescription: d\n---\nWORKSPACE BODY');
		const svc = makeService({ trusted: true });
		assert.deepStrictEqual(
			{
				ws: await svc.readBody('ws'),
				unknownErr: (await svc.readBody('nope')).isError,
				traversalErr: (await svc.readBody('../evil')).isError,
			},
			{ ws: { content: 'WORKSPACE BODY', isError: false }, unknownErr: true, traversalErr: true },
		);
	});

	test('oversized body → truncated with marker', async () => {
		await write(URI.joinPath(ROOT, '.chipos', 'skills', 'big', 'SKILL.md'), '---\ndescription: d\n---\n' + 'x'.repeat(50));
		const r = await makeService({ trusted: true, config: { 'chipos.skills.maxBodySize': 10 } }).readBody('big');
		assert.deepStrictEqual(
			{ isError: r.isError, capped: r.content.startsWith('xxxxxxxxxx'), truncated: r.content.includes('[truncated') },
			{ isError: false, capped: true, truncated: true },
		);
	});

	test('plugin skill: untrusted workspace → error; trusted → body', async () => {
		await write(URI.joinPath(HOME, '.chipos-ide', 'plugins', 'myplug', '.chipos-plugin', 'plugin.json'), JSON.stringify({ name: 'myplug', id: 'myplug', version: '0.0.1' }));
		await write(URI.joinPath(HOME, '.chipos-ide', 'plugins', 'myplug', 'skills', 'p', 'SKILL.md'), '---\ndescription: d\n---\nPLUGIN BODY');
		const untrusted = await makeService({ trusted: false }).readBody('p');
		const trusted = await makeService({ trusted: true }).readBody('p');
		assert.deepStrictEqual(
			{ untrustedErr: untrusted.isError, untrustedMsg: /trust this workspace/i.test(untrusted.content), trusted },
			{ untrustedErr: true, untrustedMsg: true, trusted: { content: 'PLUGIN BODY', isError: false } },
		);
	});
});
