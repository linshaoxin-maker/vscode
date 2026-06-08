/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match } from '../../../../../base/common/glob.js';
import { PromptResourceAttachment } from '../chatAgent/statelessInvoke/types.js';

/**
 * How a rule decides whether it applies to a turn (FEAT-001b/c). `agent` rules
 * are attached by the model on relevance; their lazy rendering is handled in a
 * later (backend) batch, so the pure collector treats them like `manual` for now.
 */
export type RuleType = 'always' | 'glob' | 'manual' | 'agent';

/**
 * A rule as indexed by the (future) RulesService. The collector is pure: it
 * receives these descriptors plus the per-turn context and produces wire-shape
 * attachments. The RulesService owns the disk I/O (frontmatter scan); this file
 * owns no I/O so it stays trivially unit-testable (P3-design §2.1).
 */
export interface RuleDescriptor {
	readonly name: string;
	readonly source: 'user' | 'workspace' | 'plugin';
	readonly sourceRef?: string;
	readonly ruleType: RuleType;
	/** Globs (e.g. `**\/*.sv`) for `ruleType === 'glob'`. */
	readonly globs?: readonly string[];
	readonly body: string;
	readonly description?: string;
	readonly priority?: number;
}

/**
 * Per-turn context used to decide which rules apply.
 */
export interface CollectInput {
	/** Workspace-relative path of the active editor (drives glob rules). */
	readonly activeFile?: string;
	/** Names of `manual` rules the user explicitly attached this turn. */
	readonly manualRuleIds?: readonly string[];
	readonly maxCount?: number;
	readonly maxBytes?: number;
}

export interface CollectResult {
	readonly attachments: PromptResourceAttachment[];
	readonly omitted: { readonly name: string; readonly reason: string }[];
}

const DEFAULT_MAX_COUNT = 200;
const DEFAULT_MAX_BYTES = 65536;
const SOURCE_RANK: Readonly<Record<RuleDescriptor['source'], number>> = { workspace: 0, user: 1, plugin: 2 };

function ruleApplies(rule: RuleDescriptor, input: CollectInput): boolean {
	switch (rule.ruleType) {
		case 'always':
			return true;
		case 'manual':
			return !!input.manualRuleIds?.includes(rule.name);
		case 'glob': {
			const file = input.activeFile;
			if (!file || !rule.globs?.length) {
				return false;
			}
			// FEAT-001c B2: a leading '!' marks an exclude glob; an excluded file is
			// dropped even if an include glob also matches (exclude wins). Base
			// `match()` has no '!' negation, so we split and apply it ourselves.
			const excludes = rule.globs.filter(g => g.startsWith('!')).map(g => g.slice(1));
			if (excludes.some(g => match(g, file))) {
				return false;
			}
			const includes = rule.globs.filter(g => !g.startsWith('!'));
			// All-exclude globs (no positive pattern) apply everywhere not excluded.
			return includes.length === 0 || includes.some(g => match(g, file));
		}
		case 'agent':
			// Agent rules are always collected as header-only attachments (FEAT-001b/c):
			// only their name + description ship in-band; the model pulls the body on
			// demand via the `read_rule_body` IDE tool when it judges the rule relevant.
			return true;
		default:
			return false;
	}
}

function ruleReason(rule: RuleDescriptor): string {
	switch (rule.ruleType) {
		case 'always':
			return 'always';
		case 'glob':
			return `glob:${(rule.globs ?? []).join(',')}`;
		case 'manual':
			return 'manual';
		case 'agent':
			return 'agent-requested';
		default:
			return '';
	}
}

function toAttachment(rule: RuleDescriptor): PromptResourceAttachment {
	// Agent rules ship header-only (FEAT-001b/c): the description travels in-band
	// but the body is empty until the model lazy-loads it via `read_rule_body`.
	// Every other rule type keeps its body inline exactly as before.
	const body = rule.ruleType === 'agent' ? '' : rule.body;
	return {
		kind: 'rule',
		name: rule.name,
		description: rule.description,
		source: rule.source,
		source_ref: rule.sourceRef,
		reason: ruleReason(rule),
		priority: rule.priority ?? 0,
		payload: { body }
	};
}

/**
 * Pure collector (FEAT-001a / P3-design §2.1): keep the rules that apply this
 * turn (`always`, glob-matching, or manually attached), map them to wire-shape
 * `PromptResourceAttachment[]`, and apply the count/byte caps (NFR-8/9). The
 * caller sets the result on `InvokeRequest.prompt_resource_attachments`.
 *
 * Deterministic order: source precedence (workspace < user < plugin), then
 * priority DESC, then name ASC.
 */
export function collectPromptResources(rules: readonly RuleDescriptor[], input: CollectInput): CollectResult {
	const maxCount = input.maxCount ?? DEFAULT_MAX_COUNT;
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

	const applicable = rules.filter(r => ruleApplies(r, input)).sort((a, b) =>
		SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
		|| (b.priority ?? 0) - (a.priority ?? 0)
		|| a.name.localeCompare(b.name));

	const encoder = new TextEncoder();
	const attachments: PromptResourceAttachment[] = [];
	const omitted: { name: string; reason: string }[] = [];
	let bytes = 0;
	for (const rule of applicable) {
		if (attachments.length >= maxCount) {
			omitted.push({ name: rule.name, reason: 'maxCount' });
			continue;
		}
		// Agent rules ship header-only (body lazy-loaded via read_rule_body), so cost
		// their description, not the full body — else a large agent rule could be
		// dropped by the byte cap despite shipping cheap.
		const cost = encoder.encode(rule.ruleType === 'agent' ? (rule.description ?? '') : rule.body).length;
		if (bytes + cost > maxBytes) {
			omitted.push({ name: rule.name, reason: 'maxBytes' });
			continue;
		}
		attachments.push(toAttachment(rule));
		bytes += cost;
	}
	return { attachments, omitted };
}
