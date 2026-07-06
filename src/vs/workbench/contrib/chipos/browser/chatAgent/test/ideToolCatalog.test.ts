/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildIdeMcpTools, shapeMcpToolResult } from '../ideToolCatalog.js';

suite('ideToolCatalog', () => {

	suite('buildIdeMcpTools', () => {
		test('tags each MCP tool ide_mcp and passes its parsed schema through', () => {
			const out = buildIdeMcpTools([{ name: 'echo.ping', description: 'pings', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }]);
			assert.deepStrictEqual(out, [{
				name: 'echo.ping',
				description: 'pings',
				input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
				chipos_source: 'ide_mcp',
			}]);
		});

		test('defaults a missing description to "" and a missing schema to an empty object schema', () => {
			const out = buildIdeMcpTools([{ name: 'bare' }]);
			assert.deepStrictEqual(out, [{
				name: 'bare',
				description: '',
				input_schema: { type: 'object', properties: {} },
				chipos_source: 'ide_mcp',
			}]);
		});

		test('empty input → empty catalog', () => {
			assert.deepStrictEqual(buildIdeMcpTools([]), []);
		});

		// Parity with @chipos/mcp-client toIdeMcpToolDef (21-mcp-unification P5):
		// the shared mapping shallow-clones the schema + guards non-object schemas.
		test('shallow-clones the schema so a later mutation cannot corrupt the source', () => {
			const src = { type: 'object', properties: { x: {} } };
			const out = buildIdeMcpTools([{ name: 'c', description: 'x', inputSchema: src }]);
			(out[0].input_schema as Record<string, unknown>).properties = 'MUTATED';
			assert.deepStrictEqual(src.properties, { x: {} });
		});

		test('a non-object (array) schema falls back to an empty object schema', () => {
			const out = buildIdeMcpTools([{ name: 'arr', inputSchema: [1, 2, 3] }]);
			assert.deepStrictEqual(out[0].input_schema, { type: 'object', properties: {} });
		});
	});

	suite('shapeMcpToolResult', () => {
		test('joins text parts and ignores non-text content', () => {
			assert.deepStrictEqual(
				shapeMcpToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], isError: false }),
				{ content: 'a\nb', isError: false },
			);
		});

		test('falls back to raw JSON when there is no text content, preserving isError', () => {
			const result = { content: [{ type: 'image' }], isError: true };
			assert.deepStrictEqual(shapeMcpToolResult(result), { content: JSON.stringify(result), isError: true });
		});

		test('no content at all → raw JSON fallback, isError false', () => {
			assert.deepStrictEqual(shapeMcpToolResult({ isError: false }), { content: JSON.stringify({ isError: false }), isError: false });
		});
	});
});
