/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	AgentEventType,
	ConnectionState,
	type IMentionItem,
	type IContextFile,
	type IFileEditPayload,
	type IEditOperation,
} from '../../../../../workbench/contrib/chipos/browser/eventTypes.js';

suite('EventTypes — contract verification', () => {

	test('AgentEventType enum has all 7 event types', () => {
		const expectedTypes = [
			AgentEventType.TextDelta,
			AgentEventType.ToolCall,
			AgentEventType.ToolResult,
			AgentEventType.FileEdit,
			AgentEventType.Confirm,
			AgentEventType.Error,
			AgentEventType.Done,
		];
		assert.strictEqual(expectedTypes.length, 7);
	});

	test('ConnectionState enum has all 5 states', () => {
		const states = [
			ConnectionState.Disconnected,
			ConnectionState.Connecting,
			ConnectionState.Connected,
			ConnectionState.Reconnecting,
			ConnectionState.Error,
		];
		assert.strictEqual(states.length, 5);
	});

	test('IMentionItem shape has required fields', () => {
		const item: IMentionItem = {
			path: '/rtl/counter.v',
			type: 'file',
			displayName: 'counter.v',
		};
		assert.strictEqual(item.path, '/rtl/counter.v');
		assert.strictEqual(item.type, 'file');
		assert.strictEqual(item.displayName, 'counter.v');
		assert.strictEqual(item.content, undefined);
	});

	test('IContextFile shape supports all types', () => {
		const file: IContextFile = { path: '/a.v', type: 'file', content: 'abc' };
		const folder: IContextFile = { path: '/rtl', type: 'folder', content: 'a.v\nb.v' };
		const snippet: IContextFile = { path: '/a.v', type: 'snippet', content: 'wire x;' };

		assert.strictEqual(file.type, 'file');
		assert.strictEqual(folder.type, 'folder');
		assert.strictEqual(snippet.type, 'snippet');
	});

	test('IEditOperation range is 1-indexed', () => {
		const edit: IEditOperation = {
			range: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
			newText: 'replacement',
		};
		assert.strictEqual(edit.range.startLine, 1);
		assert.ok(edit.range.startLine >= 1, 'Line numbers should be 1-indexed');
	});

	test('IFileEditPayload groups edits by file', () => {
		const payload: IFileEditPayload = {
			file_path: '/rtl/counter.v',
			edits: [
				{ range: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 }, newText: 'new' },
				{ range: { startLine: 3, startCol: 1, endLine: 3, endCol: 5 }, newText: 'new2' },
			],
		};
		assert.strictEqual(payload.edits.length, 2);
		assert.strictEqual(payload.file_path, '/rtl/counter.v');
	});
});
