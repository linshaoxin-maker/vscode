/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * `toolRowFormat` unit tests — lock the shared "verb + `object` + · result"
 * tool-row vocabulary that BOTH the top-level rows and the sub-agent card rows
 * render through. The result-badge logic is a thicket of conservative regex
 * probes (lint / edit / read / grep / glob / ls / yosys / simulate / shell)
 * that has to cope with the preview arriving either as plain JSON
 * (`"success": true`) or as a backslash-escaped list-of-content-blocks
 * (`[{\"success\": true}]`); these tests pin one representative input per
 * branch so a regex tweak can't silently regress a badge.
 *
 * Snapshot-style: each suite drives a table of inputs through one
 * `deepStrictEqual` rather than many scattered asserts.
 */

import assert from 'assert';
import { buildToolRowLabel, shortenPathArg, summarizeToolOutput, withResultBadge } from '../toolRowFormat.js';

suite('toolRowFormat.shortenPathArg', () => {
	test('keeps the last two segments of a long path, strips a leading slash from short ones', () => {
		const cases = [
			'/private/tmp/ws/rtl/card_demo_buggy.v',
			'rtl/a.v',
			'foo.v',
			'/abs',
			'a/b/c',
		];
		assert.deepStrictEqual(cases.map(shortenPathArg), [
			'rtl/card_demo_buggy.v', // 5 segments → last two
			'rtl/a.v',               // exactly two → unchanged
			'foo.v',                 // single segment → unchanged
			'abs',                   // single absolute → leading slash stripped
			'b/c',                   // three segments → last two
		]);
	});
});

suite('toolRowFormat.buildToolRowLabel', () => {
	test('wraps a bare path in a code chip but leaves self-delimited command/quote/regex details inline', () => {
		const cases: Array<[string, string]> = [
			['读取文件', ''],                 // no detail → friendly only
			['执行命令', '`ls -la`'],          // command (backtick-wrapped) → inline as-is
			['文本搜索', '"needle"'],          // quoted → inline as-is
			['文本搜索', '/foo.*bar/'],        // regex (slash-delimited) → inline as-is
			['读取文件', '/private/tmp/ws/rtl/a.v'], // bare path → shortened + code chip
			['读取文件', 'rtl/a`b.v'],         // stray backtick in path → stripped before chipping
		];
		assert.deepStrictEqual(cases.map(([f, d]) => buildToolRowLabel(f, d).value), [
			'读取文件',
			'执行命令 `ls -la`',
			'文本搜索 "needle"',
			'文本搜索 /foo.*bar/',
			'读取文件 `rtl/a.v`',
			'读取文件 `rtl/ab.v`',
		]);
	});

	test('P2-1: a linkPath turns the path chip into a trusted vscode.open command link', () => {
		const linked = buildToolRowLabel('读取文件', 'rtl/a.v', '/ws/rtl/a.v');
		// label is a code-styled anchor pointing at vscode.open, kept as a chip…
		assert.ok(linked.value.startsWith('读取文件 [`rtl/a.v`](command:vscode.open?'), linked.value);
		// …and the markdown is trusted for vscode.open ONLY (no other command runs).
		assert.deepStrictEqual(linked.isTrusted, { enabledCommands: ['vscode.open'] });
		// A command/quoted/regex detail never becomes a link even if a path is passed.
		assert.strictEqual(buildToolRowLabel('执行命令', '`ls -la`', '/ws/ls').value, '执行命令 `ls -la`');
		// withResultBadge preserves the trust so the appended badge keeps the link live.
		assert.deepStrictEqual(withResultBadge(linked, '14 行').isTrusted, { enabledCommands: ['vscode.open'] });
	});
});

suite('toolRowFormat.withResultBadge', () => {
	test('appends "· result" only when a result is present', () => {
		const label = { value: '读取文件 `a.v`', supportThemeIcons: false };
		assert.deepStrictEqual(
			[withResultBadge(label, '12 行').value, withResultBadge(label, '').value, withResultBadge(label, undefined).value],
			['读取文件 `a.v` · 12 行', '读取文件 `a.v`', '读取文件 `a.v`'],
		);
	});
});

suite('toolRowFormat.summarizeToolOutput', () => {

	test('error / empty short-circuits', () => {
		assert.deepStrictEqual(
			[
				summarizeToolOutput('read_file', 'whatever', true), // isError wins
				summarizeToolOutput('read_file', undefined),        // no output
				summarizeToolOutput('read_file', ''),               // empty output
			],
			['✗ 失败', '', ''],
		);
	});

	test('one representative input per tool-family badge branch', () => {
		const cases: Array<[string, string]> = [
			// lint / syntax-check → pass / fail + error count, both plain and escaped forms
			['verilog_lint', '{"violation_count": 0}'],
			['verilog_lint', '{"violation_count": 3}'],
			['verilog_syntax_check', '[{\\"success\\": false, \\"errors\\": 2}]'], // escaped list form
			['verilog_syntax_check', '{"success": true}'],
			// edit / write → replacement count
			['edit_file', '{"replacements": 2}'],
			['write_file', '{"success": true}'],
			// read_file → line count (raw file preview), summary preview suppressed
			['read_file', 'module m;\nendmodule'],
			['read_file', '[read_file summary] 200 lines'],
			// grep / glob / ls → counts. NB: the glob tool is named `glob` (no
			// "search" substring) so it reaches the glob branch — a name like
			// `glob_file_search` would be intercepted by the grep branch first.
			['grep_search', '{"match_count": 12}'],
			['glob', '{"num_files": 4}'],
			['list_dir', '[{"name":"a","type":"file"},{"name":"b","type":"dir"}]'],
			// yosys / synthesis → success + optional area
			['yosys_synthesis', '{"success": true, "area": 123.4}'],
			['yosys_synthesis', '{"success": true}'],
			['yosys_synthesis', '{"success": false}'],
			// simulation → pass / fail
			['verilog_simulate', '{"sim_pass": true}'],
			['run_simulation', '{"success": false}'],
			// shell execution → exit code
			['execute_command', '{"exit_code": 0}'],
			['run_in_terminal', '{"exit_code": 1}'],
		];
		assert.deepStrictEqual(cases.map(([n, o]) => summarizeToolOutput(n, o)), [
			'✓ 通过',
			'✗ 3 错',
			'✗ 2 错',
			'✓ 通过',
			'改 2 处',
			'✓',
			'2 行',
			'',
			'12 匹配',
			'4 个文件',
			'2 项',
			'✓ 123 µm²',
			'✓ 综合成功',
			'✗ 失败',
			'✓ 通过',
			'✗ 失败',
			'✓ 退出 0',
			'✗ 退出 1',
		]);
	});
});
