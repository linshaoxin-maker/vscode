/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RuleType } from './promptResourceAttachmentCollector.js';

/**
 * A rule file (`.mdc` / `.md`) split into its frontmatter-derived metadata and
 * its body. Cursor-compatible frontmatter keys: `description`, `globs`,
 * `alwaysApply`. `ruleType` is derived: alwaysApply → `always`, else globs →
 * `glob`, else `manual` (a file with no frontmatter is treated as `always`).
 */
export interface ParsedRuleFile {
	readonly description?: string;
	readonly globs?: string[];
	readonly alwaysApply: boolean;
	readonly ruleType: RuleType;
	readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a `.mdc`/`.md` rule file's content into {@link ParsedRuleFile}. Pure —
 * no I/O, so it is trivially unit-testable. Tolerant of missing frontmatter.
 */
export function parseRuleFile(content: string): ParsedRuleFile {
	const m = FRONTMATTER_RE.exec(content);
	if (!m) {
		// No frontmatter → the whole file is the rule body, applied always.
		return { alwaysApply: true, ruleType: 'always', body: content.trim() };
	}

	const fields = parseFrontmatterFields(m[1]);
	const body = content.slice(m[0].length).trim();
	const alwaysApply = fields.get('alwaysapply') === 'true';
	const globs = parseGlobs(fields.get('globs'));
	const manual = fields.get('manuallyattached') === 'true' || fields.get('ruletype') === 'manual';

	let ruleType: RuleType;
	if (alwaysApply) {
		ruleType = 'always';
	} else if (globs && globs.length) {
		ruleType = 'glob';
	} else if (manual) {
		ruleType = 'manual';
	} else {
		// Frontmatter present but no trigger declared → default to manual so it
		// never auto-injects without an explicit attach.
		ruleType = 'manual';
	}

	return { description: fields.get('description'), globs, alwaysApply, ruleType, body };
}

function parseFrontmatterFields(frontmatter: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of frontmatter.split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx <= 0) {
			continue;
		}
		// Keys are matched case-insensitively (alwaysApply vs alwaysapply).
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (key) {
			out.set(key, value);
		}
	}
	return out;
}

function parseGlobs(raw: string | undefined): string[] | undefined {
	if (!raw) {
		return undefined;
	}
	// Accepts `a,b`, `[a, b]`, `"a"`, or a single glob.
	const cleaned = raw.replace(/^\[/, '').replace(/\]$/, '');
	const parts = cleaned
		.split(',')
		.map(s => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);
	return parts.length ? parts : undefined;
}
