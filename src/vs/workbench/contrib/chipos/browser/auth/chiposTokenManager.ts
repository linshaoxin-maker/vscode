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

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../../../platform/secrets/common/secrets.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

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
}

export interface IChipOSTokenManager {
	readonly _serviceBrand: undefined;

	readonly onDidChangeToken: Event<string | undefined>;
	readonly onDidChangeUser: Event<IChipOSUserInfo | undefined>;

	initialize(): Promise<void>;
	getAccessToken(): Promise<string | undefined>;
	refreshAccessToken(): Promise<string | undefined>;
	storeTokens(accessToken: string, refreshToken: string, user?: IChipOSUserInfo): Promise<void>;
	clearTokens(): Promise<void>;
	getUser(): IChipOSUserInfo | undefined;
	isLoggedIn(): boolean;
}

export const IChipOSTokenManager = createDecorator<IChipOSTokenManager>('chipOSTokenManager');

export class ChipOSTokenManager extends Disposable implements IChipOSTokenManager {
	declare readonly _serviceBrand: undefined;

	private _accessToken: string | undefined;
	private _refreshToken: string | undefined;
	private _user: IChipOSUserInfo | undefined;
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
	) {
		super();
	}

	// ── Lifecycle ──

	async initialize(): Promise<void> {
		// 1. Try SecretStorage first
		const stored = await this._secretStorage.get(KEY_ACCESS_TOKEN);
		if (stored) {
			this._accessToken = stored;
			this._refreshToken = await this._secretStorage.get(KEY_REFRESH_TOKEN) ?? undefined;
			const userJson = await this._secretStorage.get(KEY_USER_INFO);
			if (userJson) {
				try { this._user = JSON.parse(userJson); } catch { /* ignore */ }
			}
			this._parseTokenExpiry(stored);
			this._scheduleAutoRefresh();
			this._logService.info('[ChipOS Auth] Restored tokens from SecretStorage, user:', this._user?.email ?? 'unknown');
			return;
		}

		// 2. Fallback: legacy chipos.backend.token setting
		const legacyToken = this._configurationService.getValue<string>('chipos.backend.token');
		if (legacyToken) {
			this._accessToken = legacyToken;
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

	async storeTokens(accessToken: string, refreshToken: string, user?: IChipOSUserInfo): Promise<void> {
		this._accessToken = accessToken;
		this._refreshToken = refreshToken;
		this._user = user;
		this._parseTokenExpiry(accessToken);

		await this._secretStorage.set(KEY_ACCESS_TOKEN, accessToken);
		await this._secretStorage.set(KEY_REFRESH_TOKEN, refreshToken);
		if (user) {
			await this._secretStorage.set(KEY_USER_INFO, JSON.stringify(user));
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

	// ── Internal ──

	private async _doRefresh(): Promise<string | undefined> {
		const websiteUrl = this._configurationService.getValue<string>('chipos.auth.websiteUrl') || '';
		if (!websiteUrl) {
			this._logService.warn('[ChipOS Auth] chipos.auth.websiteUrl not configured, cannot refresh');
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

			const data = await resp.json() as { access_token: string; refresh_token?: string; user?: IChipOSUserInfo };
			await this.storeTokens(
				data.access_token,
				data.refresh_token ?? this._refreshToken!,
				data.user ?? this._user,
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
