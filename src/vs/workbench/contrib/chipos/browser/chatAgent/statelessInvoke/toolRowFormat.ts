/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * toolRowFormat — the shared "verb + `object` + result" tool-row vocabulary,
 * studied from Codex / Claude Code / Cursor and applied uniformly to BOTH the
 * top-level tool rows and the nested sub-agent card rows so every finished tool
 * reads the same way, e.g. `读取文件 \`rtl/foo.v\` · 9 行`.
 *
 * Pure + dependency-light (only the markdown type, imported as a type) so it
 * stays unit-testable and runtime-decoupled.
 */

import type { IMarkdownString } from '../../../../../../base/common/htmlContent.js';

/**
 * Collapse a long file path to its last two segments —
 * `rtl/card_demo_buggy.v` instead of `/private/tmp/ws/rtl/card_demo_buggy.v` —
 * matching how Cursor / Claude Code show the relevant tail, not the absolute path.
 */
export function shortenPathArg(p: string): string {
	const parts = p.split('/').filter(Boolean);
	return parts.length > 2 ? parts.slice(-2).join('/') : p.replace(/^\/+/, '');
}

/**
 * Build a tool-row label as markdown so the object (file path / command /
 * pattern) renders as a quiet monospace code chip. `friendly` stays plain; a
 * self-delimited detail (command `…`, quoted "…", /…/ regex) is left as-is, and
 * a bare path/identifier is shortened + wrapped in inline code.
 */
export function buildToolRowLabel(friendly: string, argDetail: string): IMarkdownString {
	if (!argDetail) {
		return { value: friendly, supportThemeIcons: false } as IMarkdownString;
	}
	const isCommand = /^`.*`$/.test(argDetail);
	const isQuoted = /^".*"$/.test(argDetail);
	const isRegex = /^\/.*\/$/.test(argDetail); // both ends — an absolute path is NOT this
	if (isCommand || isQuoted || isRegex) {
		return { value: `${friendly} ${argDetail}`, supportThemeIcons: false } as IMarkdownString;
	}
	const compact = shortenPathArg(argDetail).replace(/`/g, '');
	return { value: `${friendly} \`${compact}\``, supportThemeIcons: false } as IMarkdownString;
}

/**
 * Append a terse result badge to a finished row's label —
 * `读取文件 \`foo.v\`` → `读取文件 \`foo.v\` · ✓ 通过`. No-op when `result` is empty.
 */
export function withResultBadge(label: IMarkdownString, result: string | undefined): IMarkdownString {
	if (!result) {
		return label;
	}
	return { value: `${label.value} · ${result}`, supportThemeIcons: false } as IMarkdownString;
}

/**
 * Best-effort one-glance result derived from a tool's output PREVIEW (the
 * top-level path has the truncated string in-hand; sub-agent rows get the same
 * badge from the reasoner instead). Conservative — returns "" unless confident.
 */
export function summarizeToolOutput(toolName: string, output: string | undefined, isError?: boolean): string {
	if (isError) {
		return '✗ 失败';
	}
	if (!output) {
		return '';
	}
	const name = (toolName || '').toLowerCase();
	const text = output;
	// The preview often arrives as a JSON-serialized list of content blocks whose
	// inner JSON quotes are backslash-escaped (`\"success\": false`); strip the
	// backslashes so the field probes below match either form.
	const flat = text.replace(/\\/g, '');

	// lint / syntax-check → pass/fail + error count
	if (/lint|syntax_check|check_syntax/.test(name)) {
		const m = flat.match(/(?:violation_count|error[s]?)["\s:]*?(\d+)/i) || flat.match(/(\d+)\s*(?:error|错)/i);
		if (m) { return Number(m[1]) === 0 ? '✓ 通过' : `✗ ${m[1]} 错`; }
		if (/"success"\s*:\s*true|\bpass(ed)?\b|无错误|通过/i.test(flat)) { return '✓ 通过'; }
		if (/"success"\s*:\s*false|\bfail/i.test(flat)) { return '✗ 失败'; }
		return '';
	}
	// edit / write → replacement count
	if (/edit_file|write_file|str_replace|apply_diff|create_file/.test(name)) {
		const m = flat.match(/"replacements"\s*:\s*(\d+)/);
		if (m && Number(m[1]) > 0) { return `改 ${m[1]} 处`; }
		if (/"success"\s*:\s*true/.test(flat)) { return '✓'; }
		return '';
	}
	// read_file → line count (only when the preview is the raw file, not a summary)
	if (/read/.test(name) && /file/.test(name)) {
		if (text.includes('[read_file')) { return ''; }
		const lines = text.split('\n').length;
		return lines > 1 ? `${lines} 行` : '';
	}
	// grep / search → match count, glob → file count (the one-glance count the
	// reference tools always show: "Found 12 matches" / "· 12 results").
	if (/grep|search/.test(name)) {
		const m = flat.match(/"(?:match_count|count|total|num_matches)"\s*:\s*(\d+)/);
		if (m) { return `${m[1]} 匹配`; }
		const n = (text.match(/\n/g) || []).length;
		return n > 0 ? `${n} 匹配` : '';
	}
	if (/glob/.test(name)) {
		const m = flat.match(/"(?:count|total|num_files)"\s*:\s*(\d+)/);
		if (m) { return `${m[1]} 个文件`; }
		const n = (text.match(/\n/g) || []).length;
		return n > 0 ? `${n} 个文件` : '';
	}
	// list directory → item count
	if (/(^|_)ls$|list_dir|list_directory|listdir/.test(name)) {
		const items = (flat.match(/"(?:name|type)"\s*:/g) || []).length;
		if (items > 0) { return `${Math.max(1, Math.round(items / 2))} 项`; }
		const n = (text.match(/\n/g) || []).length;
		return n > 0 ? `${n} 项` : '';
	}
	// yosys / synthesis → success (+ chip area when present)
	if (/yosys|synth/.test(name)) {
		if (/"success"\s*:\s*true/.test(flat)) {
			const a = flat.match(/"area"\s*:\s*([\d.]+)/);
			return a ? `✓ ${Math.round(Number(a[1]))} µm²` : '✓ 综合成功';
		}
		if (/"success"\s*:\s*false/.test(flat)) { return '✗ 失败'; }
		return '';
	}
	// simulation → pass/fail
	if (/simulat|verilog_sim|run_sim/.test(name)) {
		if (/"sim_pass"\s*:\s*true|"success"\s*:\s*true|\bpass(ed)?\b|通过/i.test(flat)) { return '✓ 通过'; }
		if (/"sim_pass"\s*:\s*false|"success"\s*:\s*false|\bfail/i.test(flat)) { return '✗ 失败'; }
		return '';
	}
	// shell execution → exit code (✓ 退出 0 / ✗ 退出 N) — the reference tools
	// always surface non-zero exits prominently.
	if (/execute|run_in_terminal|run_command|shell/.test(name)) {
		const ec = flat.match(/"(?:exit_code|exitCode|returncode|return_code)"\s*:\s*(-?\d+)/);
		if (ec) { return Number(ec[1]) === 0 ? '✓ 退出 0' : `✗ 退出 ${ec[1]}`; }
		if (/"success"\s*:\s*true/.test(flat)) { return '✓ 退出 0'; }
		if (/"success"\s*:\s*false/.test(flat)) { return '✗ 失败'; }
		return '';
	}
	return '';
}
