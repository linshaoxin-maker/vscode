/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE FullTracer — T6b client side of ADR-009 §4.2.
 *
 * Buffers IDE-side trace events (chat bubble renders, user interactions,
 * webview errors) per chat round, then on round end POSTs the batch to
 * reasoner `/v1/trace/upload` so reasoner can attach IDE-side artefacts
 * to the master trace.jsonl as `ide_event_ref` payloads.
 *
 * Lifecycle (per chat round):
 *
 *   round_start (from WS event_type=round_start, OR first TextDelta with
 *                a fresh trace_id we haven't seen yet)
 *   ↓
 *   begin(trace_id)                  ← FullTracer starts buffering
 *   ↓
 *   record(event_type, data)         ← multiple times during the round
 *   ↓
 *   task_complete                    ← chat round ends
 *   ↓
 *   flush()                          ← POST batch to reasoner, clear buffer
 *
 * Design notes:
 *
 *   - Events are buffered in-memory only. We do NOT persist to disk in v1
 *     (vscode-extension secondary surface eventually needs offline cache;
 *     this primary chipos-IDE client doesn't, since it's connected to the
 *     reasoner via the same WS — disconnect = chat is over anyway).
 *
 *   - `trace_id` comes from IAgentEventBase.trace_id (injected by
 *     webSocketEventStreamClient._emit from the top-level reasoner
 *     ServerEvent). When trace_id is empty (early events before reasoner
 *     starts a round) we drop the event silently.
 *
 *   - Reasoner endpoint: resolveReasoningUrl() base + `/v1/trace/upload`.
 *     Auth: Authorization: Bearer <access_token> (chiposTokenManager).
 *     CHIPOS_TRACE_UPLOAD=0 env disables uploads (T11 opt-out tier 2).
 *
 *   - render_id: per-batch UUID (URI-safe, monotonic) so reasoner can
 *     dedupe re-uploads (idempotent — reasoner artifacts/ide/<render_id>/
 *     just gets overwritten).
 *
 *   - Failure mode: log error, drop the batch. Don't retry — the chat
 *     round is over by the time we flush, and the master trace already
 *     has the reasoner-side spans. Missing IDE events degrade
 *     observability gracefully.
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IChipOSTokenManager } from '../auth/chiposTokenManager.js';
import { resolveReasoningUrl } from '../../common/chiposEndpoints.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

/**
 * One IDE-side trace event. Mirrors the JSONL line format reasoner reads
 * out of `artifacts/ide/<render_id>/events.jsonl` (T7 contract).
 *
 * Field naming follows reasoner trace.jsonl convention (snake_case) so
 * cross-tier replay tools can treat reasoner + worker + ide events
 * uniformly (replay_trace.py knows all 3 schemas).
 */
export interface IIdeTraceEvent {
	readonly event_type: string;        // 'chat_bubble_render' | 'user_action' | 'webview_error' | ...
	readonly ts: number;                // unix epoch seconds (Date.now() / 1000)
	readonly trace_id: string;
	readonly data: Record<string, unknown>;
}

/**
 * Returned to caller from flush() so caller can log the result.
 */
export interface IFullTracerFlushResult {
	readonly trace_id: string;
	readonly render_id: string;
	readonly events_count: number;
	readonly status: 'uploaded' | 'skipped_disabled' | 'skipped_empty' | 'failed';
	readonly error?: string;
}


export class FullTracer extends Disposable {
	private _activeTraceId: string | undefined;
	private _activeRenderId: string | undefined;
	private _buffer: IIdeTraceEvent[] = [];

	// Cap so a runaway tool loop can't OOM the IDE process. Realistic chat
	// rounds emit <100 IDE events; cap at 5000 to be generous.
	private static readonly MAX_BUFFER = 5000;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProductService private readonly _productService: IProductService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
	) {
		super();
	}

	/**
	 * Start buffering for a new chat round. Emits a 'round_start' event into
	 * the buffer so reasoner-side IDE event timeline starts with a marker.
	 */
	begin(traceId: string): void {
		if (!traceId) {
			return;
		}
		// Implicit flush of any prior round that didn't get a TaskComplete
		// (network drop / WS reconnect mid-round). We drop the prior buffer
		// rather than upload it — the trace_id we'd target may be stale.
		if (this._activeTraceId && this._activeTraceId !== traceId) {
			this._logService.warn(
				'[FullTracer] new round trace_id %s while %s still active — dropping %d buffered events',
				traceId, this._activeTraceId, this._buffer.length,
			);
			this._buffer = [];
		}
		this._activeTraceId = traceId;
		this._activeRenderId = `ide-${generateUuid()}`;
		this._record('round_start', { render_id: this._activeRenderId });
	}

	/**
	 * Record one IDE-side event for the current round. Drops silently if no
	 * round is active or buffer is full (with a warn log).
	 */
	record(event_type: string, data: Record<string, unknown> = {}): void {
		this._record(event_type, data);
	}

	private _record(event_type: string, data: Record<string, unknown>): void {
		if (!this._activeTraceId) {
			return;
		}
		if (this._buffer.length >= FullTracer.MAX_BUFFER) {
			// Log once per overflow to avoid spam
			if (this._buffer.length === FullTracer.MAX_BUFFER) {
				this._logService.warn(
					'[FullTracer] buffer cap %d reached for trace %s; subsequent events dropped',
					FullTracer.MAX_BUFFER, this._activeTraceId,
				);
			}
			this._buffer.push(null as any); // marker so length keeps growing past cap, but no more real events stored
			return;
		}
		this._buffer.push({
			event_type,
			ts: Date.now() / 1000,
			trace_id: this._activeTraceId,
			data,
		});
	}

	/**
	 * End the current round and POST buffered events to reasoner.
	 *
	 * Idempotent: calling flush() twice in a row is safe — second call
	 * sees an empty buffer and returns 'skipped_empty'.
	 */
	async flush(): Promise<IFullTracerFlushResult> {
		const traceId = this._activeTraceId;
		const renderId = this._activeRenderId;
		const events = this._buffer.filter(e => e !== null) as IIdeTraceEvent[];
		// Reset state immediately so a concurrent begin() sees clean slate.
		this._activeTraceId = undefined;
		this._activeRenderId = undefined;
		this._buffer = [];

		if (!traceId || !renderId) {
			return { trace_id: '', render_id: '', events_count: 0, status: 'skipped_empty' };
		}

		// T11 opt-out tier 2: env CHIPOS_TRACE_UPLOAD=0 disables. Settings
		// `chipos.trace.uploadEnabled = false` is a per-user equivalent.
		const uploadEnabled = this._configurationService.getValue<boolean>('chipos.trace.uploadEnabled');
		if (uploadEnabled === false) {
			return { trace_id: traceId, render_id: renderId, events_count: events.length, status: 'skipped_disabled' };
		}

		if (events.length === 0) {
			return { trace_id: traceId, render_id: renderId, events_count: 0, status: 'skipped_empty' };
		}

		// Build NDJSON body
		const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';

		// Resolve endpoint + auth
		let endpoint: string;
		try {
			const reasoningUrl = resolveReasoningUrl(this._configurationService, this._productService);
			endpoint = reasoningUrl.replace(/\/+$/, '') + '/v1/trace/upload';
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.warn('[FullTracer] resolveReasoningUrl failed: %s — dropping batch', msg);
			return { trace_id: traceId, render_id: renderId, events_count: events.length, status: 'failed', error: msg };
		}

		const token = await this._tokenManager.getAccessToken();
		// Token might be undefined in dev-mode CHIPOS_SKIP_AUTH; reasoner
		// will reject (401) but we still try — the dev path uses
		// CHIPOS_SKIP_AUTH=1 server-side which bypasses verify, so the
		// request goes through.

		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/x-ndjson',
				'X-Chipos-Trace-Id': traceId,
				'X-Chipos-Render-Id': renderId,
			};
			if (token) {
				headers['Authorization'] = `Bearer ${token}`;
			}
			const res = await fetch(endpoint, { method: 'POST', headers, body });
			if (!res.ok) {
				const detail = await res.text().catch(() => res.statusText);
				const msg = `${res.status} ${detail.slice(0, 200)}`;
				this._logService.warn('[FullTracer] upload failed: %s', msg);
				return { trace_id: traceId, render_id: renderId, events_count: events.length, status: 'failed', error: msg };
			}
			this._logService.info(
				'[FullTracer] uploaded %d events for trace=%s render=%s',
				events.length, traceId, renderId,
			);
			return { trace_id: traceId, render_id: renderId, events_count: events.length, status: 'uploaded' };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.warn('[FullTracer] upload exception: %s', msg);
			return { trace_id: traceId, render_id: renderId, events_count: events.length, status: 'failed', error: msg };
		}
	}

	/**
	 * Inspect current state — for tests / diagnostics.
	 */
	get bufferedEventCount(): number {
		return this._buffer.length;
	}

	get activeTraceId(): string | undefined {
		return this._activeTraceId;
	}
}
