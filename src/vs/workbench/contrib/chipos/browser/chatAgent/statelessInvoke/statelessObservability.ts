/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Client-observable counters for the stateless-reasoner cutover ramp
 * (PHASE-1-CUTOVER-PLAN §5). These complement the reasoner-side `/metrics`
 * exposition by capturing signals only the IDE can see:
 *   - auto-resume *triggers* + their outcome (recovered vs. lost) and how many
 *     network-down retries it took — the reasoner never sees the attempts that
 *     fail to connect, so this is the client's side of resilience §5.2;
 *   - turn errors as the *client* categorised them (AUTH/WORKER/TOOL/PROTO/
 *     INTERNAL), which lines up with `chipos_invoke_error_total`;
 *   - confirm round-trips initiated client-side.
 *
 * Emitted through VS Code's standard `ITelemetryService` pipeline (one event
 * with a `metric`/`label` discriminator so a dashboard can slice it) rather
 * than a parallel channel. No-ops gracefully when no telemetry backend is
 * configured.
 */

import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { buildExtensionTelemetry, IExtensionTelemetryInput } from '../../../common/extensionTelemetry.js';

type StatelessObserveEvent = {
	metric: string;
	label: string;
	count: number;
};

type StatelessObserveClassification = {
	owner: 'chipos';
	comment: 'Client-observable counters for the stateless reasoner cutover ramp (PHASE-1-CUTOVER-PLAN §5).';
	metric: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Which counter: turn_error / confirm_shown / resume_triggered / resume_outcome.' };
	label: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Bucket for the metric, e.g. error category, resume outcome, or trigger reason.' };
	count: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Value (1 for a plain counter; resume retry attempt count for resume_outcome).'; isMeasurement: true };
};

// FEAT-006c — extension-system usage per turn. All fields are measurements; the
// payload is produced by `buildExtensionTelemetry` (count/bytes/status, never content).
type ChiposExtensionUsageEvent = {
	attachmentCount: number;
	attachmentBytes: number;
	autoContextCount: number;
	autoContextBytes: number;
	hookTriggers: number;
	hookDenied: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};

type ChiposExtensionUsageClassification = {
	owner: 'chipos';
	comment: 'FEAT-006c extension-system usage per turn — count/bytes/status only, never capability content.';
	attachmentCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Prompt-resource attachments sent this turn.'; isMeasurement: true };
	attachmentBytes: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Total bytes of those attachments.'; isMeasurement: true };
	autoContextCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Auto-context pieces injected this turn.'; isMeasurement: true };
	autoContextBytes: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Total bytes of auto-context.'; isMeasurement: true };
	hookTriggers: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Hooks that fired this turn.'; isMeasurement: true };
	hookDenied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Of those, how many denied/blocked.'; isMeasurement: true };
	cacheCreationTokens: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Prompt-cache write tokens (reasoner usage).'; isMeasurement: true };
	cacheReadTokens: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Prompt-cache read/hit tokens (reasoner usage).'; isMeasurement: true };
};

/**
 * Thin wrapper over `ITelemetryService` that emits the stateless ramp
 * counters. Created via `IInstantiationService.createInstance`.
 */
export class StatelessObservability {

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) { }

	private _emit(metric: string, label: string, count = 1): void {
		this._telemetryService.publicLog2<StatelessObserveEvent, StatelessObserveClassification>(
			'chipos.stateless.observe',
			{ metric, label, count },
		);
	}

	/** A turn surfaced a structured error; `category` is the backend bucket. */
	turnError(category: string | undefined, _errorCode: string | undefined): void {
		this._emit('turn_error', (category ?? 'INTERNAL').toUpperCase());
	}

	/** The IDE rendered a confirm card (a reverse-channel round-trip began). */
	confirmShown(cardType: string | undefined): void {
		this._emit('confirm_shown', cardType ?? 'unknown');
	}

	/** Auto-resume kicked in. `reason` ∈ network-drop / auto-restart / manual-card. */
	resumeTriggered(reason: string): void {
		this._emit('resume_triggered', reason);
	}

	/**
	 * Auto-resume finished. `outcome` ∈ success / gave-up / trace-not-found /
	 * replay-window-expired. `attempts` rides along as the measurement so the
	 * dashboard can read the retry-count distribution (the network-down retries
	 * the reasoner never observes).
	 */
	resumeOutcome(outcome: string, attempts: number): void {
		this._emit('resume_outcome', outcome, attempts);
	}

	/**
	 * FEAT-006c: report extension-system usage for the turn. Content-free —
	 * `buildExtensionTelemetry` reduces the raw capability objects (which carry
	 * rule bodies / paths) to counts/bytes/status before anything is emitted.
	 * Async via the standard telemetry pipeline; no-ops with no backend.
	 */
	extensionUsage(input: IExtensionTelemetryInput): void {
		this._telemetryService.publicLog2<ChiposExtensionUsageEvent, ChiposExtensionUsageClassification>(
			'chipos.extensions.usage',
			buildExtensionTelemetry(input),
		);
	}
}
