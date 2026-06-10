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
	/** FEAT-011c: a skill's bundled executable command (SKILL.md `script:` frontmatter). Only meaningful for skills. */
	readonly script?: string;
	/** FEAT-003/P2.7: a skill's declared slash command name (SKILL.md `command:` or `slash:` frontmatter), without the leading `/`. Only meaningful for skills. */
	readonly command?: string;
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
	} else if (fields.get('description')) {
		// Has a description but no explicit trigger and not manual → an agent rule
		// the model attaches by relevance. Lazy rendering of agent rules is handled
		// in a later (backend) batch.
		ruleType = 'agent';
	} else {
		// Truly empty frontmatter (no trigger declared) → default to manual so it
		// never auto-injects without an explicit attach.
		ruleType = 'manual';
	}

	return { description: fields.get('description'), globs, alwaysApply, ruleType, body, script: fields.get('script'), command: normalizeCommandName(fields.get('command') ?? fields.get('slash')) };
}

/**
 * FEAT-003 — normalize a skill's declared command name: strip a leading `/`,
 * trim, and keep it only if it is a single `[\w-]+` token (matching the slash
 * parser in chipOSChatAgent). Returns `undefined` for empty/invalid values so a
 * malformed `command:` never produces a phantom command.
 */
function normalizeCommandName(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	const name = raw.trim().replace(/^\/+/, '');
	return /^[\w-]+$/.test(name) ? name : undefined;
}

/**
 * A slash-command file (`.md` / `.txt`) split into its frontmatter-derived
 * metadata and its body (FEAT-001). Cursor/Claude-Code-compatible keys:
 * `description`, `argument-hint`, `argument-names`, `allowed-tools`. All fields
 * are optional and parsing NEVER throws on unknown/missing keys.
 */
export interface ParsedCommandFile {
	readonly description?: string;
	readonly argumentHint?: string;
	readonly argumentNames?: string[];
	readonly allowedTools?: string[];
	readonly body: string;
}

/**
 * Parse a command file's content into {@link ParsedCommandFile}. Pure — no I/O,
 * trivially unit-testable. Tolerant of missing frontmatter: with no `---` block
 * the whole content is the body and every metadata field is `undefined`.
 * `argument-names` / `allowed-tools` accept a comma- and/or whitespace-separated
 * list or a bracketed YAML list. Keys are matched case-insensitively, and both
 * the kebab-case (`argument-hint`) and camelCase (`argumentNames`) spellings are
 * accepted.
 */
export function parseCommandFile(content: string): ParsedCommandFile {
	const m = FRONTMATTER_RE.exec(content);
	if (!m) {
		// No frontmatter → the whole file is the command body.
		return { body: content.trim() };
	}

	const fields = parseFrontmatterFields(m[1]);
	const body = content.slice(m[0].length).trim();
	return {
		description: fields.get('description'),
		argumentHint: fields.get('argument-hint') ?? fields.get('argumenthint'),
		argumentNames: parseList(fields.get('argument-names') ?? fields.get('argumentnames')),
		allowedTools: parseList(fields.get('allowed-tools') ?? fields.get('allowedtools')),
		body,
	};
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

function parseList(raw: string | undefined): string[] | undefined {
	if (!raw) {
		return undefined;
	}
	// Accepts `Read Grep`, `Read, Grep`, `[Read, Grep]`, or `"Read"` — split on
	// commas and/or whitespace, strip brackets and quotes.
	const cleaned = raw.replace(/^\[/, '').replace(/\]$/, '');
	const parts = cleaned
		.split(/[\s,]+/)
		.map(s => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);
	return parts.length ? parts : undefined;
}
