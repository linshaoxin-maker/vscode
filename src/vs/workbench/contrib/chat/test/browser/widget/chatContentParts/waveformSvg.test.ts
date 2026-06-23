/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildWaveformSvg } from '../../../../browser/widget/chatContentParts/edaParts/waveformSvg.js';

suite('buildWaveformSvg (pure WaveJSON → SVG)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no signals → empty-waveform placeholder svg', () => {
		const svg = buildWaveformSvg({ signals: [] });
		assert.ok(svg.startsWith('<svg'), 'returns an <svg>');
		assert.ok(svg.includes('（空波形）'), 'shows the empty placeholder');
	});

	test('renders one signal-name text per signal + a bus value label per bus segment', () => {
		const svg = buildWaveformSvg({
			title: 'counter.vcd',
			timescale: '1ns',
			signals: [
				{ name: 'tb.clk', wave: '0101.', data: [] },
				{ name: 'tb.count', wave: '=.=.=', data: ['0x0', '0x1', '0x2'] },
			],
		});
		assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'returns an <svg>');
		// MUST carry the SVG namespace: the IDE injects via DOMParser('image/svg+xml')
		// + importNode, which (unlike innerHTML) does NOT auto-namespace — without xmlns
		// the elements parse into the null namespace and render as raw text, not graphics.
		assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'root svg declares the SVG namespace');
		// one signal-name text per signal (right-anchored name labels).
		assert.strictEqual((svg.match(/text-anchor="end"/g) || []).length, 2, 'two signal-name labels');
		// '=.=.=' → three bus segments → three centered bus value labels.
		assert.strictEqual((svg.match(/text-anchor="middle"/g) || []).length, 3, 'three bus value labels');
		// bus data values are rendered.
		assert.ok(svg.includes('0x0') && svg.includes('0x1') && svg.includes('0x2'), 'bus data values present');
	});

	test('escapes &<> in signal names / bus values (XSS-safe)', () => {
		const svg = buildWaveformSvg({ signals: [{ name: 'a<b>&c', wave: '=', data: ['<x>'] }] });
		assert.ok(svg.includes('a&lt;b&gt;&amp;c'), 'name escaped');
		assert.ok(svg.includes('&lt;x&gt;'), 'bus value escaped');
		assert.ok(!svg.includes('<b>'), 'no raw angle brackets from input');
	});

	test('drops a signal whose wave is not a string (fail closed)', () => {
		const svg = buildWaveformSvg({ signals: [{ name: 'ok', wave: '01' }, { name: 'bad', wave: undefined as unknown as string }] });
		assert.strictEqual((svg.match(/text-anchor="end"/g) || []).length, 1, 'only the valid signal renders');
	});
});
