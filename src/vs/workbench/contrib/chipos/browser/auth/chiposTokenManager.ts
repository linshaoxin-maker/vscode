/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  Phase 1 Unified Auth: ChipOSTokenManager
 *
 *  Manages access_token + refresh_token lifecycle:
 *  - SecretStorage persistence (primary)
 *  - chipos.backend.token fallback (legacy)
 *  - Auto-refresh before expiry
 *  - Concurrent refresh dedup
 *  - Token change events
 *
 *  See: chiops/docs/unified-auth/04-phase1-coderust-ide.md (I2)
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { resolveWebsiteUrl } from '../../common/chiposEndpoints.js';

// ── Storage keys ──
const KEY_ACCESS_TOKEN = 'chipos.auth.accessToken';
const KEY_REFRESH_TOKEN = 'chipos.auth.refreshToken';
const KEY_USER_INFO = 'chipos.auth.userInfo';

// ── Refresh config ──
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export interface IChipOSUserInfo {
	user_id: string;
	email: string;
	role: string;
	org_id?: string;
	display_name?: string;
	status?: string;
	created_at?: string;
}

// Wire format mirror of backend `UserResponse` (chiops/backend/app/auth/schemas.py).
// IDE internal model is IChipOSUserInfo; mapAuthUser does the wire→internal rename (id → user_id).
export type ChipOSAuthUserResponse = {
	id?: string;
	email?: string;
	role?: string;
	org_id?: string;
	display_name?: string;
	status?: string;
	created_at?: string;
};

export interface IChipOSTokenManager {
	readonly _serviceBrand: undefined;

	readonly onDidChangeToken: Event<string | undefined>;
	readonly onDidChangeUser: Event<IChipOSUserInfo | undefined>;

	initialize(): Promise<void>;
	getAccessToken(): Promise<string | undefined>;
	refreshAccessToken(): Promise<string | undefined>;
	/**
	 * Returns the current refresh_token if any. Intended for logout flow only
	 * (so the caller can ask the website to revoke it before clearing local
	 * state). Do not use for regular auth — refresh_token must never leave
	 * the IDE process.
	 */
	getRefreshTokenForLogout(): Promise<string | undefined>;
	/**
	 * Returns the current in-memory access_token WITHOUT triggering a refresh.
	 * Required by the logout flow: chiops `/auth/logout` now demands a Bearer
	 * access_token to authenticate the caller, but we don't want to mint a
	 * fresh token (and thereby a new RT in a soon-to-be-revoked family) just
	 * to log out. If the token is missing or expired, returns undefined and
	 * the caller skips the server-side revoke step (local logout still
	 * proceeds; the orphaned RT will expire naturally).
	 */
	getAccessTokenForLogout(): string | undefined;
	storeTokens(accessToken: string, refreshToken: string, user?: IChipOSUserInfo): Promise<void>;
	clearTokens(): Promise<void>;
	getUser(): IChipOSUserInfo | undefined;
	isLoggedIn(): boolean;
	isUsingManualTokenFallback(): boolean;
	resolveWebsiteUrl(): string | undefined;
	mapAuthUser(user: ChipOSAuthUserResponse | undefined): IChipOSUserInfo | undefined;
	restoreUserFromServer(): Promise<void>;
}

export const IChipOSTokenManager = createDecorator<IChipOSTokenManager>('chipOSTokenManager');

export class ChipOSTokenManager extends Disposable implements IChipOSTokenManager {
	declare readonly _serviceBrand: undefined;

	private _accessToken: string | undefined;
	private _refreshToken: string | undefined;
	private _user: IChipOSUserInfo | undefined;
	private _usingManualTokenFallback: boolean = false;
	private _tokenExpiry: number = 0; // epoch ms
	private _refreshPromise: Promise<string | undefined> | undefined;
	private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChangeToken = this._register(new Emitter<string | undefined>());
	readonly onDidChangeToken = this._onDidChangeToken.event;

	private readonly _onDidChangeUser = this._register(new Emitter<IChipOSUserInfo | undefined>());
	readonly onDidChangeUser = this._onDidChangeUser.event;

	constructor(
		@ISecretStorageService private readonly _secretStorage: ISecretStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();
	}

	// ── Lifecycle ──

	async initialize(): Promise<void> {
		this._usingManualTokenFallback = false;

		// 1. Try SecretStorage first
		const stored = await this._secretStorage.get(KEY_ACCESS_TOKEN);
		if (stored) {
			this._accessToken = stored;
			this._refreshToken = await this._secretStorage.get(KEY_REFRESH_TOKEN) ?? undefined;
			const userJson = await this._secretStorage.get(KEY_USER_INFO);
			if (userJson) {
				try {
					// SecretStorage 里存的是已 mapped 的 IChipOSUserInfo（见 storeTokens），不需要再 mapAuthUser。
					this._user = JSON.parse(userJson) as IChipOSUserInfo;
				} catch {
					this._user = undefined;
				}
			}
			this._parseTokenExpiry(stored);
			this._scheduleAutoRefresh();
			await this.restoreUserFromServer();
			this._logService.info('[ChipOS Auth] Restored tokens from SecretStorage, user:', this._user?.email ?? 'unknown');
			return;
		}

		// 2. Fallback: legacy chipos.backend.token setting
		const legacyToken = this._configurationService.getValue<string>('chipos.backend.token');
		if (legacyToken) {
			this._accessToken = legacyToken;
			this._usingManualTokenFallback = true;
			this._parseTokenExpiry(legacyToken);
			this._logService.info('[ChipOS Auth] Using legacy chipos.backend.token as fallback');
		}
	}

	// ── Public API ──

	async getAccessToken(): Promise<string | undefined> {
		// If token is about to expire, try refresh
		if (this._accessToken && this._tokenExpiry > 0) {
			const now = Date.now();
			if (now >= this._tokenExpiry - REFRESH_MARGIN_MS) {
				const refreshed = await this.refreshAccessToken();
				if (refreshed) {
					return refreshed;
				}
			}
		}
		return this._accessToken;
	}

	async refreshAccessToken(): Promise<string | undefined> {
		// Concurrent dedup: if a refresh is already in flight, wait for it
		if (this._refreshPromise) {
			return this._refreshPromise;
		}

		if (!this._refreshToken) {
			this._logService.warn('[ChipOS Auth] No refresh_token available, cannot refresh');
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

	getAccessTokenForLogout(): string | undefined {
		// SEC: deliberately does NOT refresh. See interface docstring — minting
		// a fresh access_token + RT just to log out wastes RTs and races the
		// revocation we're about to issue. Best-effort: if the in-memory
		// access_token is still good, use it; otherwise the caller skips the
		// server-side revoke leg.
		if (!this._accessToken) {
			return undefined;
		}
		// Treat a token within REFRESH_MARGIN_MS of expiry as already invalid
		// for logout purposes — chiops will 401 it anyway.
		if (this._tokenExpiry > 0 && Date.now() >= this._tokenExpiry - REFRESH_MARGIN_MS) {
			return undefined;
		}
		return this._accessToken;
	}

	async storeTokens(accessToken: string, refreshToken: string, user?: IChipOSUserInfo): Promise<void> {
		this._accessToken = accessToken;
		this._refreshToken = refreshToken;
		this._user = user;
		this._usingManualTokenFallback = false;
		this._parseTokenExpiry(accessToken);

		await this._secretStorage.set(KEY_ACCESS_TOKEN, accessToken);
		await this._secretStorage.set(KEY_REFRESH_TOKEN, refreshToken);
		if (user) {
			await this._secretStorage.set(KEY_USER_INFO, JSON.stringify(user));
		} else {
			await this._secretStorage.delete(KEY_USER_INFO);
		}

		this._scheduleAutoRefresh();
		this._onDidChangeToken.fire(accessToken);
		this._onDidChangeUser.fire(user);
		this._logService.info('[ChipOS Auth] Tokens stored, user:', user?.email ?? 'unknown');
	}

	async clearTokens(): Promise<void> {
		this._accessToken = undefined;
		this._refreshToken = undefined;
		this._user = undefined;
		this._usingManualTokenFallback = false;
		this._tokenExpiry = 0;
		this._clearRefreshTimer();

		await this._secretStorage.delete(KEY_ACCESS_TOKEN);
		await this._secretStorage.delete(KEY_REFRESH_TOKEN);
		await this._secretStorage.delete(KEY_USER_INFO);

		this._onDidChangeToken.fire(undefined);
		this._onDidChangeUser.fire(undefined);
		this._logService.info('[ChipOS Auth] Tokens cleared (logout)');
	}

	getUser(): IChipOSUserInfo | undefined {
		return this._user;
	}

	isLoggedIn(): boolean {
		return !!this._accessToken;
	}

	isUsingManualTokenFallback(): boolean {
		return this._usingManualTokenFallback;
	}

	resolveWebsiteUrl(): string | undefined {
		// settings > product.json (build-time injected) > undefined.
		const resolved = resolveWebsiteUrl(this._configurationService, this._productService).trim();
		return resolved || undefined;
	}

	mapAuthUser(user: ChipOSAuthUserResponse | undefined): IChipOSUserInfo | undefined {
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

	restoreUserFromServer(): Promise<void> {
		return this._restoreUserFromServer();
	}

	// ── Internal ──

	private async _restoreUserFromServer(): Promise<void> {
		const websiteUrl = this.resolveWebsiteUrl();
		if (!websiteUrl || !this._accessToken || this._usingManualTokenFallback) {
			return;
		}

		const fetchProfile = async (token: string): Promise<Response> => {
			return fetch(`${websiteUrl}/api/auth/me`, {
				method: 'GET',
				headers: { 'Authorization': `Bearer ${token}` },
			});
		};

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
				this._logService.warn('[ChipOS Auth] /api/auth/me rejected restored token with status %s, clearing local auth state', resp.status);
				await this.clearTokens();
				return;
			}

			if (!resp.ok) {
				this._logService.warn('[ChipOS Auth] /api/auth/me returned non-OK status %s, keeping cached user info', resp.status);
				return;
			}

			const data = await resp.json() as ChipOSAuthUserResponse | { user?: ChipOSAuthUserResponse } | null;
			let rawUser: ChipOSAuthUserResponse | undefined;
			if (data && typeof data === 'object' && 'user' in data) {
				rawUser = data.user;
			} else if (data) {
				rawUser = data as ChipOSAuthUserResponse;
			}
			const mappedUser = this.mapAuthUser(rawUser);
			if (!mappedUser) {
				this._logService.warn('[ChipOS Auth] /api/auth/me returned no usable user profile');
				return;
			}

			this._user = mappedUser;
			await this._secretStorage.set(KEY_USER_INFO, JSON.stringify(mappedUser));
			this._onDidChangeUser.fire(mappedUser);
		} catch (err) {
			this._logService.warn('[ChipOS Auth] Failed to restore user profile from /api/auth/me: %s', String(err));
		}
	}

	private async _doRefresh(): Promise<string | undefined> {
		const websiteUrl = this.resolveWebsiteUrl();
		if (!websiteUrl) {
			this._logService.warn('[ChipOS Auth] chipos.auth.websiteUrl is required for OAuth login and token refresh; configure it in Connection settings');
			return undefined;
		}

		try {
			this._logService.info('[ChipOS Auth] Refreshing access_token...');
			const resp = await fetch(`${websiteUrl}/api/auth/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: this._refreshToken }),
			});

			if (!resp.ok) {
				this._logService.warn('[ChipOS Auth] Refresh failed:', resp.status);
				if (resp.status === 401) {
					// refresh_token itself is invalid/expired → force re-login
					await this.clearTokens();
				}
				return undefined;
			}

			const data = await resp.json() as { access_token: string; refresh_token?: string; user?: ChipOSAuthUserResponse };
			await this.storeTokens(
				data.access_token,
				data.refresh_token ?? this._refreshToken!,
				this.mapAuthUser(data.user) ?? this._user,
			);
			return data.access_token;
		} catch (err) {
			this._logService.error('[ChipOS Auth] Refresh error:', String(err));
			return undefined;
		}
	}

	private _parseTokenExpiry(token: string): void {
		try {
			const parts = token.split('.');
			if (parts.length === 3) {
				const payload = JSON.parse(atob(parts[1]));
				if (payload.exp) {
					this._tokenExpiry = payload.exp * 1000; // sec → ms
				}
			}
		} catch {
			this._tokenExpiry = 0;
		}
	}

	private _scheduleAutoRefresh(): void {
		this._clearRefreshTimer();
		if (!this._refreshToken || this._tokenExpiry <= 0) {
			return;
		}
		const delay = Math.max(0, this._tokenExpiry - Date.now() - REFRESH_MARGIN_MS);
		this._refreshTimer = setTimeout(() => {
			this.refreshAccessToken().catch(err => {
				this._logService.error('[ChipOS Auth] Auto-refresh failed:', String(err));
			});
		}, delay);
	}

	private _clearRefreshTimer(): void {
		if (this._refreshTimer !== undefined) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = undefined;
		}
	}

	override dispose(): void {
		this._clearRefreshTimer();
		super.dispose();
	}
}
