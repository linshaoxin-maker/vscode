/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isAllowedGitUrl, cloneGitRepo } from '../gitImport.js';
import type { IChiposGitService } from '../../../common/chiposGitService.js';
import type { IChiposGitExecArgs, IChiposGitExecResult } from '../../../../../../platform/chipos/common/chiposGit.js';

/** A fake git service that records the args it was called with and returns a canned result. */
function fakeGit(result: Partial<IChiposGitExecResult>): { service: IChiposGitService; calls: IChiposGitExecArgs[] } {
	const calls: IChiposGitExecArgs[] = [];
	const service: IChiposGitService = {
		_serviceBrand: undefined,
		async exec(args: IChiposGitExecArgs): Promise<IChiposGitExecResult> {
			calls.push(args);
			return { ok: false, stdout: '', stderr: '', code: null, killed: false, ...result };
		},
	};
	return { service, calls };
}

suite('gitImport', () => {
	suite('isAllowedGitUrl', () => {
		const allow = ['github.com'];

		test('an https URL on an allow-listed host is allowed', () => {
			assert.strictEqual(isAllowedGitUrl('https://github.com/owner/repo.git', allow), true);
		});

		test('a non-allow-listed host is rejected', () => {
			assert.strictEqual(isAllowedGitUrl('https://gitlab.com/owner/repo.git', allow), false);
		});

		test('lookalike hosts (substring / suffix / userinfo) are rejected', () => {
			assert.strictEqual(isAllowedGitUrl('https://evilgithub.com/x', allow), false);
			assert.strictEqual(isAllowedGitUrl('https://github.com.evil.com/x', allow), false);
			assert.strictEqual(isAllowedGitUrl('https://github.com@evil.com/x', allow), false);
		});

		test('non-https schemes are rejected', () => {
			assert.strictEqual(isAllowedGitUrl('http://github.com/x', allow), false);
			assert.strictEqual(isAllowedGitUrl('git@github.com:owner/repo.git', allow), false);
			assert.strictEqual(isAllowedGitUrl('file:///etc/passwd', allow), false);
			assert.strictEqual(isAllowedGitUrl('ssh://github.com/x', allow), false);
		});

		test('malformed / empty input is rejected', () => {
			assert.strictEqual(isAllowedGitUrl('not a url', allow), false);
			assert.strictEqual(isAllowedGitUrl('', allow), false);
		});

		test('multiple allowed domains, matched case-insensitively, port ignored', () => {
			const domains = ['github.com', 'gitlab.com'];
			assert.strictEqual(isAllowedGitUrl('https://GitLab.com/x', domains), true);
			assert.strictEqual(isAllowedGitUrl('https://github.com:443/x', domains), true);
			assert.strictEqual(isAllowedGitUrl('https://bitbucket.org/x', domains), false);
		});
	});

	suite('cloneGitRepo', () => {
		test('rejects "not available" when no git service is injected (e.g. web)', async () => {
			// The sandboxed renderer / web has no main-process git runner; the
			// caller passes undefined and the clone must fail explicitly rather
			// than silently no-op (the packaged-app bug this replaces).
			await assert.rejects(
				cloneGitRepo('https://github.com/owner/repo.git', '/tmp/dest', { timeoutMs: 8000 }),
				(err: Error) => /not available/i.test(err.message),
			);
		});

		test('builds a hardened shallow-clone argv and resolves on success', async () => {
			const { service, calls } = fakeGit({ ok: true });
			await cloneGitRepo('https://github.com/owner/repo.git', '/tmp/dest', { ref: 'main', timeoutMs: 1234 }, service);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(
				calls[0].args,
				['clone', '--depth', '1', '--single-branch', '--branch', 'main', '--', 'https://github.com/owner/repo.git', '/tmp/dest'],
			);
			assert.strictEqual(calls[0].timeoutMs, 1234);
		});

		test('maps ENOENT to a "git not installed" error', async () => {
			const { service } = fakeGit({ ok: false, code: 'ENOENT' });
			await assert.rejects(
				cloneGitRepo('https://github.com/owner/repo.git', '/tmp/dest', undefined, service),
				(err: Error) => /not installed|not on PATH/i.test(err.message),
			);
		});

		test('maps a killed/timeout result to a timeout error', async () => {
			const { service } = fakeGit({ ok: false, killed: true });
			await assert.rejects(
				cloneGitRepo('https://github.com/owner/repo.git', '/tmp/dest', undefined, service),
				(err: Error) => /timed out/i.test(err.message),
			);
		});

		test('surfaces git stderr on a generic non-zero exit', async () => {
			const { service } = fakeGit({ ok: false, code: 128, stderr: 'fatal: repository not found' });
			await assert.rejects(
				cloneGitRepo('https://github.com/owner/repo.git', '/tmp/dest', undefined, service),
				(err: Error) => /git clone failed/i.test(err.message) && /repository not found/i.test(err.message),
			);
		});
	});
});
