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
	line_cov: number;
	branch_cov: number;
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

export interface IChatEdaSpecReview {
	kind: 'edaSpecReview';
	spec_path: string;
	spec_name: string;
	summary: string;
	files?: string[];
}

// ── Agent Round Progress ────────────────────────────────────────────────────

export interface IChatRoundProgress {
	kind: 'roundProgress';
	current_round: number;
	max_rounds: number;
	phase?: string;
}

// ── Agent Error Card ────────────────────────────────────────────────────────

export interface IChatAgentError {
	kind: 'agentError';
	error_code: string;
	message: string;
	retryable: boolean;
	suggestion?: string;
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
	| IChatAgentError;

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
] as const;

export type EdaContentKind = typeof EDA_CONTENT_KINDS[number];

export function isEdaContentKind(kind: string): kind is EdaContentKind {
	return (EDA_CONTENT_KINDS as readonly string[]).includes(kind);
}
