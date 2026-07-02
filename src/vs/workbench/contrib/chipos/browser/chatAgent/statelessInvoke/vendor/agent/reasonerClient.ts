/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/agent/reasonerClient.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/*---------------------------------------------------------------------------------------------
 *  Phase 2-A: ReasonerClient — vscode-extension gateway to the backend_v2
 *  reasoner `/api/v1` endpoints.
 *
 *  Mirrors the chipos IDE `statelessInvoke/statelessClient.ts` method face
 *  (invoke / cancel / resume / postConfirmResponse / postToolResult /
 *  registerTools) but built on the extension's shared `fetchSSE` primitive, and
 *  it owns the tool-catalog handshake: register once per chat session, cache the
 *  catalog_version, send it as `expected_catalog_version` on every invoke, and
 *  re-register + retry once on a 412 mismatch (ADR-018 §2 D9 / R-S).
 *
 *  Auth: a per-request bearer provider (preferred over a static token) is
 *  resolved fresh immediately before EVERY request, so a long-lived turn's late
 *  /resume · /confirm_response · /tool_result — which fire minutes after
 *  invoke-start, past the JWT TTL — pick up a refreshed token instead of 401ing.
 *
 *  No vscode import — pure transport, unit-testable with an injected fetch.
 *--------------------------------------------------------------------------------------------*/

import {
	fetchEventStream,
	SseHttpError,
	type FetchEventStreamInit,
	type SseStatusOverride,
} from '../transport/fetchSSE.js';
import {
	type CancelRequest,
	type CompactRequest,
	type CompactResponse,
	type ConfirmResponseRequest,
	type HookResultRequest,
	type InvokeEvent,
	type InvokeRequest,
	type InvokeRequestInput,
	type RegisterToolsRequest,
	type RegisterToolsResponse,
	type ResumeRequest,
	type ToolDefinition,
	type ToolResultRequest,
	type TurnStateResponse,
} from './invokeTypes.js';
import { type SkillTreeData } from '../types/protocol.js';

// ── Errors ─────────────────────────────────────────────────────────────────

/** Server returned a non-2xx status the client couldn't special-case. */
export class ReasonerHttpError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown, message?: string) {
		super(message ?? `reasoner returned HTTP ${status}`);
		this.name = 'ReasonerHttpError';
		this.status = status;
		this.body = body;
	}
}

/** `resume()` got HTTP 404 — no in-flight turn (likely finished naturally). */
export class ReasonerResumeNotFoundError extends Error {
	readonly traceId: string;
	constructor(traceId: string) {
		super(`no in-flight turn for trace_id=${traceId}`);
		this.name = 'ReasonerResumeNotFoundError';
		this.traceId = traceId;
	}
}

/** `resume()` got HTTP 410 — the SSE replay buffer was evicted (session expired). */
export class ReasonerReplayExpiredError extends Error {
	readonly traceId: string;
	constructor(traceId: string) {
		super(`replay window expired or unknown trace_id=${traceId}`);
		this.name = 'ReasonerReplayExpiredError';
		this.traceId = traceId;
	}
}

// ── Logger (structural; vscode-shim ILogger is assignable) ───────────────────

export interface ReasonerLogger {
	debug?(message: string, ...args: unknown[]): void;
	info?(message: string, ...args: unknown[]): void;
	warn?(message: string, ...args: unknown[]): void;
	error?(message: string, ...args: unknown[]): void;
}

// ── Options + response shapes ────────────────────────────────────────────────

export interface ReasonerClientOptions {
	/** e.g. "http://127.0.0.1:8080" — trailing slash is stripped. */
	readonly baseUrl: string;
	/**
	 * Preferred bearer provider, resolved fresh per request (chiposTokenManager
	 * .getAccessToken auto-refreshes a near-expiry token). When set, wins over
	 * the static `authToken`.
	 */
	readonly authTokenProvider?: () => Promise<string | undefined>;
	/**
	 * FORCE a token refresh (chiposTokenManager.refreshAccessToken — bypasses the
	 * cache) and return the new bearer. Called when a request comes back 401 in a
	 * long session: the proactive near-expiry refresh in `authTokenProvider` can be
	 * defeated by an unparseable `exp`, clock skew, or a server-side revoke, so a
	 * hard 401 needs an explicit refresh + a single retry before surfacing. When
	 * absent (static token / tests not exercising auth), a 401 is surfaced as-is.
	 */
	readonly refreshTokenProvider?: () => Promise<string | undefined>;
	/** Static bearer fallback (tests / auth-disabled dev). */
	readonly authToken?: string;
	/** Inject for tests; defaults to global fetch. */
	readonly fetchFn?: typeof fetch;
	/** Idle timeout for SSE streams (ms). Default 600_000 (10 min). */
	readonly requestTimeoutMs?: number;
	/** Timeout for the short non-SSE POST/GET calls (ms). Default 30_000. */
	readonly postTimeoutMs?: number;
	/**
	 * Returns the IDE-side tool catalog to register for a chat session. Phase 2-A
	 * registers only a noop sentinel (reverse-channel IDE tool execution is 2B);
	 * worker EDA tools are advertised reasoner-side, not here. When absent or
	 * empty, a noop sentinel is registered so the handshake completes.
	 */
	readonly catalogProvider?: () => ToolDefinition[];
	readonly ideVersion?: string;
	readonly logger?: ReasonerLogger;
}

export type CancelResponse =
	| { cancelled: boolean; trace_id: string; reason: string }
	| { error: string; [k: string]: unknown };

/** Returned by `checkHealth()` so the caller can drive a connection indicator. */
export interface ReasonerHealth {
	reachable: boolean;
	status?: number;
	authFailed?: boolean;
}

const NOOP_TOOL: ToolDefinition = {
	name: 'noop',
	description: 'No IDE-callable tools enabled in this session.',
	input_schema: { type: 'object', properties: {} },
	chipos_source: 'ide_builtin',
};

export class ReasonerClient {
	private readonly _baseUrl: string;
	private readonly _authToken: string | undefined;
	private readonly _authTokenProvider?: () => Promise<string | undefined>;
	private readonly _refreshTokenProvider?: () => Promise<string | undefined>;
	private readonly _fetch: typeof fetch;
	private readonly _idleTimeoutMs: number;
	private readonly _postTimeoutMs: number;
	private readonly _catalogProvider?: () => ToolDefinition[];
	private readonly _ideVersion?: string;
	private readonly _logger?: ReasonerLogger;

	/** catalog_version cache, keyed by chat_session_id. */
	private readonly _catalogVersions = new Map<string, string>();

	constructor(opts: ReasonerClientOptions) {
		this._baseUrl = opts.baseUrl.replace(/\/+$/, '');
		this._authToken = opts.authToken;
		this._authTokenProvider = opts.authTokenProvider;
		this._refreshTokenProvider = opts.refreshTokenProvider;
		this._fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
		this._idleTimeoutMs = opts.requestTimeoutMs ?? 600_000;
		this._postTimeoutMs = opts.postTimeoutMs ?? 30_000;
		this._catalogProvider = opts.catalogProvider;
		this._ideVersion = opts.ideVersion;
		this._logger = opts.logger;
	}

	get baseUrl(): string {
		return this._baseUrl;
	}

	// ── Tool catalog ──────────────────────────────────────────────────────────

	/**
	 * POST /api/v1/tools/register — long-lived out-of-band tool catalog upload.
	 * The returned `catalog_version` is what every invoke must echo back as
	 * `expected_catalog_version`. Throws ReasonerHttpError on non-2xx.
	 *
	 * Also refreshes this client's per-session catalog cache: a surface that
	 * registers a CHANGED catalog directly and then calls the batteries-included
	 * `invoke()` would otherwise ride the stale cached version into a
	 * deterministic 412 round-trip before self-healing.
	 */
	async registerTools(req: RegisterToolsRequest): Promise<RegisterToolsResponse> {
		const resp = await this._post('/api/v1/tools/register', req);
		if (!resp.ok) {
			throw new ReasonerHttpError(resp.status, await parseJsonSafe(resp));
		}
		const parsed = (await resp.json()) as RegisterToolsResponse;
		this._catalogVersions.set(req.chat_session_id, parsed.catalog_version);
		return parsed;
	}

	/**
	 * GET /api/v1/skill-tree — the dynamic skill tree (`{version, total_skills,
	 * children}`) for the side-panel view. Throws ReasonerHttpError on non-2xx.
	 */
	async getSkillTree(): Promise<SkillTreeData> {
		const resp = await this._get('/api/v1/skill-tree');
		if (!resp.ok) {
			throw new ReasonerHttpError(resp.status, await parseJsonSafe(resp));
		}
		return (await resp.json()) as SkillTreeData;
	}

	/** Drop the cached catalog version (force a re-register on next invoke). */
	invalidateCatalog(chatSessionId?: string): void {
		if (chatSessionId) {
			this._catalogVersions.delete(chatSessionId);
		} else {
			this._catalogVersions.clear();
		}
	}

	/** Register (if not cached) and return the catalog_version for a chat session. */
	async ensureCatalog(chatSessionId: string, workspacePath?: string): Promise<string> {
		const cached = this._catalogVersions.get(chatSessionId);
		if (cached) {
			return cached;
		}
		const provided = this._catalogProvider?.() ?? [];
		const tools = provided.length > 0 ? provided : [NOOP_TOOL];
		const resp = await this.registerTools({
			chat_session_id: chatSessionId,
			tools,
			ide_version: this._ideVersion,
			workspace_path: workspacePath,
		});
		this._catalogVersions.set(chatSessionId, resp.catalog_version);
		this._logger?.info?.(
			'[ReasonerClient] tools registered: %d, catalog_version=%s',
			tools.length,
			resp.catalog_version,
		);
		return resp.catalog_version;
	}

	// ── Invoke (SSE) ──────────────────────────────────────────────────────────

	/**
	 * POST /api/v1/invoke — run one user turn and stream `InvokeEvent`s to
	 * `onEvent`. Resolves when the turn's SSE stream closes; rejects on
	 * caller-abort (AbortError), or ReasonerHttpError on a non-2xx status.
	 *
	 * Owns the catalog handshake: fills `expected_catalog_version` from the cache
	 * (registering on first use), and on a 412 mismatch re-registers fresh and
	 * retries once. A second 412 is a deterministic divergence and surfaces.
	 *
	 * Aborting `signal` only tears down the local connection. For SERVER-side
	 * cancellation (round_end{reason:'cancelled'} + stop billing) call
	 * `cancel(traceId)` too.
	 */
	async invoke(
		req: InvokeRequestInput,
		onEvent: (event: InvokeEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		let version = await this.ensureCatalog(req.chat_session_id, req.workspace_path);
		let retried412 = false;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const full: InvokeRequest = { ...req, expected_catalog_version: version };
			try {
				await this._sseStream(`${this._baseUrl}/api/v1/invoke`, full, onEvent, signal);
				return;
			} catch (err) {
				if (err instanceof SseHttpError && err.status === 412 && !retried412) {
					retried412 = true;
					this._logger?.warn?.(
						'[ReasonerClient] /invoke 412 catalog mismatch — re-registering + retrying once',
					);
					this.invalidateCatalog(req.chat_session_id);
					version = await this.ensureCatalog(req.chat_session_id, req.workspace_path);
					continue;
				}
				throw this._wrap(err);
			}
		}
	}

	/**
	 * POST /api/v1/invoke — the raw single-shot stream, WITHOUT the catalog
	 * handshake: `req` must already carry `expected_catalog_version`, and a 412
	 * mismatch surfaces to the caller instead of being retried here. For a
	 * surface that owns its own catalog lifecycle (the chipos IDE registers
	 * tools itself and handles 412 in its agent layer — M3b), this is the
	 * entry point; `invoke()` above is the batteries-included variant.
	 * Errors are wrapped the same way as `invoke()`/`resume()`.
	 */
	async invokeRaw(
		req: InvokeRequest,
		onEvent: (event: InvokeEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		try {
			await this._sseStream(`${this._baseUrl}/api/v1/invoke`, req, onEvent, signal);
		} catch (err) {
			throw this._wrap(err);
		}
	}

	/**
	 * POST /api/v1/compact — summarize an OLD slice of a long conversation into
	 * one `summary_message` (sync JSON, NOT SSE). The caller replaces the old
	 * slice with `[summary_message, ...recent_turns]`. `_post` already does the
	 * auth header + a single 401→refresh retry. Throws ReasonerHttpError on
	 * non-2xx (503 when CHIPOS_STATELESS is off).
	 */
	async compact(req: CompactRequest): Promise<CompactResponse> {
		const resp = await this._post('/api/v1/compact', req);
		if (!resp.ok) {
			throw new ReasonerHttpError(resp.status, await parseJsonSafe(resp));
		}
		return (await resp.json()) as CompactResponse;
	}

	/**
	 * POST /api/v1/resume/{chat_session_id} — reconnect a dropped SSE and continue
	 * the in-flight turn from `req.last_sequence_id`. Throws
	 * ReasonerResumeNotFoundError (404), ReasonerReplayExpiredError (410), or
	 * ReasonerHttpError on other non-2xx.
	 */
	async resume(
		chatSessionId: string,
		req: ResumeRequest,
		onEvent: (event: InvokeEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const url = `${this._baseUrl}/api/v1/resume/${encodeURIComponent(chatSessionId)}`;
		const overrides: SseStatusOverride[] = [
			{ onStatus: 404, toError: () => new ReasonerResumeNotFoundError(req.trace_id) },
			{ onStatus: 410, toError: () => new ReasonerReplayExpiredError(req.trace_id) },
		];
		try {
			await this._sseStream(url, req, onEvent, signal, overrides);
		} catch (err) {
			throw this._wrap(err);
		}
	}

	// ── Cancellation ──────────────────────────────────────────────────────────

	/**
	 * POST /api/v1/invoke/{trace_id}/cancel — server-side abort. Returns the JSON
	 * envelope for 202 / 404 / 503 (caller decides); throws ReasonerHttpError on
	 * other non-2xx. 404 is a benign race (turn already ended).
	 */
	async cancel(traceId: string, reason?: string): Promise<CancelResponse> {
		const body: CancelRequest = { trace_id: traceId, ...(reason !== undefined ? { reason } : {}) };
		const resp = await this._post(`/api/v1/invoke/${encodeURIComponent(traceId)}/cancel`, body);
		if (resp.status === 202 || resp.status === 404 || resp.status === 503 || resp.status === 200) {
			return (await parseJsonSafe(resp)) as CancelResponse;
		}
		throw new ReasonerHttpError(resp.status, await parseJsonSafe(resp));
	}

	// ── Reverse-channel callbacks ─────────────────────────────────────────────

	/**
	 * POST /api/v1/tool_result/{trace_id}/{call_id} — reply to an ide_tool_call.
	 * 202/200 → {accepted:true}; 404 → {error} (benign: callback timed out / dup);
	 * else throws ReasonerHttpError.
	 */
	async postToolResult(
		traceId: string,
		callId: string,
		req: ToolResultRequest,
	): Promise<{ accepted: boolean } | { error: string; [k: string]: unknown }> {
		const url = `/api/v1/tool_result/${encodeURIComponent(traceId)}/${encodeURIComponent(callId)}`;
		return this._postAck(url, req, 'call_not_found');
	}

	/**
	 * POST /api/v1/confirm_response/{trace_id}/{request_id} — reply to a
	 * confirm_request. Status semantics mirror postToolResult.
	 */
	async postConfirmResponse(
		traceId: string,
		requestId: string,
		req: ConfirmResponseRequest,
	): Promise<{ accepted: boolean } | { error: string; [k: string]: unknown }> {
		const url = `/api/v1/confirm_response/${encodeURIComponent(traceId)}/${encodeURIComponent(requestId)}`;
		return this._postAck(url, req, 'request_not_found');
	}

	/**
	 * POST /api/v1/hook_result/{trace_id}/{eval_id} — reply to a `hook_eval`
	 * reverse event with the surface's `{decision}` verdict (FEAT-004 function
	 * hooks). Status semantics mirror postToolResult/postConfirmResponse
	 * (202/200 → accepted; 404 → benign {error}; else throws) — the reasoner
	 * uses the same future-resolution machinery, keyed on `eval_id`.
	 */
	async postHookResult(
		traceId: string,
		evalId: string,
		req: HookResultRequest,
	): Promise<{ accepted: boolean } | { error: string; [k: string]: unknown }> {
		const url = `/api/v1/hook_result/${encodeURIComponent(traceId)}/${encodeURIComponent(evalId)}`;
		return this._postAck(url, req, 'eval_not_found');
	}

	/**
	 * GET /api/v1/turn_state/{chat_session_id} — in-flight turn probe (startup /
	 * resume). 404 is normalised to an empty result.
	 */
	async getTurnState(chatSessionId: string): Promise<TurnStateResponse> {
		const url = `${this._baseUrl}/api/v1/turn_state/${encodeURIComponent(chatSessionId)}`;
		const { signal, clear } = this._timeout();
		const get = async (): Promise<Response> =>
			this._fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...(await this._authHeaders()) }, signal });
		try {
			let resp = await get();
			if (resp.status === 401 && await this._refreshOn401()) {
				await drainBody(resp);
				resp = await get();
			}
			if (resp.status === 404) {
				await drainBody(resp);
				return { chat_session_id: chatSessionId, in_flight_traces: [] };
			}
			if (!resp.ok) {
				throw new ReasonerHttpError(resp.status, await parseJsonSafe(resp));
			}
			return (await resp.json()) as TurnStateResponse;
		} finally {
			clear();
		}
	}

	/**
	 * GET /api/v1/health (or /health) — best-effort reachability probe used to
	 * drive a connection indicator. A network error → reachable:false; any HTTP
	 * response → reachable:true (the server is up). 401/403 → authFailed:true.
	 */
	async checkHealth(): Promise<ReasonerHealth> {
		const headers: Record<string, string> = { Accept: 'application/json', ...(await this._authHeaders()) };
		const { signal, clear } = this._timeout(5_000);
		try {
			let resp: Response;
			try {
				resp = await this._fetch(`${this._baseUrl}/health`, { method: 'GET', headers, signal });
			} catch {
				return { reachable: false };
			}
			return {
				reachable: true,
				status: resp.status,
				authFailed: resp.status === 401 || resp.status === 403,
			};
		} finally {
			clear();
		}
	}

	// ── Internals ─────────────────────────────────────────────────────────────

	private async _authHeaders(): Promise<Record<string, string>> {
		const token = this._authTokenProvider ? await this._authTokenProvider() : this._authToken;
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	/**
	 * After a 401, force a token refresh (bypassing the near-expiry cache) so the
	 * caller can retry ONCE with a fresh bearer. Returns true only when a usable
	 * new token was obtained; false (no refresh provider, or refresh failed/
	 * cleared the session) means the 401 should surface so the user re-logs-in.
	 * Subsequent requests pick up the refreshed token via `authTokenProvider`
	 * (chiposTokenManager caches the refresh result), so no token is threaded here.
	 */
	private async _refreshOn401(): Promise<boolean> {
		if (!this._refreshTokenProvider) {
			return false;
		}
		try {
			const token = await this._refreshTokenProvider();
			if (token) {
				this._logger?.info?.('[ReasonerClient] 401 → forced token refresh succeeded, retrying once');
				return true;
			}
			this._logger?.warn?.('[ReasonerClient] 401 → forced token refresh returned no token — surfacing 401');
			return false;
		} catch (err) {
			this._logger?.warn?.('[ReasonerClient] 401 → forced token refresh threw: %s', String(err));
			return false;
		}
	}

	/** POST + SSE response → onEvent per parsed InvokeEvent. */
	private async _sseStream(
		url: string,
		body: unknown,
		onEvent: (event: InvokeEvent) => void,
		signal: AbortSignal | undefined,
		statusOverrides?: SseStatusOverride[],
		retriedAuth = false,
	): Promise<void> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(await this._authHeaders()),
		};
		const init: FetchEventStreamInit = {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
			fetchFn: this._fetch,
			idleTimeoutMs: this._idleTimeoutMs,
			// Reconnect intentionally OFF for invoke/resume: re-POSTing /invoke
			// would start a new turn; SSE drops are recovered via /resume.
		};
		try {
			await fetchEventStream(url, init, data => onEvent(data as InvokeEvent), statusOverrides);
		} catch (err) {
			// A 401 is raised at the HTTP status stage — BEFORE the turn starts and
			// before any event is emitted — so re-POSTing after a forced refresh is
			// safe (it does not duplicate a turn; a mid-stream drop is a network
			// error, not a 401, and is recovered via /resume). Retry exactly once.
			if (!retriedAuth && err instanceof SseHttpError && err.status === 401 && await this._refreshOn401()) {
				return this._sseStream(url, body, onEvent, signal, statusOverrides, true);
			}
			throw err;
		}
	}

	/**
	 * Shared POST helper for the short non-SSE calls (with auth + timeout). On a
	 * 401 it force-refreshes the token and re-issues once — covers registerTools,
	 * cancel, and the dual-token long-turn callbacks (postToolResult /
	 * postConfirmResponse) that fire minutes after invoke-start, past the JWT TTL.
	 */
	private async _post(path: string, body: unknown): Promise<Response> {
		let resp = await this._postOnce(path, body);
		if (resp.status === 401 && await this._refreshOn401()) {
			await drainBody(resp);
			resp = await this._postOnce(path, body);
		}
		return resp;
	}

	/** One POST attempt (fresh auth header + timeout). */
	private async _postOnce(path: string, body: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(await this._authHeaders()),
		};
		const { signal, clear } = this._timeout();
		try {
			return await this._fetch(`${this._baseUrl}${path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal,
			});
		} finally {
			clear();
		}
	}

	/** Shared GET helper (auth + timeout) with a single 401 → force-refresh retry. */
	private async _get(path: string): Promise<Response> {
		let resp = await this._getOnce(path);
		if (resp.status === 401 && await this._refreshOn401()) {
			await drainBody(resp);
			resp = await this._getOnce(path);
		}
		return resp;
	}

	/** One GET attempt (fresh auth header + timeout). */
	private async _getOnce(path: string): Promise<Response> {
		const headers: Record<string, string> = { ...(await this._authHeaders()) };
		const { signal, clear } = this._timeout();
		try {
			return await this._fetch(`${this._baseUrl}${path}`, { method: 'GET', headers, signal });
		} finally {
			clear();
		}
	}

	/** POST that normalises the 202/200 → accepted, 404 → {error}, else throw pattern. */
	private async _postAck(
		path: string,
		body: unknown,
		notFoundError: string,
	): Promise<{ accepted: boolean } | { error: string; [k: string]: unknown }> {
		const resp = await this._post(path, body);
		if (resp.status === 202 || resp.status === 200) {
			await drainBody(resp);
			return { accepted: true };
		}
		if (resp.status === 404) {
			const parsed = await parseJsonSafe(resp);
			if (parsed && typeof parsed === 'object' && 'error' in parsed) {
				return parsed as { error: string; [k: string]: unknown };
			}
			return { error: notFoundError };
		}
		throw new ReasonerHttpError(resp.status, await parseJsonSafe(resp));
	}

	/** AbortSignal + clear() for the short non-SSE calls. */
	private _timeout(ms?: number): { signal: AbortSignal; clear: () => void } {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			try {
				controller.abort(new Error('reasoner request timed out'));
			} catch {
				/* best-effort */
			}
		}, ms ?? this._postTimeoutMs);
		return { signal: controller.signal, clear: () => clearTimeout(timer) };
	}

	/** Convert a transport SseHttpError into a ReasonerHttpError; pass others through. */
	private _wrap(err: unknown): unknown {
		if (err instanceof SseHttpError) {
			return new ReasonerHttpError(err.status, err.body);
		}
		return err;
	}
}

async function parseJsonSafe(resp: Response): Promise<unknown> {
	try {
		return await resp.json();
	} catch {
		try {
			return await resp.text();
		} catch {
			return undefined;
		}
	}
}

async function drainBody(resp: Response): Promise<void> {
	try {
		await resp.text();
	} catch {
		/* best-effort */
	}
}
