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
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { _buildTracePillMarkdown, _responseHasTracePill } from '../../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';
import { Response, type IChatProgressResponseContent } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';

suite('_buildTracePillMarkdown', () => {

	test('renders an icon-only markdown command link with isTrusted', () => {
		const md = _buildTracePillMarkdown('reasoning-smoke-1778839365-a4cc331b');

		assert.strictEqual(md.isTrusted, true,
			'isTrusted must be true so the command URI is invoked on click');
		assert.strictEqual(md.supportThemeIcons, true,
			'supportThemeIcons preserved (the chat renderer key for $(icon) substitution)');
		// Pin the icon-only shape — visual round 4 swapped the "trace" text
		// for `$(link-external)` after dogfood feedback ("太丑了" — the bright
		// blue text link dominated the bubble).
		// Round 5: `— $(link-external) *[trace](command:... "Trace ID: ... — click to copy")*`
		assert.match(md.value,
			/^\n\n— \$\(link-external\) \*\[trace\]\(command:chipos\.trace\.copyId\?[^ ]+ "Trace ID: .+ — click to copy"\)\*$/,
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
		assert.match(md.value, /"Trace ID: reasoning-smoke-001 — click to copy"/,
			'tooltip must include the trace_id so hover reveals the full string');
	});

	test('escapes backslash + double-quote in tooltip text', () => {
		// Defensive: trace_id is alphanumeric + dash in practice, but if a
		// future reasoner version emits `"`, raw interpolation into the
		// markdown title `"Trace ID: ${tid} — ..."` would close the title
		// early and corrupt the link. Escape both chars.
		const evil = 'trace-with-"quote"-and-\\backslash';
		const md = _buildTracePillMarkdown(evil);
		// Title field should escape both, leaving the link parseable.
		// Round 5 markdown closes the link + italic after the title, so the
		// value ends with `")*` rather than the bare title-closing quote.
		assert.match(md.value,
			/"Trace ID: trace-with-\\"quote\\"-and-\\\\backslash — click to copy"\)\*$/,
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
		assert.ok(md.value.startsWith('\n\n'),
			`pill must start with paragraph break: ${JSON.stringify(md.value.slice(0, 12))}`,
		);
	});

	test('uses $(link-external) icon outside the link + italic trace text (visual round 5)', () => {
		// Visual rounds:
		//  round 1: inline `*trace:* \`xxx\`` — "有点丑"
		//  round 2: <span style/title> — sanitizer stripped attrs
		//  round 3: [trace](command:...) — bright blue text dominated bubble
		//  round 4: [$(link-external)](command:...) — icon ALONE rendered NOTHING
		//           (chat markdown renderer doesn't substitute $(name) inside link text)
		//  round 5 (current): `— $(link-external) *[trace](...)*` — em-dash demotes,
		//           codicon outside link (where substitution works), italic dims text
		const md = _buildTracePillMarkdown('reasoning-x');
		assert.ok(md.value.includes('$(link-external)'),
			'pill must include the link-external codicon (visible decoration)',
		);
		assert.ok(/\*\[trace\]/.test(md.value),
			'pill must wrap the [trace] link in italics (* on both sides) to dim the text',
		);
		assert.ok(md.value.includes('— $(link-external)'),
			'pill must lead with em-dash + space + codicon — the footnote-level demotion',
		);
	});

	test('empty trace_id still produces a valid (if useless) link — caller must guard', () => {
		// Documented contract: callers MUST check truthy before calling
		// this helper. We do not throw on empty input — that would mask
		// upstream bugs (silent crash > visible no-op render). Caller
		// guards exist at the two render sites (TaskComplete + Done).
		const md = _buildTracePillMarkdown('');
		assert.ok(md.value.includes('command:chipos.trace.copyId?'),
			'still produces a link; caller guard prevents this from rendering',
		);
	});
});

suite('_responseHasTracePill', () => {

	const md = (value: string): IChatProgressResponseContent =>
		({ kind: 'markdownContent', content: new MarkdownString(value) });
	const pill = (tid: string): IChatProgressResponseContent =>
		({ kind: 'markdownContent', content: _buildTracePillMarkdown(tid) });

	test('false on an empty response', () => {
		assert.strictEqual(_responseHasTracePill([]), false);
	});

	test('false on assistant text + tool parts but no pill', () => {
		const parts: IChatProgressResponseContent[] = [
			md('看起来你在测试输入'),
			{ kind: 'progressMessage', content: new MarkdownString('读取文件') } as IChatProgressResponseContent,
		];
		assert.strictEqual(_responseHasTracePill(parts), false);
	});

	test('true once a real pill is present', () => {
		// This is the dedup trigger: the queue/steer path drives a 2nd invoke
		// into the SAME response, which already ends with the 1st invoke's pill.
		const parts: IChatProgressResponseContent[] = [
			md('看起来你在测试输入'),
			pill('11111111-1111-1111-1111-111111111111'),
		];
		assert.strictEqual(_responseHasTracePill(parts), true,
			'a response carrying a prior trace pill must report present so the duplicate is skipped',
		);
	});

	test('matches the pill regardless of its trace_id (different invokes mint different ids)', () => {
		assert.strictEqual(_responseHasTracePill([pill('aaaa-bbbb')]), true);
		assert.strictEqual(_responseHasTracePill([pill('cccc-dddd')]), true);
	});

	test('does not false-positive on prose that merely mentions the command name', () => {
		// The detector keys off the full `command:chipos.trace.copyId` link
		// target the pill always emits, not the bare command id, so assistant
		// text discussing the feature does not suppress a real pill.
		assert.strictEqual(
			_responseHasTracePill([md('调试时可以点 trace 胶囊（chipos.trace.copyId）复制 ID')]),
			false,
		);
	});
});

suite('trace pill idempotency over the real ChatModel response path', () => {
	// Drives the genuine `Response` append/merge logic — the same path
	// `_emitTracePill` inspects via `entireResponse.value` — so the dedup is
	// verified against the framework's real behavior, not a hand-built array.
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// Mirrors how the agent appends the assistant answer: a markdownContent
	// with supportThemeIcons (NO isTrusted), so it does NOT merge with the
	// pill's isTrusted markdown — exactly the asymmetry that lets pills stack
	// while the answer text stays single.
	const emitText = (response: Response, text: string) =>
		response.updateContent({ kind: 'markdownContent', content: new MarkdownString(text, { supportThemeIcons: true }) });
	const emitPill = (response: Response, tid: string) =>
		response.updateContent({ kind: 'markdownContent', content: _buildTracePillMarkdown(tid) });
	const pillCount = (response: Response) =>
		response.value.filter(p => p.kind === 'markdownContent' && p.content.value.includes('command:chipos.trace.copyId')).length;

	test('a fresh response reports no pill, so the first invoke emits one', () => {
		const response = store.add(new Response([]));
		emitText(response, '看起来你在测试输入');
		assert.strictEqual(_responseHasTracePill(response.value), false,
			'before the first pill, the guard must allow emission');
		emitPill(response, 'aaaaaaaa-1111');
		assert.strictEqual(pillCount(response), 1);
	});

	test('reproduces the bug: a second invoke into the same response is suppressed (one pill, not two)', () => {
		// Steered/continued turn: invoke #1 streamed the answer + a pill; invoke
		// #2 shares this response row and mints a DIFFERENT trace_id. The old
		// code appended unconditionally → 2 pills on one bubble. The guard now
		// sees the existing pill and skips, so the answer keeps exactly one.
		const response = store.add(new Response([]));

		// invoke #1
		emitText(response, '看起来你在测试输入');
		if (!_responseHasTracePill(response.value)) {
			emitPill(response, 'aaaaaaaa-1111');
		}

		// invoke #2 (shares the row) — guarded emission
		if (!_responseHasTracePill(response.value)) {
			emitPill(response, 'bbbbbbbb-2222'); // would have been a 2nd pill pre-fix
		}

		assert.strictEqual(pillCount(response), 1,
			'the merged/steered response must end with exactly one trace pill');
	});

	test('six rapid steered invokes still leave exactly one pill (matches the reported 6-pill case)', () => {
		const response = store.add(new Response([]));
		emitText(response, '看起来你在测试输入');
		for (let i = 0; i < 6; i++) {
			if (!_responseHasTracePill(response.value)) {
				emitPill(response, `trace-${i}`);
			}
		}
		assert.strictEqual(pillCount(response), 1,
			'6 queued/steered invokes collapse to a single pill');
	});
});
