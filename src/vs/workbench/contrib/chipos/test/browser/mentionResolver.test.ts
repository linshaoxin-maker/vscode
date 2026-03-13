/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MentionResolver } from '../../../../../workbench/contrib/chipos/browser/chatPanel/mentionResolver.js';
import type { IMentionItem } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import type { IFileService, IFileContent, IFileStat } from '../../../../../platform/files/common/files.js';

class MockFileService {
	private _files = new Map<string, string>();
	private _folders = new Map<string, string[]>();

	addFile(path: string, content: string): void {
		this._files.set(path, content);
	}

	addFolder(path: string, children: string[]): void {
		this._folders.set(path, children);
	}

	async readFile(uri: { fsPath: string }): Promise<Partial<IFileContent>> {
		const content = this._files.get(uri.fsPath);
		if (content === undefined) {
			throw new Error(`File not found: ${uri.fsPath}`);
		}
		return {
			value: { toString: () => content } as any,
		};
	}

	async resolve(uri: { fsPath: string }): Promise<Partial<IFileStat>> {
		const children = this._folders.get(uri.fsPath);
		if (children === undefined) {
			throw new Error(`Folder not found: ${uri.fsPath}`);
		}
		return {
			children: children.map(name => ({ name } as any)),
		};
	}
}

suite('MentionResolver', () => {

	let mockFs: MockFileService;
	let resolver: MentionResolver;

	setup(() => {
		mockFs = new MockFileService();
		resolver = new MentionResolver(mockFs as unknown as IFileService);
	});

	test('resolves file mention with content', async () => {
		mockFs.addFile('/project/rtl/counter.v', 'module counter; endmodule');
		const items: IMentionItem[] = [
			{ path: '/project/rtl/counter.v', type: 'file', displayName: 'counter.v' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].path, '/project/rtl/counter.v');
		assert.strictEqual(results[0].type, 'file');
		assert.strictEqual(results[0].content, 'module counter; endmodule');
	});

	test('truncates large file content', async () => {
		const largeContent = 'x'.repeat(150 * 1024);
		mockFs.addFile('/project/big.v', largeContent);
		const items: IMentionItem[] = [
			{ path: '/project/big.v', type: 'file', displayName: 'big.v' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results.length, 1);
		assert.ok(results[0].content!.length < largeContent.length);
		assert.ok(results[0].content!.includes('[truncated]'));
	});

	test('returns null content when file not found', async () => {
		const items: IMentionItem[] = [
			{ path: '/no/such/file.v', type: 'file', displayName: 'file.v' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].content, null);
	});

	test('resolves folder mention with child names', async () => {
		mockFs.addFolder('/project/rtl', ['counter.v', 'axi_master.v', 'tb/']);
		const items: IMentionItem[] = [
			{ path: '/project/rtl', type: 'folder', displayName: 'rtl/' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].type, 'folder');
		assert.ok(results[0].content!.includes('counter.v'));
		assert.ok(results[0].content!.includes('axi_master.v'));
	});

	test('returns null content when folder not found', async () => {
		const items: IMentionItem[] = [
			{ path: '/no/such/dir', type: 'folder', displayName: 'dir/' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results[0].content, null);
	});

	test('resolves snippet mention using item content directly', async () => {
		const items: IMentionItem[] = [
			{
				path: '/project/rtl/counter.v',
				type: 'snippet',
				displayName: 'Selection in counter.v',
				content: 'always @(posedge clk)',
				startLine: 5,
				endLine: 5,
			},
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].type, 'snippet');
		assert.strictEqual(results[0].content, 'always @(posedge clk)');
	});

	test('snippet with no content resolves to null', async () => {
		const items: IMentionItem[] = [
			{ path: '/project/file.v', type: 'snippet', displayName: 'Selection' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results[0].content, null);
	});

	test('resolves mixed mention types', async () => {
		mockFs.addFile('/project/a.v', 'content_a');
		mockFs.addFolder('/project/dir', ['b.v']);

		const items: IMentionItem[] = [
			{ path: '/project/a.v', type: 'file', displayName: 'a.v' },
			{ path: '/project/dir', type: 'folder', displayName: 'dir/' },
			{ path: '/project/c.v', type: 'snippet', displayName: 'Selection', content: 'wire clk;' },
		];

		const results = await resolver.resolve(items);
		assert.strictEqual(results.length, 3);
		assert.strictEqual(results[0].type, 'file');
		assert.strictEqual(results[1].type, 'folder');
		assert.strictEqual(results[2].type, 'snippet');
	});

	test('resolves empty array', async () => {
		const results = await resolver.resolve([]);
		assert.strictEqual(results.length, 0);
	});
});
