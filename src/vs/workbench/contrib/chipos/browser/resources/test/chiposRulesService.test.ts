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
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { ChiposRulesService } from '../chiposRulesService.js';
import { RuleDescriptor } from '../promptResourceAttachmentCollector.js';

/** Minimal IConfigurationService backing only the get/update used by the service. */
class StubConfigurationService {
	private readonly _store = new Map<string, unknown>();
	constructor(initial?: Record<string, unknown>) {
		for (const [k, v] of Object.entries(initial ?? {})) {
			this._store.set(k, v);
		}
	}
	getValue<T>(key: string): T | undefined { return this._store.get(key) as T; }
	async updateValue(key: string, value: unknown): Promise<void> { this._store.set(key, value); }
}

suite('ChiposRulesService AGENTS.md/CLAUDE.md discovery', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();
	const SCHEME = 'test-rules';
	const HOME = URI.from({ scheme: SCHEME, path: '/home/user' });
	const ROOT = URI.from({ scheme: SCHEME, path: '/ws' });

	let fileService: FileService;

	setup(() => {
		fileService = ds.add(new FileService(new NullLogService()));
		ds.add(fileService.registerProvider(SCHEME, ds.add(new InMemoryFileSystemProvider())));
	});

	const write = (uri: URI, contents: string): Promise<unknown> => fileService.writeFile(uri, VSBuffer.fromString(contents));

	/**
	 * Build a ChiposRulesService over the in-memory tree with a single workspace
	 * folder (`ROOT`) and a fixed user-home. `config` gates `agentsMdInterop`.
	 */
	const makeService = (config: StubConfigurationService): ChiposRulesService => {
		const workspaceService = {
			getWorkspace: () => ({ folders: [{ uri: ROOT }] }),
		} as unknown as IWorkspaceContextService;
		const pathService = { userHome: async () => HOME } as unknown as IPathService;
		return new ChiposRulesService(fileService, workspaceService, pathService, config as unknown as IConfigurationService);
	};

	test('nested AGENTS.md + frontend/CLAUDE.md both synthesize as always rules; nearer dir wins on priority', async () => {
		await write(URI.joinPath(ROOT, 'AGENTS.md'), 'root agents');
		await write(URI.joinPath(ROOT, 'frontend', 'CLAUDE.md'), 'frontend claude');

		const service = makeService(new StubConfigurationService());
		const rules = await service.getRules(URI.joinPath(ROOT, 'frontend', 'src'));

		assert.deepStrictEqual(rules, [
			{
				name: 'AGENTS.md',
				source: 'workspace',
				sourceRef: '/ws/AGENTS.md',
				ruleType: 'always',
				body: 'root agents',
				priority: 0,
			},
			{
				name: 'CLAUDE.md (frontend)',
				source: 'workspace',
				sourceRef: '/ws/frontend/CLAUDE.md',
				ruleType: 'always',
				body: 'frontend claude',
				priority: 1,
			},
		] satisfies RuleDescriptor[]);
		// Proximity: the frontend rule outranks the root one.
		const root = rules.find(r => r.name === 'AGENTS.md')!;
		const frontend = rules.find(r => r.name === 'CLAUDE.md (frontend)')!;
		assert.ok(frontend.priority! > root.priority!, 'frontend rule must have higher priority than root');
	});

	test('@import inlines the referenced file body in place of the import line', async () => {
		await write(URI.joinPath(ROOT, 'AGENTS.md'), 'before\n@shared/base.md\nafter');
		await write(URI.joinPath(ROOT, 'shared', 'base.md'), 'BASE CONTENT');

		const service = makeService(new StubConfigurationService());
		const rules = await service.getRules(ROOT);

		assert.strictEqual(rules.length, 1);
		assert.strictEqual(rules[0].body, 'before\nBASE CONTENT\nafter');
	});

	test('@import cycle (a→b, b→a) completes without hanging or infinite duplication', async () => {
		// The marker file is the cycle entry point; it imports b.md which imports it back.
		await write(URI.joinPath(ROOT, 'AGENTS.md'), '@b.md');
		await write(URI.joinPath(ROOT, 'b.md'), '@AGENTS.md');

		const service = makeService(new StubConfigurationService());
		const rules = await service.getRules(ROOT);

		assert.strictEqual(rules.length, 1);
		// b.md's body is inlined once; its back-reference to AGENTS.md is left
		// verbatim by the cycle guard (seen-set), so no runaway expansion.
		assert.strictEqual(rules[0].body, '@AGENTS.md');
		assert.strictEqual((rules[0].body.match(/@AGENTS\.md/g) ?? []).length, 1);
	});

	test('chipos.rules.agentsMdInterop=false yields no synthesized AGENTS/CLAUDE rules', async () => {
		await write(URI.joinPath(ROOT, 'AGENTS.md'), 'root agents');
		await write(URI.joinPath(ROOT, 'frontend', 'CLAUDE.md'), 'frontend claude');

		const service = makeService(new StubConfigurationService({ 'chipos.rules.agentsMdInterop': false }));
		const rules = await service.getRules(URI.joinPath(ROOT, 'frontend', 'src'));

		assert.deepStrictEqual(rules, []);
	});

	test('getRules() with no anchorDir discovers no AGENTS/CLAUDE rules', async () => {
		await write(URI.joinPath(ROOT, 'AGENTS.md'), 'root agents');
		await write(URI.joinPath(ROOT, 'frontend', 'CLAUDE.md'), 'frontend claude');

		const service = makeService(new StubConfigurationService());
		const rules = await service.getRules();

		assert.deepStrictEqual(rules, []);
	});
});
