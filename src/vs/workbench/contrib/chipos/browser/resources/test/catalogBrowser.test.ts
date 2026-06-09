/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { filterCatalogEntries, catalogCategories, UNCATEGORIZED } from '../catalogClient.js';

/** FEAT-006b — catalog browser search + category filter (pure logic). */
suite('catalogBrowser', () => {

	const E = (id: string, name: string, category: string | undefined, description: string) =>
		({ id, name, repo: `https://github.com/x/${id}`, category, description });
	const cat = [
		E('a', 'Verilog Linter', 'Verification', 'Lint your RTL'),
		E('b', 'Synthesis Helper', 'Synthesis', 'Yosys flows'),
		E('c', 'Doc Writer', undefined, 'Generate docs'),
		E('d', 'Verible Format', 'Verification', 'Format Verilog'),
	];

	test('categories: distinct, sorted, Uncategorized last', () => {
		assert.deepStrictEqual(catalogCategories(cat), ['Synthesis', 'Verification', UNCATEGORIZED]);
	});

	test('search matches name/description; category narrows; combined ANDs', () => {
		assert.deepStrictEqual(
			{
				byName: filterCatalogEntries(cat, 'verilog').map(e => e.id),
				byDesc: filterCatalogEntries(cat, 'yosys').map(e => e.id),
				byCategory: filterCatalogEntries(cat, '', 'Verification').map(e => e.id),
				uncategorized: filterCatalogEntries(cat, '', UNCATEGORIZED).map(e => e.id),
				combined: filterCatalogEntries(cat, 'format', 'Verification').map(e => e.id),
				all: filterCatalogEntries(cat, '', undefined).length,
			},
			{
				byName: ['a', 'd'],   // "Verilog Linter" (name) + "Verible Format" (desc "Format Verilog")
				byDesc: ['b'],
				byCategory: ['a', 'd'],
				uncategorized: ['c'],
				combined: ['d'],
				all: 4,
			},
		);
	});
});
