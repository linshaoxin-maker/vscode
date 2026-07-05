/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/auth/authWire.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Canonical non-org auth wire — pure HTTP for the chiops auth endpoints that were
 * hand-copied across the three surfaces (doc-20 · A6). NO editor / fs / DI deps.
 *
 * Collapses these triplicated calls:
 *   - token/exchange  (login code → tokens): CLI loginFlow.exchangeToken +
 *     IDE/ext authService.handleCallback (inline)
 *   - worker-token    (mint scope=worker JWT): CLI workerToken.mintWorkerToken +
 *     IDE/ext authService.getWorkerToken (inline)
 *   - logout          (revoke refresh_token): CLI loginCommands + IDE/ext authService (inline)
 *
 * NOT here (already single-source): refresh + /me live in AuthTokenManagerCore
 * (they carry session orchestration — store/schedule/active-org re-apply /
 * 401-retry — not just a fetch). switch-org / my-orgs / members / invites live in
 * orgSwitchClient.
 *
 * Injectable `fetchFn` (tests) + `timeoutMs` (default 15s — an auth call must not
 * hang). Trailing slashes on the base URL are trimmed.
 */

/** Wire mirror of chiops `UserResponse` (backend/app/auth/schemas.py). SSOT for the surfaces' user shape. */
export interface AuthUserResponse {
	id?: string;
	email?: string;
	role?: string;
	org_id?: string;
	display_name?: string;
	status?: string;
	created_at?: string;
}

/** The token/exchange + refresh response shape. */
export interface TokenBundle {
	access_token: string;
	refresh_token?: string;
	user?: AuthUserResponse;
}

/** One worker-token attempt. `status` is surfaced so a caller can 401→refresh→retry (the CLI self-heal). */
export interface WorkerTokenAttempt {
	ok: boolean;
	status: number;
	worker_token?: string;
	expires_in?: number;
}

export interface AuthWireOptions {
	fetchFn?: typeof fetch;
	/** Per-request timeout in ms. Default 15_000 — an auth call must not hang. */
	timeoutMs?: number;
}

function base(websiteUrl: string): string {
	return websiteUrl.replace(/\/+$/, '');
}

function signal(opts?: AuthWireOptions): AbortSignal {
	return AbortSignal.timeout(opts?.timeoutMs ?? 15_000);
}

/**
 * POST /api/auth/token/exchange {code, challenge} → the token bundle, or
 * `undefined` on any failure (non-2xx / malformed / no access_token). The caller
 * decides how to surface it (CLI throws a LoginError; IDE/ext log + stay logged out).
 */
export async function exchangeCode(
	websiteUrl: string,
	code: string,
	challenge: string | undefined,
	opts?: AuthWireOptions,
): Promise<TokenBundle | undefined> {
	const fetchFn = opts?.fetchFn ?? fetch;
	try {
		const resp = await fetchFn(`${base(websiteUrl)}/api/auth/token/exchange`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ code, challenge }),
			signal: signal(opts),
		});
		if (!resp.ok) {
			return undefined;
		}
		const data = (await resp.json().catch(() => ({}))) as Partial<TokenBundle>;
		if (!data || typeof data.access_token !== 'string' || !data.access_token) {
			return undefined;
		}
		return {
			access_token: data.access_token,
			refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
			user: data.user,
		};
	} catch {
		return undefined; // network / timeout — a typed failure; caller decides how to surface
	}
}

/**
 * POST /api/auth/worker-token (Bearer accessToken) {worker_id?} → an attempt
 * carrying `ok`/`status`/`worker_token`. The endpoint REQUIRES a JSON body (a
 * bodyless POST is 422 "Field required") — send `{}` or `{worker_id}`. `status`
 * lets a caller distinguish a 401 (expired access_token → refreshable) from other
 * failures. Never throws — a network error resolves to `{ ok:false, status:0 }`.
 */
export async function requestWorkerToken(
	websiteUrl: string,
	accessToken: string,
	opts?: AuthWireOptions & { workerId?: string },
): Promise<WorkerTokenAttempt> {
	if (!accessToken) {
		return { ok: false, status: 0 };
	}
	const fetchFn = opts?.fetchFn ?? fetch;
	try {
		const resp = await fetchFn(`${base(websiteUrl)}/api/auth/worker-token`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(opts?.workerId ? { worker_id: opts.workerId } : {}),
			signal: signal(opts),
		});
		if (!resp.ok) {
			return { ok: false, status: resp.status };
		}
		const data = (await resp.json().catch(() => ({}))) as Partial<WorkerTokenAttempt>;
		return {
			ok: true,
			status: resp.status,
			worker_token: typeof data?.worker_token === 'string' && data.worker_token ? data.worker_token : undefined,
			expires_in: typeof data?.expires_in === 'number' ? data.expires_in : undefined,
		};
	} catch {
		return { ok: false, status: 0 };
	}
}

/**
 * POST /api/auth/logout (Bearer accessToken) {refresh_token} — ask chiops to
 * revoke the refresh_token. Best-effort: returns `true` iff the POST was made and
 * 2xx; any failure (offline / 4xx / timeout / missing creds) resolves to `false`
 * WITHOUT throwing, so a caller's local logout is never blocked. chiops requires a
 * live Bearer access_token to authenticate the caller (prevents third-party RT abuse).
 */
export async function postLogout(
	websiteUrl: string,
	accessToken: string,
	refreshToken: string,
	opts?: AuthWireOptions,
): Promise<boolean> {
	if (!accessToken || !refreshToken) {
		return false;
	}
	const fetchFn = opts?.fetchFn ?? fetch;
	try {
		const resp = await fetchFn(`${base(websiteUrl)}/api/auth/logout`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
			body: JSON.stringify({ refresh_token: refreshToken }),
			signal: signal(opts),
		});
		return resp.ok;
	} catch {
		return false;
	}
}
