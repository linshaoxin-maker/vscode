/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit test for `_buildTracePillMarkdown` — the helper that formats the
 * dim "trace" pill at the end of every chat round (ADR-009 §4.1).
 *
 * Background: the pill silently disappeared three times during 2026-05-15
 * dogfood (see commit `16e901fd0d4` 3-layer wiring repair). Two of those
 * three regressions were rendering-side bugs (sanitizer stripped <span>,
 * MarkdownString supportHtml=false ate <sub>). A third was a wiring gap.
 * Catching the rendering-side ones early needs a unit test on the
 * markdown formulation — once it stops looking like
 * `[trace](command:chipos.trace.copyId?...)` we know the pill is broken
 * before anyone clicks a chat bubble.
 */

import assert from 'assert';
import { _buildTracePillMarkdown } from '../../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';

suite('_buildTracePillMarkdown', () => {

	test('renders a markdown command link with isTrusted', () => {
		const md = _buildTracePillMarkdown('reasoning-smoke-1778839365-a4cc331b');

		assert.strictEqual(md.isTrusted, true,
			'isTrusted must be true so the command URI is invoked on click');
		assert.strictEqual(md.supportThemeIcons, true,
			'supportThemeIcons preserved (the chat renderer key for $(icon) substitution)');
		// Pin the markdown shape — if this breaks, the chat sanitizer or
		// renderer probably changed contract.
		assert.match(md.value,
			/^\n\n\[trace\]\(command:chipos\.trace\.copyId\?[^ ]+ "Click to copy: .+"\)$/,
			`unexpected markdown shape: ${md.value}`,
		);
	});

	test('command argument is URL-encoded JSON of the trace_id', () => {
		const tid = 'reasoning-abc-123';
		const md = _buildTracePillMarkdown(tid);
		// Markdown link format: [text](url "title")
		// We need the substring between '?' and ' "' — the command arg.
		const m = md.value.match(/copyId\?([^ ]+) "/);
		assert.ok(m, `expected command arg in markdown: ${md.value}`);
		const decodedJson = decodeURIComponent(m[1]);
		assert.strictEqual(JSON.parse(decodedJson), tid,
			'command arg must decode back to the trace_id (JSON-stringified + URL-encoded)');
	});

	test('tooltip contains the full trace_id verbatim for vanilla ids', () => {
		const md = _buildTracePillMarkdown('reasoning-smoke-001');
		assert.match(md.value, /"Click to copy: reasoning-smoke-001"/,
			'tooltip must include the trace_id so hover reveals the full string');
	});

	test('escapes backslash + double-quote in tooltip text', () => {
		// Defensive: trace_id is alphanumeric + dash in practice, but if a
		// future reasoner version emits `"`, raw interpolation into the
		// markdown title `"Click to copy: ${tid}"` would close the title
		// early and corrupt the link. Escape both chars.
		const evil = 'trace-with-"quote"-and-\\backslash';
		const md = _buildTracePillMarkdown(evil);
		// Title field should escape both, leaving the link parseable.
		assert.match(md.value,
			/"Click to copy: trace-with-\\"quote\\"-and-\\\\backslash"$/,
			`escapes should land in the title: ${md.value}`,
		);
		// And: the command arg (URL-encoded JSON) must still round-trip
		// to the *unescaped* trace_id so clipboard gets the real string.
		const m = md.value.match(/copyId\?([^ ]+) "/);
		assert.ok(m);
		assert.strictEqual(JSON.parse(decodeURIComponent(m[1])), evil,
			'unescaped trace_id must reach the command arg verbatim');
	});

	test('leading double newline is preserved (markdown paragraph separator)', () => {
		// The chat agent appends this pill as its own markdownContent
		// progress item; the `\n\n` ensures it renders as a separate
		// paragraph below the assistant's text rather than inline.
		// If this is dropped, the pill would glue onto the last word
		// of the response.
		const md = _buildTracePillMarkdown('reasoning-x');
		assert.ok(md.value.startsWith('\n\n[trace]'),
			`pill must start with paragraph break: ${JSON.stringify(md.value.slice(0, 12))}`,
		);
	});

	test('empty trace_id still produces a valid (if useless) link — caller must guard', () => {
		// Documented contract: callers MUST check truthy before calling
		// this helper. We do not throw on empty input — that would mask
		// upstream bugs (silent crash > visible no-op render). Caller
		// guards exist at the two render sites (TaskComplete + Done).
		const md = _buildTracePillMarkdown('');
		assert.ok(md.value.includes('[trace](command:chipos.trace.copyId?'),
			'still produces a link; caller guard prevents this from rendering',
		);
	});
});
