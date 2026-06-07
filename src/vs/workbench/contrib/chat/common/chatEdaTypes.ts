/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  EDA-specific content part types for the Chat framework.
 *  Extracted from chatService.ts to reduce framework core file modifications.
 *  All types are re-exported from chatService.ts for backward compatibility.
 *--------------------------------------------------------------------------------------------*/

// ── EDA Simulation Report ───────────────────────────────────────────────────

export interface IChatEdaSimTestResult {
	name: string;
	status: 'pass' | 'fail' | 'error' | 'skip';
	message?: string;
	duration_ms?: number;
}

export interface IChatEdaSimReport {
	kind: 'edaSimReport';
	tests: IChatEdaSimTestResult[];
	summary: { total: number; passed: number; failed: number; errors?: number };
}

// ── EDA Coverage Report ─────────────────────────────────────────────────────

export interface IChatEdaCoverageReport {
	kind: 'edaCoverageReport';
	/**
	 * P1-3: coverage values are accepted as EITHER a 0-1 fraction (legacy WS
	 * payloads) OR a 0-100 percentage (backend_v2 coverage_boost emits *100). The
	 * part normalizes for display, so emitters may pass whichever they have.
	 *
	 * line_cov / branch_cov are optional: the coverage text-fallback path only
	 * knows overall_cov, so the card shows "N/A" for the metrics it lacks rather
	 * than a misleading 0% (parity with vscode-extension reportCards.js, which
	 * prints N/A for null metrics).
	 */
	line_cov?: number;
	branch_cov?: number;
	/** P1-3: toggle (flip) coverage — RTL-specific (coverage_boost toggle_cov). */
	toggle_cov?: number;
	/** P1-3: aggregate structural coverage across all metrics (overall_cov). */
	overall_cov?: number;
	/** P1-3: the target coverage the run is driving toward (e.g. 90), for context. */
	target?: number;
	gaps?: Array<{ file: string; lines: string; type?: string }>;
}

// ── EDA Lint Report ─────────────────────────────────────────────────────────

export interface IChatEdaLintError {
	file: string;
	line: number;
	col?: number;
	severity: 'error' | 'warning' | 'info';
	message: string;
	rule?: string;
	auto_fixable?: boolean;
}

export interface IChatEdaLintReport {
	kind: 'edaLintReport';
	errors: IChatEdaLintError[];
	auto_fixable?: number;
	tool?: string;
}

// ── EDA Parallel Progress ───────────────────────────────────────────────────

export interface IChatEdaParallelTrack {
	name: string;
	status: 'pending' | 'running' | 'done' | 'failed';
	progress?: number;
	file?: string;
}

export interface IChatEdaParallelProgress {
	kind: 'edaParallelProgress';
	phase: string;
	tracks: IChatEdaParallelTrack[];
	conflicts?: string[];
}

// ── EDA Negotiation View ────────────────────────────────────────────────────

export interface IChatEdaNegotiationPerspective {
	agent: string;
	position: string;
	reasoning: string;
}

export interface IChatEdaNegotiationView {
	kind: 'edaNegotiationView';
	issue: string;
	perspectives: IChatEdaNegotiationPerspective[];
	recommendation: string;
}

// ── EDA Spec Review ─────────────────────────────────────────────────────────

/**
 * P1-1: an action button on the Spec Review card. The IDE renders the default
 * View Plan / Regenerate / Build trio when `actions` is absent (parity with
 * vscode-extension specCard.js:86-88); the field exists so the reasoner can
 * later override / restrict the set per card.
 */
export interface IChatEdaSpecReviewAction {
	id: 'view' | 'regenerate' | 'build';
	label: string;
}

export interface IChatEdaSpecReview {
	kind: 'edaSpecReview';
	spec_path: string;
	spec_name: string;
	summary: string;
	files?: string[];
	/**
	 * P1-1: optional action set. `view` opens the spec file; `regenerate` asks the
	 * agent to redo the design; `build` drives the next agent round on the approved
	 * spec (the spec→build closed loop). Absent → IDE defaults to all three.
	 */
	actions?: ReadonlyArray<IChatEdaSpecReviewAction>;
}

// ── Agent Round Progress ────────────────────────────────────────────────────

export interface IChatRoundProgress {
	kind: 'roundProgress';
	current_round: number;
	max_rounds: number;
	phase?: string;
	status?: 'running' | 'done' | 'failed';
	tool?: string;
}

// ── Agent Error Card ────────────────────────────────────────────────────────

export interface IChatAgentError {
	kind: 'agentError';
	error_code: string;
	message: string;
	retryable: boolean;
	suggestion?: string;
	/**
	 * [ChipOS] ADR-018 resume-from-break. When present, the error card offers a
	 * PRIMARY "继续 (从中断处)" action that CONTINUES the in-flight stateless turn
	 * from the last checkpoint (POST /resume) — preserving already-rendered
	 * assistant text + completed tool calls — instead of re-running the whole
	 * prompt. The `retryable` "Retry" (resend) button stays as the fallback.
	 */
	resumeContext?: {
		chatSessionId: string;
		traceId: string;
		lastSequenceId: number;
	};
}

// ── ChipOS Todo Summary Card ─────────────────────────────────────────────────

export interface IChatChiposTodoCardItem {
	title: string;
	status: 'not-started' | 'in-progress' | 'completed';
}

/**
 * [ChipOS] A permanent, read-only snapshot of the turn's todo list, rendered
 * inline in the chat history when a turn completes. The live, mutable list is
 * shown in the native sticky widget above the input (driven by
 * IChatTodoListService) while the turn runs; on completion it "graduates" into
 * one of these cards so the user can scroll back and see what got done.
 */
export interface IChatChiposTodoCard {
	kind: 'chiposTodoCard';
	todos: ReadonlyArray<IChatChiposTodoCardItem>;
}

// ── EDA PPA Report ─────────────────────────────────────────────────────────

export interface IChatEdaPpaMetrics {
	area?: number;
	delay_ns?: number;
	power_w?: number;
	wns?: number;
	tns?: number;
}

export interface IChatEdaPpaReport {
	kind: 'edaPpaReport';
	stage: 'baseline' | 'eval_round' | 'improved' | 'not_improved';
	round?: number;
	ppa?: IChatEdaPpaMetrics;
	baseline_ppa?: IChatEdaPpaMetrics;
	previous_best_ppa?: IChatEdaPpaMetrics;
	current_ppa?: IChatEdaPpaMetrics;
	best_ppa?: IChatEdaPpaMetrics;
	improvement?: Record<string, number>;
	strategy?: string;
	sta_report?: string;
	power_report?: string;
	pareto_front_size?: number;
}

// ── Union type for all EDA content parts ────────────────────────────────────

export type IChatEdaProgress =
	| IChatEdaSimReport
	| IChatEdaCoverageReport
	| IChatEdaLintReport
	| IChatEdaParallelProgress
	| IChatEdaNegotiationView
	| IChatEdaSpecReview
	| IChatRoundProgress
	| IChatAgentError
	| IChatEdaPpaReport
	| IChatChiposTodoCard;

// ── EDA kind constants ──────────────────────────────────────────────────────

export const EDA_CONTENT_KINDS = [
	'edaSimReport',
	'edaCoverageReport',
	'edaLintReport',
	'edaParallelProgress',
	'edaNegotiationView',
	'edaSpecReview',
	'roundProgress',
	'agentError',
	'edaPpaReport',
	'chiposTodoCard',
] as const;

export type EdaContentKind = typeof EDA_CONTENT_KINDS[number];

export function isEdaContentKind(kind: string): kind is EdaContentKind {
	return (EDA_CONTENT_KINDS as readonly string[]).includes(kind);
}
