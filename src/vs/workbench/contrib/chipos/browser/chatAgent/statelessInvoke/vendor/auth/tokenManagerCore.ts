/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/auth/tokenManagerCore.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Canonical auth token-lifecycle core (doc-20 · A2).
 *
 * A pure in-memory state machine shared by the three surfaces:
 *   - SecretStore/SecretStorage persistence via the {@link TokenStore} port
 *   - near-expiry proactive refresh + a scheduled auto-refresh timer
 *   - concurrent-refresh dedup (one in-flight `/refresh` at a time)
 *   - JWT-claims decode (active org / role / scopes) — base64url-correct, works
 *     in both the IDE browser context (atob) and Node (ext host / CLI)
 *   - cross-window/-process adoption via {@link syncFromStore} (the surface wires
 *     its store's change event to it)
 *
 * Behaviour is a faithful port of the IDE `ChipOSTokenManager` (the richest of the
 * three copies). It reaches the world ONLY through the injected ports, so a
 * surface binds SecretStorage (IDE/ext) or a file (CLI). Surfaces whose consumers
 * need a native `Event<T>` bridge the {@link SimpleEmitter} events to their own.
 *
 * NOT here (deferred, per doc-20): active-org-across-refresh convergence (§3.3 /
 * A5) — a plain `/refresh` re-mints under the personal org, matching today's
 * IDE/ext behaviour. Login OAuth + worker-token live in the surface authService.
 */

import { SimpleEmitter, type Disposable, type Logger, type TokenStore } from './ports.js';

// ── Storage keys (shared with every surface adapter) ──
export const KEY_ACCESS_TOKEN = 'chipos.auth.accessToken';
export const KEY_REFRESH_TOKEN = 'chipos.auth.refreshToken';
export const KEY_USER_INFO = 'chipos.auth.userInfo';

// ── Refresh config ──
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/** Internal identity model (mapAuthUser renames the wire `id` → `user_id`). */
export interface AuthUserInfo {
	user_id: string;
	email: string;
	role: string;
	org_id?: string;
	display_name?: string;
	status?: string;
	created_at?: string;
}

/** Wire mirror of chiops `UserResponse` (backend/app/auth/schemas.py). */
export type AuthUserResponse = {
	id?: string;
	email?: string;
	role?: string;
	org_id?: string;
	display_name?: string;
	status?: string;
	created_at?: string;
};

/**
 * Authz claims decoded from the active access_token's JWT payload. `role` is the
 * GLOBAL user role claim (user/admin) — NOT the per-org role; the per-org role
 * comes from `/my-orgs` + `/switch-org`. `scopes` are what the active org's role
 * grants (chiops signs them into the token — see 07-AUTH-SCOPES-DECISION §6).
 */
export interface AuthTokenClaims {
	org_id?: string;
	role?: string;
	scopes?: string[];
}

/** Everything the core needs from its host surface. */
export interface TokenManagerDeps {
	/** Secret persistence backend (SecretStorage / file). */
	readonly store: TokenStore;
	/** Resolve the chiops/website base URL (settings / product.json / env / cfg). */
	resolveWebsiteUrl(): string | undefined;
	/** Structural logger (optional). */
	readonly logger?: Logger;
	/** Injected for tests; defaults to global fetch. */
	readonly fetchFn?: typeof fetch;
	/**
	 * One-shot legacy-token import (IDE/ext read `chipos.backend.token`). Read only
	 * when SecretStorage is empty on first run; once persisted we never read it
	 * again. Absent ⇒ no legacy fallback (e.g. CLI).
	 */
	readLegacyToken?(): string | undefined;
	/** Override the 5-min pre-expiry refresh margin (tests). */
	readonly refreshMarginMs?: number;
}

/** base64url-correct JWT payload decode — works in browser (atob) and Node. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		while (b64.length % 4 !== 0) {
			b64 += '=';
		}
		// atob exists in the IDE browser context AND Node 16+; Buffer is the Node
		// fallback. JWT claims we read (org_id/role/scopes/exp) are ASCII.
		const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export class AuthTokenManagerCore implements Disposable {
	private _accessToken: string | undefined;
	private _refreshToken: string | undefined;
	private _user: AuthUserInfo | undefined;
	private _usingManualTokenFallback = false;
	private _tokenExpiry = 0; // epoch ms
	private _refreshPromise: Promise<string | undefined> | undefined;
	private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _store: TokenStore;
	private readonly _logger?: Logger;
	private readonly _fetchFn: typeof fetch;
	private readonly _refreshMarginMs: number;

	private readonly _onDidChangeToken = new SimpleEmitter<string | undefined>();
	readonly onDidChangeToken = this._onDidChangeToken.event;

	private readonly _onDidChangeUser = new SimpleEmitter<AuthUserInfo | undefined>();
	readonly onDidChangeUser = this._onDidChangeUser.event;

	constructor(private readonly _deps: TokenManagerDeps) {
		this._store = _deps.store;
		this._logger = _deps.logger;
		this._fetchFn = _deps.fetchFn ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init));
		this._refreshMarginMs = _deps.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
	}

	// ── Lifecycle ──

	async initialize(): Promise<void> {
		this._usingManualTokenFallback = false;

		const stored = await this._store.get(KEY_ACCESS_TOKEN);
		if (stored) {
			this._accessToken = stored;
			this._refreshToken = (await this._store.get(KEY_REFRESH_TOKEN)) ?? undefined;
			const userJson = await this._store.get(KEY_USER_INFO);
			if (userJson) {
				try {
					this._user = JSON.parse(userJson) as AuthUserInfo;
				} catch {
					this._user = undefined;
				}
			}
			this._parseTokenExpiry(stored);
			this._scheduleAutoRefresh();
			await this.restoreUserFromServer();
			this._logger?.info?.('[ChipOS Auth] Restored tokens from store, user:', this._user?.email ?? 'unknown');
			return;
		}

		// Legacy one-shot import (IDE/ext `chipos.backend.token`).
		const legacyToken = this._deps.readLegacyToken?.();
		if (legacyToken) {
			this._accessToken = legacyToken;
			this._usingManualTokenFallback = true;
			this._parseTokenExpiry(legacyToken);
			this._logger?.info?.('[ChipOS Auth] Using legacy token as fallback');
		}
	}

	/**
	 * Adopt an access-token change made by another window/process (cross-window
	 * sync). The surface wires its store's change event to this. No-op when
	 * already in sync — including when WE are the writer (writers set the in-memory
	 * token BEFORE writing storage, so `stored === this._accessToken`). Best-effort:
	 * never throws; a refresh in flight here is left to finish.
	 */
	async syncFromStore(): Promise<void> {
		if (this._refreshPromise) {
			return; // a refresh in this window will set the token itself — don't race it
		}
		try {
			const stored = (await this._store.get(KEY_ACCESS_TOKEN)) || undefined;
			if (stored === this._accessToken) {
				return; // already in sync (incl. the writer reacting to its own write)
			}
			if (stored) {
				this._accessToken = stored;
				this._refreshToken = (await this._store.get(KEY_REFRESH_TOKEN)) ?? undefined;
				this._usingManualTokenFallback = false;
				const userJson = await this._store.get(KEY_USER_INFO);
				this._user = userJson ? (this._safeParseUser(userJson)) : undefined;
				this._parseTokenExpiry(stored);
				this._scheduleAutoRefresh();
				this._onDidChangeToken.fire(stored);
				this._onDidChangeUser.fire(this._user);
				this._logger?.info?.('[ChipOS Auth] Adopted token from another window (cross-window sync), user:', this._user?.email ?? 'unknown');
			} else {
				this._accessToken = undefined;
				this._refreshToken = undefined;
				this._user = undefined;
				this._usingManualTokenFallback = false;
				this._tokenExpiry = 0;
				this._clearRefreshTimer();
				this._onDidChangeToken.fire(undefined);
				this._onDidChangeUser.fire(undefined);
				this._logger?.info?.('[ChipOS Auth] Cleared token after logout in another window (cross-window sync)');
			}
		} catch (err) {
			this._logger?.warn?.('[ChipOS Auth] cross-window token sync failed (state unchanged):', String(err));
		}
	}

	// ── Public API ──

	async getAccessToken(): Promise<string | undefined> {
		if (this._accessToken && this._tokenExpiry > 0) {
			if (Date.now() >= this._tokenExpiry - this._refreshMarginMs) {
				const refreshed = await this.refreshAccessToken();
				if (refreshed) {
					return refreshed;
				}
			}
		}
		return this._accessToken;
	}

	async refreshAccessToken(): Promise<string | undefined> {
		if (this._refreshPromise) {
			return this._refreshPromise; // concurrent dedup
		}
		if (!this._refreshToken) {
			this._logger?.warn?.('[ChipOS Auth] No refresh_token available, cannot refresh');
			return undefined;
		}
		this._refreshPromise = this._doRefresh();
		try {
			return await this._refreshPromise;
		} finally {
			this._refreshPromise = undefined;
		}
	}

	async getRefreshTokenForLogout(): Promise<string | undefined> {
		return this._refreshToken;
	}

	/**
	 * The in-memory access_token WITHOUT triggering a refresh — for the logout flow
	 * only (chiops `/auth/logout` wants a Bearer, but minting a fresh AT+RT just to
	 * log out wastes RTs and races the revoke). Returns undefined when missing or
	 * within the refresh margin of expiry (chiops would 401 it anyway).
	 */
	getAccessTokenForLogout(): string | undefined {
		if (!this._accessToken) {
			return undefined;
		}
		if (this._tokenExpiry > 0 && Date.now() >= this._tokenExpiry - this._refreshMarginMs) {
			return undefined;
		}
		return this._accessToken;
	}

	async storeTokens(accessToken: string, refreshToken: string, user?: AuthUserInfo): Promise<void> {
		this._accessToken = accessToken;
		this._refreshToken = refreshToken;
		this._user = user;
		this._usingManualTokenFallback = false;
		this._parseTokenExpiry(accessToken);

		await this._store.set(KEY_ACCESS_TOKEN, accessToken);
		await this._store.set(KEY_REFRESH_TOKEN, refreshToken);
		if (user) {
			await this._store.set(KEY_USER_INFO, JSON.stringify(user));
		} else {
			await this._store.delete(KEY_USER_INFO);
		}

		this._scheduleAutoRefresh();
		this._onDidChangeToken.fire(accessToken);
		this._onDidChangeUser.fire(user);
		this._logger?.info?.('[ChipOS Auth] Tokens stored, user:', user?.email ?? 'unknown');
	}

	/**
	 * Active-org switch: replace ONLY the access_token (refresh_token + user are
	 * unchanged), persist, re-schedule auto-refresh, fire onDidChangeToken so the
	 * reasoner transport picks up the org-scoped token next request.
	 */
	async updateAccessToken(accessToken: string): Promise<void> {
		this._accessToken = accessToken;
		this._usingManualTokenFallback = false;
		this._parseTokenExpiry(accessToken);
		await this._store.set(KEY_ACCESS_TOKEN, accessToken);
		this._scheduleAutoRefresh();
		this._onDidChangeToken.fire(accessToken);
		this._logger?.info?.('[ChipOS Auth] access_token replaced (active-org switch)');
	}

	async clearTokens(): Promise<void> {
		this._accessToken = undefined;
		this._refreshToken = undefined;
		this._user = undefined;
		this._usingManualTokenFallback = false;
		this._tokenExpiry = 0;
		this._clearRefreshTimer();

		await this._store.delete(KEY_ACCESS_TOKEN);
		await this._store.delete(KEY_REFRESH_TOKEN);
		await this._store.delete(KEY_USER_INFO);

		this._onDidChangeToken.fire(undefined);
		this._onDidChangeUser.fire(undefined);
		this._logger?.info?.('[ChipOS Auth] Tokens cleared (logout)');
	}

	getUser(): AuthUserInfo | undefined {
		return this._user;
	}

	/** Decode the in-memory access_token's JWT payload into authz claims. Sync + side-effect free. */
	getTokenClaims(): AuthTokenClaims | undefined {
		if (!this._accessToken) {
			return undefined;
		}
		const payload = decodeJwtPayload(this._accessToken);
		if (!payload) {
			return undefined;
		}
		const orgId = typeof payload.org_id === 'string' ? payload.org_id : undefined;
		const role = typeof payload.role === 'string' ? payload.role : undefined;
		const scopes = Array.isArray(payload.scopes)
			? payload.scopes.filter((s): s is string => typeof s === 'string')
			: undefined;
		return { org_id: orgId, role, scopes };
	}

	isLoggedIn(): boolean {
		return !!this._accessToken;
	}

	isUsingManualTokenFallback(): boolean {
		return this._usingManualTokenFallback;
	}

	resolveWebsiteUrl(): string | undefined {
		return this._deps.resolveWebsiteUrl();
	}

	mapAuthUser(user: AuthUserResponse | undefined): AuthUserInfo | undefined {
		if (!user) {
			return undefined;
		}
		const userId = user.id?.trim();
		const email = user.email?.trim();
		if (!userId || !email) {
			return undefined;
		}
		return {
			user_id: userId,
			email,
			role: user.role?.trim() || 'user',
			org_id: user.org_id?.trim() || undefined,
			display_name: user.display_name?.trim() || undefined,
			status: user.status?.trim() || undefined,
			created_at: user.created_at?.trim() || undefined,
		};
	}

	async restoreUserFromServer(): Promise<void> {
		const websiteUrl = this.resolveWebsiteUrl();
		if (!websiteUrl || !this._accessToken || this._usingManualTokenFallback) {
			return;
		}
		const fetchProfile = (token: string): Promise<Response> =>
			this._fetchFn(`${websiteUrl}/api/auth/me`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });

		try {
			let resp = await fetchProfile(this._accessToken);
			if (resp.status === 401) {
				const refreshed = await this.refreshAccessToken();
				if (!refreshed) {
					return;
				}
				resp = await fetchProfile(refreshed);
			}
			if (resp.status === 401 || resp.status === 403) {
				this._logger?.warn?.('[ChipOS Auth] /api/auth/me rejected restored token (%s), clearing local auth', String(resp.status));
				await this.clearTokens();
				return;
			}
			if (!resp.ok) {
				this._logger?.warn?.('[ChipOS Auth] /api/auth/me non-OK (%s), keeping cached user', String(resp.status));
				return;
			}
			const data = (await resp.json()) as AuthUserResponse | { user?: AuthUserResponse } | null;
			let rawUser: AuthUserResponse | undefined;
			if (data && typeof data === 'object' && 'user' in data) {
				rawUser = data.user;
			} else if (data) {
				rawUser = data as AuthUserResponse;
			}
			const mappedUser = this.mapAuthUser(rawUser);
			if (!mappedUser) {
				this._logger?.warn?.('[ChipOS Auth] /api/auth/me returned no usable user profile');
				return;
			}
			this._user = mappedUser;
			await this._store.set(KEY_USER_INFO, JSON.stringify(mappedUser));
			this._onDidChangeUser.fire(mappedUser);
		} catch (err) {
			this._logger?.warn?.('[ChipOS Auth] Failed to restore user from /api/auth/me:', String(err));
		}
	}

	// ── Internal ──

	private _safeParseUser(userJson: string): AuthUserInfo | undefined {
		try {
			return JSON.parse(userJson) as AuthUserInfo;
		} catch {
			return undefined;
		}
	}

	private async _doRefresh(): Promise<string | undefined> {
		const websiteUrl = this.resolveWebsiteUrl();
		if (!websiteUrl) {
			this._logger?.warn?.('[ChipOS Auth] website URL required for token refresh');
			return undefined;
		}
		try {
			this._logger?.info?.('[ChipOS Auth] Refreshing access_token...');
			const resp = await this._fetchFn(`${websiteUrl}/api/auth/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: this._refreshToken }),
			});
			if (!resp.ok) {
				this._logger?.warn?.('[ChipOS Auth] Refresh failed:', String(resp.status));
				if (resp.status === 401) {
					await this.clearTokens(); // refresh_token invalid/expired → force re-login
				}
				return undefined;
			}
			const data = (await resp.json()) as { access_token: string; refresh_token?: string; user?: AuthUserResponse };
			await this.storeTokens(data.access_token, data.refresh_token ?? this._refreshToken!, this.mapAuthUser(data.user) ?? this._user);
			return data.access_token;
		} catch (err) {
			this._logger?.error?.('[ChipOS Auth] Refresh error:', String(err));
			return undefined;
		}
	}

	private _parseTokenExpiry(token: string): void {
		const payload = decodeJwtPayload(token);
		const exp = payload && typeof payload.exp === 'number' ? payload.exp : undefined;
		this._tokenExpiry = exp ? exp * 1000 : 0;
	}

	private _scheduleAutoRefresh(): void {
		this._clearRefreshTimer();
		if (!this._refreshToken || this._tokenExpiry <= 0) {
			return;
		}
		const delay = Math.max(0, this._tokenExpiry - Date.now() - this._refreshMarginMs);
		this._refreshTimer = setTimeout(() => {
			this.refreshAccessToken().catch((err) => this._logger?.error?.('[ChipOS Auth] Auto-refresh failed:', String(err)));
		}, delay);
		// Don't let a pending ~55-min refresh timer keep the process alive on its own
		// (matters for the CLI, which is a short-lived / cleanly-exiting process; the
		// IDE/ext hosts are long-running so it's a no-op there). `unref` is Node-only —
		// in the IDE browser context setTimeout returns a number with no unref.
		const timer = this._refreshTimer as { unref?: () => void };
		if (typeof timer.unref === 'function') {
			timer.unref();
		}
	}

	private _clearRefreshTimer(): void {
		if (this._refreshTimer !== undefined) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = undefined;
		}
	}

	dispose(): void {
		this._clearRefreshTimer();
		this._onDidChangeToken.dispose();
		this._onDidChangeUser.dispose();
	}
}
