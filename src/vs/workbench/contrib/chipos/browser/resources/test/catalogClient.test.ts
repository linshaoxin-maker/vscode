/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IRequestService } from '../../../../../../platform/request/common/request.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ChiposPluginCatalogService, parseCatalogEntries } from '../catalogClient.js';

/** A Map-backed IStorageService stub (only get/store are used). */
class StubStorage {
	private readonly _m = new Map<string, string>();
	get(key: string): string | undefined { return this._m.get(key); }
	store(key: string, value: string): void { this._m.set(key, String(value)); }
}

const HOUR = 60 * 60 * 1000;
const CATALOG = JSON.stringify([{ id: 'a', name: 'Alpha', repo: 'https://github.com/o/a.git', author: 'me', verified: true }]);

suite('catalogClient', () => {

	suite('parseCatalogEntries', () => {
		test('parses a bare array; id defaults to name; verified is strict-true', () => {
			const entries = parseCatalogEntries('[{"name":"A","repo":"https://github.com/o/a.git"},{"name":"B","repo":"https://github.com/o/b.git","id":"bee","verified":true}]');
			assert.strictEqual(entries.length, 2);
			assert.strictEqual(entries[0].id, 'A');
			assert.strictEqual(entries[0].verified, false);
			assert.strictEqual(entries[1].id, 'bee');
			assert.strictEqual(entries[1].verified, true);
		});

		test('accepts a {plugins:[...]} wrapper', () => {
			const entries = parseCatalogEntries('{"plugins":[{"name":"A","repo":"https://github.com/o/a.git"}]}');
			assert.strictEqual(entries.length, 1);
		});

		test('skips entries missing name or repo, and non-object items', () => {
			const entries = parseCatalogEntries('[{"name":"A"},{"repo":"https://x/y.git"},42,null,{"name":"Ok","repo":"https://github.com/o/ok.git"}]');
			assert.deepStrictEqual(entries.map(e => e.name), ['Ok']);
		});

		test('invalid JSON or a non-array/non-wrapper → empty', () => {
			assert.deepStrictEqual(parseCatalogEntries('not json'), []);
			assert.deepStrictEqual(parseCatalogEntries('{"foo":1}'), []);
		});
	});

	suite('getCatalog (cache + stale fallback)', () => {
		function makeService(): { service: ChiposPluginCatalogService; storage: StubStorage } {
			const storage = new StubStorage();
			const service = new ChiposPluginCatalogService(
				{} as unknown as IRequestService,
				storage as unknown as IStorageService,
				{} as unknown as IProductService,
				{} as unknown as IConfigurationService,
			);
			return { service, storage };
		}

		test('fetches, returns entries, and caches the payload', async () => {
			const { service, storage } = makeService();
			const r = await service.getCatalog(CancellationToken.None, { now: 1000, fetch: async () => CATALOG });
			assert.strictEqual(r.entries.length, 1);
			assert.strictEqual(r.offline, false);
			assert.ok(storage.get('chipos.plugins.catalog.payload'), 'payload cached');
		});

		test('serves a fresh (<24h) cache without fetching again', async () => {
			const { service } = makeService();
			await service.getCatalog(CancellationToken.None, { now: 1000, fetch: async () => CATALOG });
			let fetched = false;
			const r = await service.getCatalog(CancellationToken.None, { now: 1000 + HOUR, fetch: async () => { fetched = true; return '[]'; } });
			assert.strictEqual(fetched, false);
			assert.strictEqual(r.entries.length, 1);
		});

		test('refetches when the cache is older than 24h', async () => {
			const { service } = makeService();
			await service.getCatalog(CancellationToken.None, { now: 0, fetch: async () => CATALOG });
			let fetched = false;
			const r = await service.getCatalog(CancellationToken.None, { now: 25 * HOUR, fetch: async () => { fetched = true; return '[]'; } });
			assert.strictEqual(fetched, true);
			assert.strictEqual(r.entries.length, 0);
		});

		test('falls back to a stale cache (offline=true) when the fetch fails', async () => {
			const { service } = makeService();
			await service.getCatalog(CancellationToken.None, { now: 0, fetch: async () => CATALOG });
			const r = await service.getCatalog(CancellationToken.None, { now: 100 * HOUR, fetch: async () => { throw new Error('net down'); } });
			assert.strictEqual(r.offline, true);
			assert.strictEqual(r.entries.length, 1);
		});

		test('throws when the fetch fails and there is no cache', async () => {
			const { service } = makeService();
			await assert.rejects(service.getCatalog(CancellationToken.None, { now: 0, fetch: async () => { throw new Error('net down'); } }));
		});
	});
});
