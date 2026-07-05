/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	fetchMyOrgs, postSwitchOrg,
	fetchOrgMembers, patchOrgMemberRole, deleteOrgMember,
	createOrgInvite, deleteOrgInvite,
} from '../../browser/chatAgent/statelessInvoke/vendor/auth/orgSwitchClient.js';

/**
 * Active-org switching — orgSwitchClient pure HTTP (fetchMyOrgs / postSwitchOrg).
 *
 * Load-bearing contract: postSwitchOrg returns the org-scoped token ONLY on a
 * successful switch (so ChipOSAuthService swaps it in via updateAccessToken); on
 * 403 / no-token it returns undefined, so the caller keeps the current token and
 * the user stays on their current org. Tested as a pure module (no DI / DOM),
 * mirroring vscode-extension/test/suite/orgSwitch.test.ts.
 */
suite('orgSwitchClient — active-org switching HTTP', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let origFetch: typeof globalThis.fetch;
	setup(() => { origFetch = globalThis.fetch; });
	teardown(() => { globalThis.fetch = origFetch; });

	test('postSwitchOrg POSTs org_id + Bearer, returns the org-scoped token', async () => {
		const calls: { url: string; init: any }[] = [];
		globalThis.fetch = (async (url: any, init: any) => {
			calls.push({ url: String(url), init });
			return { ok: true, json: async () => ({ access_token: 'AT_MEMBER', active_org_id: 'org_team', role: 'member' }) };
		}) as any;

		const r = await postSwitchOrg('https://chiops.test', 'AT_PERSONAL', 'org_team');

		assert.ok(calls[0].url.endsWith('/api/auth/switch-org'), 'hits /switch-org');
		assert.strictEqual(calls[0].init.method, 'POST');
		assert.strictEqual(JSON.parse(calls[0].init.body).org_id, 'org_team');
		assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer AT_PERSONAL');
		assert.strictEqual(r?.access_token, 'AT_MEMBER');
		assert.strictEqual(r?.role, 'member');
		assert.strictEqual(r?.active_org_id, 'org_team');
	});

	test('postSwitchOrg returns undefined on 403 (non-member) — caller keeps current token', async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => 'not a member of this org' })) as any;
		assert.strictEqual(await postSwitchOrg('https://chiops.test', 'AT', 'org_not_mine'), undefined);
	});

	test('postSwitchOrg returns undefined when the response carries no access_token', async () => {
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ active_org_id: 'org_team', role: 'member' }) })) as any;
		assert.strictEqual(await postSwitchOrg('https://chiops.test', 'AT', 'org_team'), undefined);
	});

	test('postSwitchOrg defaults active_org_id to the requested org + role to ""', async () => {
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ access_token: 'AT_X' }) })) as any;
		const r = await postSwitchOrg('https://chiops.test', 'AT', 'org_req');
		assert.strictEqual(r?.active_org_id, 'org_req');
		assert.strictEqual(r?.role, '');
	});

	test('fetchMyOrgs returns the orgs list (with per-org roles)', async () => {
		globalThis.fetch = (async (url: any) => {
			assert.ok(String(url).endsWith('/api/auth/my-orgs'));
			return {
				ok: true, json: async () => ({
					orgs: [
						{ org_id: 'org_personal', name: 'My Workspace', role: 'owner' },
						{ org_id: 'org_team', name: 'Acme Team', role: 'member' },
					]
				})
			};
		}) as any;
		const orgs = await fetchMyOrgs('https://chiops.test', 'AT');
		assert.strictEqual(orgs.length, 2);
		assert.strictEqual(orgs[1].role, 'member');
		assert.strictEqual(orgs[1].name, 'Acme Team');
	});

	test('fetchMyOrgs returns [] on a failed request (never throws)', async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;
		assert.deepStrictEqual(await fetchMyOrgs('https://chiops.test', 'AT'), []);
	});

	test('fetchOrgMembers hits /api/orgs/{id}/members and returns the list', async () => {
		globalThis.fetch = (async (url: any) => {
			assert.ok(String(url).endsWith('/api/orgs/org_team/members'));
			return {
				ok: true, json: async () => ([
					{ user_id: 'u1', email: 'a@x.com', display_name: 'Alice', role: 'owner' },
					{ user_id: 'u2', email: 'b@x.com', display_name: null, role: 'member' },
				])
			};
		}) as any;
		const members = await fetchOrgMembers('https://chiops.test', 'AT', 'org_team');
		assert.strictEqual(members.length, 2);
		assert.strictEqual(members[1].role, 'member');
	});

	test('patchOrgMemberRole PATCHes {role} and returns true on ok', async () => {
		const calls: { url: string; init: any }[] = [];
		globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return { ok: true }; }) as any;
		const ok = await patchOrgMemberRole('https://chiops.test', 'AT', 'org_team', 'u2', 'admin');
		assert.strictEqual(ok, true);
		assert.ok(calls[0].url.endsWith('/api/orgs/org_team/members/u2'));
		assert.strictEqual(calls[0].init.method, 'PATCH');
		assert.strictEqual(JSON.parse(calls[0].init.body).role, 'admin');
	});

	test('deleteOrgMember returns false on 403 (not allowed) — caller keeps the member', async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 403 })) as any;
		assert.strictEqual(await deleteOrgMember('https://chiops.test', 'AT', 'org_team', 'u2'), false);
	});

	test('createOrgInvite POSTs role + expires_in_days, returns the one-time token', async () => {
		const calls: { url: string; init: any }[] = [];
		globalThis.fetch = (async (url: any, init: any) => {
			calls.push({ url: String(url), init });
			return { ok: true, json: async () => ({ invite_id: 'inv1', invite_token: 'inv_raw', accept_url: 'https://site/orgs/invite?token=inv_raw', role: 'member', expires_at: '2026-07-01' }) };
		}) as any;
		const created = await createOrgInvite('https://chiops.test', 'AT', 'org_team', 'member', 14);
		assert.ok(calls[0].url.endsWith('/api/orgs/org_team/invites'));
		assert.strictEqual(JSON.parse(calls[0].init.body).expires_in_days, 14);
		assert.strictEqual(created?.invite_token, 'inv_raw');
		assert.ok(created?.accept_url.includes('token=inv_raw'));
	});

	test('createOrgInvite returns undefined when the response carries no token', async () => {
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ invite_id: 'inv1' }) })) as any;
		assert.strictEqual(await createOrgInvite('https://chiops.test', 'AT', 'org_team', 'member', 7), undefined);
	});

	test('deleteOrgInvite returns true on ok', async () => {
		globalThis.fetch = (async () => ({ ok: true })) as any;
		assert.strictEqual(await deleteOrgInvite('https://chiops.test', 'AT', 'org_team', 'inv1'), true);
	});
});
