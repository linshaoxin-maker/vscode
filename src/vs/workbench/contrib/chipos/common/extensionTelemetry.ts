/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';

/**
 * FEAT-006c — extension-system telemetry (count/bytes/status ONLY, never content).
 *
 * The collector/hook/usage layers hand their RAW objects (which DO carry rule
 * bodies, file paths, command text, …) to {@link buildExtensionTelemetry}, which
 * reduces them to a flat numeric payload. This is the single redaction choke
 * point: the security contract ("no capability content leaves the client") is
 * satisfiable by inspecting one pure function + its test, not the whole pipeline.
 */

/** Raw inputs — may carry content/paths; only counts + byte-lengths are read. */
export interface IExtensionTelemetryInput {
	/** Prompt-resource attachments assembled for the turn (rules/commands/skills). */
	readonly attachments?: ReadonlyArray<{ readonly content?: string }>;
	/** Auto-context pieces injected for the turn. */
	readonly autoContext?: ReadonlyArray<{ readonly content?: string }>;
	/** Hooks that fired this turn; `status` is a bucket (ok/deny/error), not content. */
	readonly hooks?: ReadonlyArray<{ readonly status?: string }>;
	/** Prompt-cache write tokens from the reasoner usage event. */
	readonly cacheCreationTokens?: number;
	/** Prompt-cache read (hit) tokens from the reasoner usage event. */
	readonly cacheReadTokens?: number;
}

/** Redacted, all-numeric telemetry payload — safe to emit. */
export interface IExtensionTelemetryPayload {
	readonly attachmentCount: number;
	readonly attachmentBytes: number;
	readonly autoContextCount: number;
	readonly autoContextBytes: number;
	readonly hookTriggers: number;
	readonly hookDenied: number;
	readonly cacheCreationTokens: number;
	readonly cacheReadTokens: number;
}

function byteLength(content: string | undefined): number {
	return content ? VSBuffer.fromString(content).byteLength : 0;
}

function clampInt(n: number | undefined): number {
	return Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0;
}

/**
 * Reduce raw extension-system inputs to a flat numeric telemetry payload.
 * Pure + deterministic; emits zero strings derived from capability content.
 */
export function buildExtensionTelemetry(input: IExtensionTelemetryInput): IExtensionTelemetryPayload {
	const attachments = input.attachments ?? [];
	const autoContext = input.autoContext ?? [];
	const hooks = input.hooks ?? [];
	return {
		attachmentCount: attachments.length,
		attachmentBytes: attachments.reduce((n, a) => n + byteLength(a.content), 0),
		autoContextCount: autoContext.length,
		autoContextBytes: autoContext.reduce((n, a) => n + byteLength(a.content), 0),
		hookTriggers: hooks.length,
		hookDenied: hooks.filter(h => h.status === 'deny' || h.status === 'denied' || h.status === 'blocked').length,
		cacheCreationTokens: clampInt(input.cacheCreationTokens),
		cacheReadTokens: clampInt(input.cacheReadTokens),
	};
}
