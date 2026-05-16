/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `parseEdaEnvLine` — the pure parser for `[EdaEnv]` stderr
 * lines emitted by the worker at startup (ADR-009 / ROADMAP §11 P2-d).
 *
 * Format reference (from execution/eda_pack/environment.py docstring):
 *
 *   [EdaEnv] check yosys=ok iverilog=ok verilator=ok openroad=missing
 *   [EdaEnv] missing openroad install_hint=https://github.com/...
 *   [EdaEnv] all_ready
 *   [EdaEnv] core_ready
 *
 * Pinning the parser separately from the IPC + UI plumbing means: when the
 * worker side adds a new line type, this test surfaces the gap immediately
 * and we update both ends together.
 */

import assert from 'assert';
import { parseEdaEnvLine } from '../../../../../workbench/contrib/chipos/electron-sandbox/edaEnvHandler.js';

suite('parseEdaEnvLine', () => {

	suite('check overview line', () => {
		test('parses 5-tool all-ok line', () => {
			const r = parseEdaEnvLine('[EdaEnv] check yosys=ok iverilog=ok verilator=ok sv2v=ok openroad=ok');
			assert.strictEqual(r.kind, 'check');
			assert.deepStrictEqual(
				(r as Extract<typeof r, { kind: 'check' }>).statuses,
				{ yosys: 'ok', iverilog: 'ok', verilator: 'ok', sv2v: 'ok', openroad: 'ok' },
			);
		});

		test('parses mixed ok / missing', () => {
			const r = parseEdaEnvLine('[EdaEnv] check yosys=ok iverilog=missing openroad=missing');
			assert.strictEqual(r.kind, 'check');
			const s = (r as Extract<typeof r, { kind: 'check' }>).statuses;
			assert.strictEqual(s.yosys, 'ok');
			assert.strictEqual(s.iverilog, 'missing');
			assert.strictEqual(s.openroad, 'missing');
		});

		test('ignores tokens with unrecognized state value', () => {
			const r = parseEdaEnvLine('[EdaEnv] check yosys=ok iverilog=stale openroad=ok');
			assert.strictEqual(r.kind, 'check');
			const s = (r as Extract<typeof r, { kind: 'check' }>).statuses;
			// Only `ok`/`missing` recognized — `stale` is dropped from the dict.
			assert.strictEqual(s.yosys, 'ok');
			assert.strictEqual(s.openroad, 'ok');
			assert.ok(!('iverilog' in s), 'unknown state value `stale` should be dropped');
		});

		test('handles extra whitespace between tokens', () => {
			const r = parseEdaEnvLine('[EdaEnv]   check    yosys=ok    iverilog=missing');
			assert.strictEqual(r.kind, 'check');
			const s = (r as Extract<typeof r, { kind: 'check' }>).statuses;
			assert.strictEqual(s.yosys, 'ok');
			assert.strictEqual(s.iverilog, 'missing');
		});
	});

	suite('missing detail line', () => {
		test('parses tool + install_hint URL', () => {
			const r = parseEdaEnvLine('[EdaEnv] missing openroad install_hint=https://github.com/The-OpenROAD-Project/OpenROAD');
			assert.strictEqual(r.kind, 'missing');
			const m = r as Extract<typeof r, { kind: 'missing' }>;
			assert.strictEqual(m.tool, 'openroad');
			assert.strictEqual(m.install_hint, 'https://github.com/The-OpenROAD-Project/OpenROAD');
		});

		test('install_hint URL containing = is preserved (only first install_hint= split)', () => {
			// Some install URLs include query strings with `=`. We split only on
			// the first `install_hint=` so the rest of the URL stays intact.
			const r = parseEdaEnvLine('[EdaEnv] missing yosys install_hint=https://example.com/install?from=worker&utm=eda');
			assert.strictEqual(r.kind, 'missing');
			const m = r as Extract<typeof r, { kind: 'missing' }>;
			assert.strictEqual(m.tool, 'yosys');
			assert.strictEqual(m.install_hint, 'https://example.com/install?from=worker&utm=eda');
		});

		test('falls back to empty install_hint when not present', () => {
			const r = parseEdaEnvLine('[EdaEnv] missing quartus_sh');
			assert.strictEqual(r.kind, 'missing');
			const m = r as Extract<typeof r, { kind: 'missing' }>;
			assert.strictEqual(m.tool, 'quartus_sh');
			assert.strictEqual(m.install_hint, '');
		});
	});

	suite('ready markers', () => {
		test('all_ready', () => {
			const r = parseEdaEnvLine('[EdaEnv] all_ready');
			assert.strictEqual(r.kind, 'ready');
			assert.strictEqual((r as Extract<typeof r, { kind: 'ready' }>).level, 'all');
		});

		test('core_ready', () => {
			const r = parseEdaEnvLine('[EdaEnv] core_ready');
			assert.strictEqual(r.kind, 'ready');
			assert.strictEqual((r as Extract<typeof r, { kind: 'ready' }>).level, 'core');
		});
	});

	suite('robustness — not [EdaEnv] prefix or malformed', () => {
		test('accepts line without [EdaEnv] prefix (parser is forgiving)', () => {
			// The IPC main-process handler strips `[EdaEnv]` already in some
			// future refactors might pass body-only. Parser tolerates either.
			const r = parseEdaEnvLine('check yosys=ok');
			assert.strictEqual(r.kind, 'check');
		});

		test('empty line → unknown', () => {
			const r = parseEdaEnvLine('');
			assert.strictEqual(r.kind, 'unknown');
		});

		test('whitespace-only line → unknown', () => {
			const r = parseEdaEnvLine('[EdaEnv]   ');
			assert.strictEqual(r.kind, 'unknown');
		});

		test('unknown verb → unknown (with raw payload preserved)', () => {
			const r = parseEdaEnvLine('[EdaEnv] future_verb foo=bar');
			assert.strictEqual(r.kind, 'unknown');
			assert.strictEqual((r as Extract<typeof r, { kind: 'unknown' }>).raw, '[EdaEnv] future_verb foo=bar');
		});

		test('check without any tokens still parses to empty dict (no throw)', () => {
			const r = parseEdaEnvLine('[EdaEnv] check');
			assert.strictEqual(r.kind, 'check');
			assert.deepStrictEqual((r as Extract<typeof r, { kind: 'check' }>).statuses, {});
		});
	});
});
