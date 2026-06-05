/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isAllowedGitUrl } from '../gitImport.js';

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
});
