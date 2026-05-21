/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WorkerPermissionService — IDE-side client of the worker permission ASK
 * channel introduced in WORKER-PERMISSION-ASK-TRANSPORT.md.
 *
 * Architectural background
 * ────────────────────────
 * Worker (Nuitka binary on localhost:8081, or SSH-forwarded to localhost on a
 * remote workspace) evaluates each tool call against a 5-layer permission
 * rules engine. When a rule resolves to ASK, the worker needs to surface a
 * dialog to the user. Before this service existed, there was no channel from
 * worker → IDE for that ask, so every ASK degraded to deny ("ask_no_transport"
 * ToolMessage) and the LLM saw all writes/edits as failures.
 *
 * This service:
 *   1. Reads the worker's per-process Bearer token from instance.json (via the
 *      existing `vscode:chipos:checkInstance` IPC main handler, which already
 *      handles workspace hashing).
 *   2. Opens a fetch-based SSE stream against
 *      `GET /api/v1/permissions/stream?session_id=X` with the Bearer token in
 *      the Authorization header. Native EventSource cannot send custom
 *      headers, so we follow the same fetch+ReadableStream pattern that
 *      `grpcSseEventStreamClient.ts` uses for the reasoner stream.
 *   3. POSTs `decide` decisions back to the worker, idempotent on the worker
 *      side (second call with same ask_id returns resolved=false).
 *
 * Consumer (`ChipOSChatAgent`):
 *   - subscribes to `onAsk` once per backend session id via
 *     `startSubscription(sessionId)`
 *   - synthesizes an IChatConfirmation for each ask
 *   - on user click, calls `decide(askId, decision)`
 *
 * SSE delivery is independent of the reasoner stream — the worker delivers
 * directly, so reasoner restarts don't kill the ASK pipeline.
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISidecarManagerService } from '../../common/sidecarService.js';

export interface IWorkerPermissionAsk {
	readonly askId: string;
	readonly sessionId: string;
	readonly tool: string;
	readonly specifier: string;
	readonly actionSummary: string;
	readonly workspaceRoot: string;
	readonly matchedRule: string;
	readonly matchedLayer: string;
	readonly createdAtMs: number;
	readonly lastEventId: number;
	/**
	 * Phase A (PERMISSION-APPROVAL-UX-V2 §4.1) — optional extras the worker
	 * sends so the IDE card can render rule attribution, file context and a
	 * collapsible content preview without an extra round-trip. Older workers
	 * (pre-Phase A) leave these undefined; the renderer must degrade
	 * gracefully when missing.
	 */
	readonly contentPreview?: string;
	readonly targetExists?: boolean;
	readonly targetSizeBytes?: number;
}

export type WorkerPermissionDecision = 'allow' | 'deny';

/**
 * Persistence scope for an allow decision (PERMISSION-APPROVAL-UX-V2 §3).
 * - `once`     — answer the current ASK, do not write a rule
 * - `workspace`— write Tool(path)=allow to <workspace>/.chipos/permissions.local.json
 * - `user`     — write to ~/.chipos/permissions.json
 *
 * Worker hot-reloads either file on change, so subsequent equivalent tool
 * calls match the new rule directly and never fire an ASK again.
 */
export type WorkerPermissionScope = 'once' | 'workspace' | 'user';

interface IWorkerCheckInstanceResult {
	readonly alive: boolean;
	readonly pid?: number;
	readonly ref_count?: number;
	readonly http_port?: number;
	readonly permission_token?: string;
}

export const IChipOSWorkerPermissionService = createDecorator<IChipOSWorkerPermissionService>('chiposWorkerPermissionService');

export interface IChipOSWorkerPermissionService {
	readonly _serviceBrand: undefined;
	readonly onAsk: Event<IWorkerPermissionAsk>;
	/**
	 * Open the SSE subscription for the given backend `sessionId`. Returns a
	 * disposable that closes the underlying fetch stream. Calling repeatedly
	 * for the same sessionId is a no-op (returns a disposable wired to the
	 * existing subscription).
	 */
	startSubscription(sessionId: string): Promise<IDisposable>;
	/**
	 * POST a decision back to the worker. Idempotent on the worker side — a
	 * second call for the same askId returns 200 with resolved=false.
	 *
	 * `scope` (default `once`) controls whether the answer becomes a permanent
	 * rule on the worker disk; see {@link WorkerPermissionScope}. Only
	 * meaningful for `decision === 'allow'`; deny is always per-ask.
	 */
	decide(askId: string, decision: WorkerPermissionDecision, comment?: string, scope?: WorkerPermissionScope): Promise<void>;
}

interface IPermissionEndpointMeta {
	readonly token: string;
	readonly baseUrl: string;
}

interface ISubscriptionEntry {
	readonly sessionId: string;
	/** Replaced on every reconnect attempt — abort the in-flight fetch to cancel cleanly. */
	abortController: AbortController;
	/** Last event id seen, for Last-Event-ID reconnect. */
	lastEventId: number;
	/** Pending reconnect timer so we can clear it on dispose. */
	reconnectHandle?: ReturnType<typeof setTimeout>;
	/** Set to true once dispose() runs; the read loop checks before reconnecting. */
	disposed: boolean;
	/**
	 * Bug #10: askIds we've already emitted on `onAsk` for this subscription.
	 *
	 * Worker side `PendingAskRegistry.get_backlog_after()` (registry.py:282)
	 * intentionally re-sends resolved asks on SSE reconnect so a client that
	 * missed events during disconnect can see the complete history. The IDE
	 * does NOT render this as history though — every `onAsk` fires a fresh
	 * confirmation card. Without dedup, every SSE reconnect duplicates each
	 * card the worker has in its 60s backlog window. Observed in dogfood as
	 * "stale ASK cards pile up" after a few network blips.
	 *
	 * Bounded to MAX_SEEN_ASK_IDS to cap memory; LRU eviction by insertion
	 * order via `Map` + manual size check. Cleared when subscription is
	 * disposed (closeSubscription → entry deleted, set GC'd).
	 */
	seenAskIds: Map<string, number>;
}

/**
 * Bug #10: per-subscription seen-askId cache cap.
 *
 * Worker side has MAX_PENDING_ASKS=64 (registry.py:46) and BACKLOG_SIZE=10
 * (line 49), so 128 is comfortably above any realistic working set while
 * bounding memory in pathological cases (worker bug spamming askIds).
 */
const MAX_SEEN_ASK_IDS = 128;

/** Backoff schedule (ms) for fetch-based SSE reconnect — same shape as grpcSseEventStreamClient. */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

export class ChipOSWorkerPermissionService extends Disposable implements IChipOSWorkerPermissionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onAsk = this._register(new Emitter<IWorkerPermissionAsk>());
	readonly onAsk: Event<IWorkerPermissionAsk> = this._onAsk.event;

	private readonly _subscriptions = new Map<string, ISubscriptionEntry>();

	constructor(
		@ISidecarManagerService private readonly _sidecarManagerService: ISidecarManagerService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async startSubscription(sessionId: string): Promise<IDisposable> {
		if (!sessionId) {
			return Disposable.None;
		}

		if (this._subscriptions.has(sessionId)) {
			return toDisposable(() => this._closeSubscription(sessionId));
		}

		const entry: ISubscriptionEntry = {
			sessionId,
			abortController: new AbortController(),
			lastEventId: 0,
			disposed: false,
			seenAskIds: new Map<string, number>(),
		};
		this._subscriptions.set(sessionId, entry);

		// Kick off the read loop in the background; do not block the caller.
		void this._runSseLoop(entry, 0);

		return toDisposable(() => this._closeSubscription(sessionId));
	}

	private _closeSubscription(sessionId: string): void {
		const entry = this._subscriptions.get(sessionId);
		if (!entry) {
			return;
		}
		this._subscriptions.delete(sessionId);
		entry.disposed = true;
		if (entry.reconnectHandle !== undefined) {
			clearTimeout(entry.reconnectHandle);
			entry.reconnectHandle = undefined;
		}
		try {
			entry.abortController.abort();
		} catch {
			// best effort
		}
		this._logService.info(`[ChipOS WorkerPermission] SSE closed session=${sessionId}`);
	}

	private async _runSseLoop(entry: ISubscriptionEntry, attempt: number): Promise<void> {
		if (entry.disposed) {
			return;
		}

		let meta: IPermissionEndpointMeta;
		try {
			meta = await this._resolveEndpoint();
		} catch (err) {
			if (entry.disposed) {
				return;
			}
			this._logService.warn(`[ChipOS WorkerPermission] subscribe ${entry.sessionId} — endpoint unresolved: ${err}`);
			this._scheduleReconnect(entry, attempt);
			return;
		}

		// Bug-7 fix: dispose can run during the await above; re-check before
		// allocating a new AbortController and burning a fetch slot.
		if (entry.disposed) {
			return;
		}

		if (!meta.token) {
			// Worker is a legacy build without permission_token. Don't loop
			// forever poking it; just stay disposed and let the next worker
			// restart trigger a fresh subscription attempt via the chat agent.
			this._logService.info(`[ChipOS WorkerPermission] no permission_token yet for session=${entry.sessionId}; deferring`);
			this._scheduleReconnect(entry, attempt);
			return;
		}

		// Token is placed in the URL query rather than the Authorization
		// header so this is a CORS "simple request" — no preflight OPTIONS.
		// The Electron sandbox renderer rejects fetch to localhost when a
		// CORS preflight is involved (TypeError: Failed to fetch in <5ms),
		// even though workerToolManager fetches localhost OK (no Authorization
		// → no preflight). Worker side _check_bearer_token accepts both.
		const params = new URLSearchParams();
		params.set('session_id', entry.sessionId);
		if (meta.token) {
			params.set('token', meta.token);
		}
		if (entry.lastEventId > 0) {
			// Last-Event-ID is a "non-simple" request header, so we also pass
			// it via query to keep this a simple request.
			params.set('last_event_id', String(entry.lastEventId));
		}
		const url = `${meta.baseUrl}/api/v1/permissions/stream?${params.toString()}`;
		const headers: Record<string, string> = {
			'Accept': 'text/event-stream',
		};

		this._logService.info(`[ChipOS WorkerPermission] SSE connecting url=${url} session=${entry.sessionId} lastEventId=${entry.lastEventId} attempt=${attempt}`);

		// Abort the previous in-flight fetch (if any) before replacing the
		// controller. Only abort if attempt > 0 — on first attempt the
		// controller is a fresh one created in startSubscription and aborting
		// it is harmless but unnecessary noise.
		if (attempt > 0) {
			try {
				entry.abortController.abort();
			} catch { /* best effort */ }
		}
		entry.abortController = new AbortController();

		let resp: Response;
		try {
			resp = await fetch(url, {
				method: 'GET',
				headers,
				signal: entry.abortController.signal,
				// Explicit cache + credentials to ensure no preflight is required.
				// "omit" credentials + simple-mode means no cookies / CORS preflight.
				credentials: 'omit',
				cache: 'no-store',
				mode: 'cors',
			});
		} catch (err) {
			if ((err as { name?: string }).name === 'AbortError' || entry.disposed) {
				return;
			}
			this._logService.warn(`[ChipOS WorkerPermission] SSE fetch failed session=${entry.sessionId}: ${err}`);
			this._scheduleReconnect(entry, attempt);
			return;
		}

		if (resp.status === 401) {
			// Token likely rotated (worker restart). Drop cached info and back
			// off so the next attempt re-reads instance.json.
			this._logService.warn(`[ChipOS WorkerPermission] SSE 401 session=${entry.sessionId} — token likely stale, retrying`);
			this._scheduleReconnect(entry, attempt);
			return;
		}

		if (!resp.ok || !resp.body) {
			this._logService.warn(`[ChipOS WorkerPermission] SSE HTTP ${resp.status} session=${entry.sessionId}`);
			this._scheduleReconnect(entry, attempt);
			return;
		}

		this._logService.info(`[ChipOS WorkerPermission] SSE open session=${entry.sessionId}`);

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			// Reset attempt counter once the stream is healthy.
			attempt = 0;

			let currentId = entry.lastEventId;
			let currentEvent = '';
			let currentData = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					this._logService.info(`[ChipOS WorkerPermission] SSE stream ended session=${entry.sessionId}`);
					break;
				}
				if (entry.disposed) {
					return;
				}
				buffer += decoder.decode(value, { stream: true });

				// Split on '\n' (the SSE spec accepts both \n and \r\n; \r alone is
				// rare in practice — keeping the parser tight for simplicity).
				let nl = buffer.indexOf('\n');
				while (nl !== -1) {
					const rawLine = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf('\n');
					const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

					if (line === '') {
						// Dispatch completed event.
						if (currentData) {
							this._handleSseEvent(entry, currentEvent || 'message', currentData, currentId);
						}
						currentEvent = '';
						currentData = '';
						continue;
					}
					if (line.startsWith(':')) {
						// SSE comment / heartbeat — ignore.
						continue;
					}
					const colon = line.indexOf(':');
					const field = colon === -1 ? line : line.slice(0, colon);
					const valueStart = colon === -1 ? line.length : (line[colon + 1] === ' ' ? colon + 2 : colon + 1);
					const fieldValue = line.slice(valueStart);

					if (field === 'event') {
						currentEvent = fieldValue;
					} else if (field === 'data') {
						currentData = currentData ? `${currentData}\n${fieldValue}` : fieldValue;
					} else if (field === 'id') {
						const parsed = parseInt(fieldValue, 10);
						if (!Number.isNaN(parsed)) {
							currentId = parsed;
						}
					}
					// `retry:` is informational; we ignore in favor of our own backoff.
				}
			}
		} catch (err) {
			if ((err as { name?: string }).name === 'AbortError' || entry.disposed) {
				return;
			}
			this._logService.warn(`[ChipOS WorkerPermission] SSE read error session=${entry.sessionId}: ${err}`);
		}

		if (!entry.disposed) {
			this._scheduleReconnect(entry, attempt);
		}
	}

	private _handleSseEvent(entry: ISubscriptionEntry, eventName: string, data: string, lastEventId: number): void {
		if (lastEventId > entry.lastEventId) {
			entry.lastEventId = lastEventId;
		}
		if (eventName !== 'permission_ask') {
			// Future event types (heartbeat, etc.) — silently skip.
			return;
		}
		let payload: {
			ask_id?: string;
			session_id?: string;
			tool?: string;
			specifier?: string;
			action_summary?: string;
			workspace_root?: string;
			matched_rule?: string;
			matched_layer?: string;
			created_at_ms?: number;
			last_event_id?: number;
			content_preview?: string;
			target_exists?: boolean;
			target_size_bytes?: number;
		};
		try {
			payload = JSON.parse(data);
		} catch (err) {
			this._logService.warn(`[ChipOS WorkerPermission] failed to parse permission_ask: ${err}`);
			return;
		}
		if (!payload.ask_id) {
			this._logService.warn(`[ChipOS WorkerPermission] permission_ask missing ask_id: ${data.slice(0, 200)}`);
			return;
		}

		// Bug #10: dedup by ask_id within this subscription.
		//
		// Worker side `PendingAskRegistry.get_backlog_after()` re-sends resolved
		// asks on SSE reconnect (registry.py:282 — "包括已 resolve 的"). Without
		// this guard each network blip stacks duplicate cards in the chat for
		// every ask still in the worker's 60s backlog window. Observed in
		// dogfood as "stale ASK cards pile up".
		//
		// Single-emission policy: same ask_id never fires `onAsk` twice from
		// this subscription. Idempotency at the worker decide endpoint already
		// covers double-click (decide called twice returns 200 {resolved:false}),
		// so we don't need to relay re-fires for that case either.
		if (entry.seenAskIds.has(payload.ask_id)) {
			this._logService.info(
				`[ChipOS WorkerPermission] ASK dedup: skip already-seen ask_id=${payload.ask_id} session=${entry.sessionId} (likely SSE backlog replay)`
			);
			return;
		}
		entry.seenAskIds.set(payload.ask_id, Date.now());
		// LRU-ish: trim oldest entries when the cache grows. Map preserves
		// insertion order, so deleting from .keys()[0] is O(1) per evict.
		if (entry.seenAskIds.size > MAX_SEEN_ASK_IDS) {
			const oldest = entry.seenAskIds.keys().next().value;
			if (oldest !== undefined) {
				entry.seenAskIds.delete(oldest);
			}
		}

		const ask: IWorkerPermissionAsk = {
			askId: payload.ask_id,
			sessionId: payload.session_id ?? entry.sessionId,
			tool: payload.tool ?? '',
			specifier: payload.specifier ?? '',
			actionSummary: payload.action_summary ?? '',
			workspaceRoot: payload.workspace_root ?? '',
			matchedRule: payload.matched_rule ?? '',
			matchedLayer: payload.matched_layer ?? '',
			createdAtMs: payload.created_at_ms ?? Date.now(),
			lastEventId: payload.last_event_id ?? lastEventId,
			contentPreview: payload.content_preview,
			targetExists: payload.target_exists,
			targetSizeBytes: payload.target_size_bytes,
		};
		this._logService.info(`[ChipOS WorkerPermission] ASK received id=${ask.askId} tool=${ask.tool} session=${ask.sessionId}`);
		this._onAsk.fire(ask);
	}

	private _scheduleReconnect(entry: ISubscriptionEntry, attempt: number): void {
		if (entry.disposed) {
			return;
		}
		const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
		this._logService.info(`[ChipOS WorkerPermission] reconnecting session=${entry.sessionId} in ${delay}ms (attempt ${attempt + 1})`);
		entry.reconnectHandle = setTimeout(() => {
			entry.reconnectHandle = undefined;
			if (!entry.disposed) {
				void this._runSseLoop(entry, attempt + 1);
			}
		}, delay);
	}

	async decide(askId: string, decision: WorkerPermissionDecision, comment?: string, scope: WorkerPermissionScope = 'once'): Promise<void> {
		if (!askId) {
			return;
		}

		const meta = await this._resolveEndpoint();
		const url = `${meta.baseUrl}/api/v1/permissions/${encodeURIComponent(askId)}/decide`;

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (meta.token) {
			headers['Authorization'] = `Bearer ${meta.token}`;
		}

		const body = JSON.stringify({ decision, comment: comment ?? '', scope });

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			const msg = `decide ${askId} returned HTTP ${response.status}${text ? ` — ${text}` : ''}`;
			this._logService.warn(`[ChipOS WorkerPermission] ${msg}`);
			throw new Error(msg);
		}

		this._logService.info(`[ChipOS WorkerPermission] decide ${askId} → ${decision} accepted`);
	}

	override dispose(): void {
		for (const sessionId of [...this._subscriptions.keys()]) {
			this._closeSubscription(sessionId);
		}
		super.dispose();
	}

	private async _resolveEndpoint(): Promise<IPermissionEndpointMeta> {
		const baseUrl = (this._sidecarManagerService.workerHttpUrl ?? '').replace(/\/$/, '');
		if (!baseUrl) {
			throw new Error('worker HTTP URL not configured');
		}

		const token = await this._readPermissionToken();
		return { baseUrl, token };
	}

	private async _readPermissionToken(): Promise<string> {
		const workspaceRoot = this._currentWorkspaceRoot();
		if (!workspaceRoot) {
			return '';
		}
		const reader = this._sidecarManagerService.readInstanceMeta;
		if (!reader) {
			// SidecarManagerBrowser (web) or older Electron sidecar that doesn't
			// surface instance.json. Legacy fallback: no token, no auth.
			return '';
		}
		try {
			const meta = await reader(workspaceRoot);
			return (meta as IWorkerCheckInstanceResult).permission_token ?? '';
		} catch (err) {
			this._logService.warn(`[ChipOS WorkerPermission] readInstanceMeta failed: ${err}`);
			return '';
		}
	}

	private _currentWorkspaceRoot(): string {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return '';
		}
		const uri = folders[0].uri;
		return URI.isUri(uri) && uri.scheme === 'file' ? uri.fsPath : uri.toString();
	}
}

registerSingleton(IChipOSWorkerPermissionService, ChipOSWorkerPermissionService, InstantiationType.Delayed);
