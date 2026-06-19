/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChipOSTokenManager } from '../../browser/auth/chiposTokenManager.js';

/**
 * Cross-window auth sync — ChipOSTokenManager picks up token changes another
 * window writes to the shared (APPLICATION-scoped) SecretStorage.
 *
 * Load-bearing safety contract:
 *   - adopts a token a different window stored (login / refresh propagation);
 *   - clears its token when another window logs out;
 *   - does NOT re-fire onDidChangeToken when the stored value is unchanged (so the
 *     WRITER window — which sets its in-memory token before writing storage — never
 *     reacts to its own write, no loop);
 *   - never throws if SecretStorage errors (auth must not crash).
 */

const KEY_ACCESS = 'chipos.auth.accessToken';
const KEY_REFRESH = 'chipos.auth.refreshToken';
const KEY_USER = 'chipos.auth.userInfo';

/** Minimal ISecretStorageService stand-in over a Map, with a fire-able change event. */
class TestSecretStorage implements IDisposable {
	readonly type = 'persisted';
	private readonly _store = new Map<string, string>();
	private readonly _emitter = new Emitter<string>();
	readonly onDidChangeSecret = this._emitter.event;

	async get(key: string): Promise<string | undefined> { return this._store.get(key); }
	async set(key: string, value: string): Promise<void> { this._store.set(key, value); this._emitter.fire(key); }
	async delete(key: string): Promise<void> { this._store.delete(key); this._emitter.fire(key); }

	/** Simulate ANOTHER window writing the shared store (set value + fire change). */
	externalWrite(key: string, value: string | undefined): void {
		if (value === undefined) { this._store.delete(key); } else { this._store.set(key, value); }
		this._emitter.fire(key);
	}
	dispose(): void { this._emitter.dispose(); }
}

const noConfig = { getValue: () => undefined } as any;
const noProduct = {} as any;

/** Let the fire-and-forget async sync handler settle. */
function tick(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 5)); }

suite('ChipOSTokenManager — cross-window auth sync', () => {

	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	const log = new NullLogService();
	let secret: TestSecretStorage;
	let manager: ChipOSTokenManager;

	setup(() => {
		secret = ds.add(new TestSecretStorage());
		manager = ds.add(new ChipOSTokenManager(secret as any, noConfig, log, noProduct));
	});

	test('adopts a token written by another window (login propagation)', async () => {
		const fired: (string | undefined)[] = [];
		ds.add(manager.onDidChangeToken(t => fired.push(t)));
		assert.strictEqual(manager.isLoggedIn(), false);

		// another window logs in → writes the shared store (refresh + user land first,
		// then the access-token write fires the change we react to)
		secret.externalWrite(KEY_REFRESH, 'RT1');
		secret.externalWrite(KEY_USER, JSON.stringify({ user_id: 'u1', email: 'a@b.c' }));
		secret.externalWrite(KEY_ACCESS, 'AT1');
		await tick();

		assert.strictEqual(manager.isLoggedIn(), true);
		assert.strictEqual(await manager.getAccessToken(), 'AT1');
		assert.strictEqual(manager.getUser()?.email, 'a@b.c');
		assert.deepStrictEqual(fired, ['AT1']);
	});

	test('no-op when the stored token is unchanged (writer hears its own write)', async () => {
		await manager.storeTokens('AT1', 'RT1', { user_id: 'u1', email: 'a@b.c' } as any);
		const fired: (string | undefined)[] = [];
		ds.add(manager.onDidChangeToken(t => fired.push(t)));

		// same value re-announced — must NOT re-fire (no loop, no spurious flip)
		secret.externalWrite(KEY_ACCESS, 'AT1');
		await tick();

		assert.deepStrictEqual(fired, []);
		assert.strictEqual(manager.isLoggedIn(), true);
	});

	test('clears the token when another window logs out', async () => {
		await manager.storeTokens('AT1', 'RT1', { user_id: 'u1', email: 'a@b.c' } as any);
		const fired: (string | undefined)[] = [];
		ds.add(manager.onDidChangeToken(t => fired.push(t)));

		secret.externalWrite(KEY_ACCESS, undefined); // logout elsewhere
		await tick();

		assert.strictEqual(manager.isLoggedIn(), false);
		assert.deepStrictEqual(fired, [undefined]);
	});

	test('never throws if SecretStorage errors — state left unchanged', async () => {
		await manager.storeTokens('AT1', 'RT1', { user_id: 'u1', email: 'a@b.c' } as any);
		(secret as any).get = async () => { throw new Error('boom'); };
		const fired: (string | undefined)[] = [];
		ds.add(manager.onDidChangeToken(t => fired.push(t)));

		secret.externalWrite(KEY_ACCESS, 'AT2'); // sync runs → get throws → must be caught
		await tick();

		assert.strictEqual(manager.isLoggedIn(), true, 'state preserved on error');
		assert.deepStrictEqual(fired, [], 'no token change emitted on error');
	});
});
