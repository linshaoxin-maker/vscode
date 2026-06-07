/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Quote-aware split of a raw slash-command argument string into tokens
 * (FEAT-001 command files). Double `"..."` and single `'...'` quoted spans
 * collapse to ONE token with the surrounding quotes removed; unquoted runs split
 * on whitespace and repeated whitespace is collapsed. Empty / whitespace-only
 * input yields `[]`. Pure — no I/O, trivially unit-testable.
 *
 * @example tokenizeArguments(`a "b c" 'd e'`) → ['a', 'b c', 'd e']
 */
export function tokenizeArguments(raw: string): string[] {
	const tokens: string[] = [];
	// One token at a time: a double-quoted span, a single-quoted span, or a run
	// of non-whitespace. Named groups expose the quoted body sans delimiters.
	const tokenRe = /"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<bare>\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(raw)) !== null) {
		const g = m.groups!;
		if (g.dq !== undefined) {
			tokens.push(g.dq);
		} else if (g.sq !== undefined) {
			tokens.push(g.sq);
		} else {
			tokens.push(g.bare);
		}
	}
	return tokens;
}

/**
 * Substitute argument placeholders in a command-file `body` with the user's raw
 * argument string (FEAT-001 command files). A single regex scan captures any
 * leading backslashes plus one placeholder; substitution semantics:
 *
 * - **Escaping**: count the leading backslashes `n`. ODD ⇒ the placeholder is
 *   escaped: emit `floor(n/2)` backslashes followed by the placeholder text
 *   UNCHANGED (no substitution). EVEN ⇒ emit `n/2` backslashes followed by the
 *   substituted value. (Each `\\` pair collapses to one literal backslash; the
 *   trailing odd backslash is what escapes the `$`.)
 * - `$ARGUMENTS` ⇒ the ENTIRE `rawArgs` string, verbatim.
 * - `$N` (1-based, e.g. `$1` = first) ⇒ `tokenizeArguments(rawArgs)[N-1] ?? ''`.
 * - `$ARGUMENTS[N]` (0-based) ⇒ `tokens[N] ?? ''`.
 * - `$name` ⇒ if `argumentNames` is provided and includes `name`,
 *   `tokens[argumentNames.indexOf(name)] ?? ''`; otherwise the literal `$name`
 *   is left UNCHANGED so unknown variables are never clobbered.
 * - **Append fallback**: if NO argument placeholder at all (`$ARGUMENTS`, `$N`,
 *   `$ARGUMENTS[N]`, `$name`, or an escaped one) appeared in `body` AND
 *   `rawArgs.trim() !== ''`, append exactly `'\n\nARGUMENTS: ' + rawArgs` once at
 *   the end — so a template that ignores args never silently drops the user's input.
 *
 * Pure — no I/O, trivially unit-testable.
 */
export function substituteCommandArgs(body: string, rawArgs: string, argumentNames?: string[]): string {
	let tokens: string[] | undefined;
	const tok = (): string[] => (tokens ??= tokenizeArguments(rawArgs));

	let sawAnyPlaceholder = false;
	const placeholderRe = /(?<bs>\\*)(?<tok>\$ARGUMENTS\[(?<idx>\d+)\]|\$ARGUMENTS|\$(?<name>[A-Za-z_]\w*)|\$(?<num>\d+))/g;

	const out = body.replace(placeholderRe, (_match, ...rest) => {
		// Named groups arrive as the last argument of the replacer callback.
		const groups = rest[rest.length - 1] as Record<string, string | undefined>;
		// Any placeholder occurrence — substituted, escaped, or an unresolved
		// $name — means the template references its arguments, so the append
		// fallback below is suppressed.
		sawAnyPlaceholder = true;
		const bs = groups.bs ?? '';
		const literal = groups.tok ?? '';
		const escaped = bs.length % 2 === 1;
		const collapsed = '\\'.repeat(Math.floor(bs.length / 2));

		// ODD leading backslashes ⇒ the placeholder is escaped: keep it literal.
		if (escaped) {
			return collapsed + literal;
		}

		// EVEN ⇒ substitute. Resolve the value for whichever placeholder matched.
		let value: string;
		if (groups.idx !== undefined) {
			// $ARGUMENTS[N] — 0-based index into the tokenized args.
			value = tok()[Number(groups.idx)] ?? '';
		} else if (groups.num !== undefined) {
			// $N — 1-based positional argument.
			value = tok()[Number(groups.num) - 1] ?? '';
		} else if (groups.name !== undefined) {
			// $name — only substitute declared names, else leave the literal.
			const at = argumentNames?.indexOf(groups.name) ?? -1;
			if (at < 0) {
				return collapsed + literal;
			}
			value = tok()[at] ?? '';
		} else {
			// Bare $ARGUMENTS — the entire raw argument string, verbatim.
			value = rawArgs;
		}
		return collapsed + value;
	});

	// Append fallback: surface the args only when the body referenced NO argument
	// placeholder at all (so the user's args are never silently dropped).
	if (!sawAnyPlaceholder && rawArgs.trim() !== '') {
		return out + '\n\nARGUMENTS: ' + rawArgs;
	}
	return out;
}
