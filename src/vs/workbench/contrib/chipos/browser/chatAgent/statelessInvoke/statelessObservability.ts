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
}
