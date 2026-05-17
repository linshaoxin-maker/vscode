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

	suite('found line (background path-poll detected new tool)', () => {
		// Worker emits this when its 60s path-poll daemon notices a previously-
		// missing tool has appeared. The IDE clears the matching missing-tool
		// dedup entry and surfaces a positive "EDA tool detected" toast.
		test('parses tool + path + version', () => {
			const r = parseEdaEnvLine('[EdaEnv] found vivado path=/home/user/Xilinx/Vivado/2024.2/bin/vivado version=Vivado v2024.2 (64-bit)');
			assert.strictEqual(r.kind, 'found');
			const f = r as Extract<typeof r, { kind: 'found' }>;
			assert.strictEqual(f.tool, 'vivado');
			// NOTE: version contains spaces, but parser greedily consumes a single
			// token after `=`. Workers MUST ensure version strings are pre-trimmed
			// to first-line + ≤120 chars (see `detect_tool` in environment.py).
			// We don't try to recover spaces here — pin the contract.
			assert.strictEqual(f.path, '/home/user/Xilinx/Vivado/2024.2/bin/vivado');
			assert.strictEqual(f.version, 'Vivado'); // first token only after version=
		});

		test('parses with single-word version', () => {
			const r = parseEdaEnvLine('[EdaEnv] found openroad path=/opt/orfs/bin/openroad version=v2.0-13456-g123abc');
			assert.strictEqual(r.kind, 'found');
			const f = r as Extract<typeof r, { kind: 'found' }>;
			assert.strictEqual(f.tool, 'openroad');
			assert.strictEqual(f.path, '/opt/orfs/bin/openroad');
			assert.strictEqual(f.version, 'v2.0-13456-g123abc');
		});

		test('missing version=none is preserved as literal "none"', () => {
			const r = parseEdaEnvLine('[EdaEnv] found sv2v path=/usr/local/bin/sv2v version=none');
			assert.strictEqual(r.kind, 'found');
			assert.strictEqual((r as Extract<typeof r, { kind: 'found' }>).version, 'none');
		});

		test('missing path and version → empty strings, not crash', () => {
			const r = parseEdaEnvLine('[EdaEnv] found yosys');
			assert.strictEqual(r.kind, 'found');
			const f = r as Extract<typeof r, { kind: 'found' }>;
			assert.strictEqual(f.tool, 'yosys');
			assert.strictEqual(f.path, '');
			assert.strictEqual(f.version, '');
		});
	});

	suite('poll_stopped line (background poll exited)', () => {
		test('reason=all_found, remaining=none', () => {
			const r = parseEdaEnvLine('[EdaEnv] poll_stopped reason=all_found remaining=none');
			assert.strictEqual(r.kind, 'poll_stopped');
			const p = r as Extract<typeof r, { kind: 'poll_stopped' }>;
			assert.strictEqual(p.reason, 'all_found');
			assert.deepStrictEqual(p.remaining, []);
		});

		test('reason=timeout, csv remaining', () => {
			const r = parseEdaEnvLine('[EdaEnv] poll_stopped reason=timeout remaining=openroad,vivado,yosys');
			assert.strictEqual(r.kind, 'poll_stopped');
			const p = r as Extract<typeof r, { kind: 'poll_stopped' }>;
			assert.strictEqual(p.reason, 'timeout');
			assert.deepStrictEqual(p.remaining, ['openroad', 'vivado', 'yosys']);
		});

		test('unknown reason value falls back to timeout', () => {
			// Defensive: if worker emits an unexpected reason we don't blow up,
			// we just classify as timeout (closer to truth than all_found).
			const r = parseEdaEnvLine('[EdaEnv] poll_stopped reason=cosmic_ray remaining=none');
			assert.strictEqual(r.kind, 'poll_stopped');
			assert.strictEqual((r as Extract<typeof r, { kind: 'poll_stopped' }>).reason, 'timeout');
		});

		test('missing reason entirely → still parses as poll_stopped with default', () => {
			const r = parseEdaEnvLine('[EdaEnv] poll_stopped');
			assert.strictEqual(r.kind, 'poll_stopped');
			const p = r as Extract<typeof r, { kind: 'poll_stopped' }>;
			assert.strictEqual(p.reason, 'timeout');  // default
			assert.deepStrictEqual(p.remaining, []);
		});
	});
});
