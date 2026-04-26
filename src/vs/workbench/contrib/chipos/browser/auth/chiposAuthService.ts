/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  Phase 1 Unified Auth: ChipOSAuthService
 *
 *  Handles OAuth login flow with chiops website:
 *  - Opens browser to /auth/ide-login?challenge=...
 *  - Receives chipos://callback?code=... via URI handler
 *  - Exchanges code for access_token + refresh_token
 *  - Stores tokens via ChipOSTokenManager
 *  - Supports logout
 *
 *  See: chiops/docs/unified-auth/04-phase1-coderust-ide.md (I1)
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChipOSTokenManager, type ChipOSAuthUserResponse, type IChipOSUserInfo } from './chiposTokenManager.js';

export interface IChipOSWorkerTokenResult {
	worker_token: string;
	expires_in: number;
}

export interface IChipOSAuthService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeLoginState: Event<boolean>;

	login(): Promise<void>;
	logout(): Promise<void>;
	handleCallback(uri: URI): Promise<void>;
	isLoggedIn(): boolean;
	getUser(): IChipOSUserInfo | undefined;
	/**
	 * Phase 1.5 Worker JWT: exchange the current access_token for a Worker
	 * JWT (`scope=worker`) signed by the website. Used by the IDE sidecar to
	 * boot a local Worker without sharing the user access_token.
	 *
	 * Returns undefined when not logged in or when the website rejects the
	 * exchange (caller should fall back to the legacy api_key path).
	 */
	getWorkerToken(workerId?: string): Promise<IChipOSWorkerTokenResult | undefined>;
}

export const IChipOSAuthService = createDecorator<IChipOSAuthService>('chipOSAuthService');

export class ChipOSAuthService extends Disposable implements IChipOSAuthService {
	declare readonly _serviceBrand: undefined;

	private _pendingChallenge: string | undefined;

	private readonly _onDidChangeLoginState = this._register(new Emitter<boolean>());
	readonly onDidChangeLoginState = this._onDidChangeLoginState.event;

	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILogService private readonly _logService: ILogService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
	) {
		super();

		// Forward token changes to login state
		this._register(this._tokenManager.onDidChangeToken(() => {
			this._onDidChangeLoginState.fire(this._tokenManager.isLoggedIn());
		}));
	}

	async login(): Promise<void> {
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		if (!websiteUrl) {
			this._logService.error('[ChipOS Auth] chipos.auth.websiteUrl not configured');
			throw new Error('chipos.auth.websiteUrl is required for OAuth login. Please configure it in ChipOS Connection settings.');
		}

		// Generate a random challenge for PKCE-like verification
		this._pendingChallenge = this._generateChallenge();

		const loginUrl = `${websiteUrl}/auth/ide-login?challenge=${encodeURIComponent(this._pendingChallenge)}`;
		this._logService.info('[ChipOS Auth] Opening login page:', loginUrl);

		await this._openerService.open(URI.parse(loginUrl), { openExternal: true });
	}

	async logout(): Promise<void> {
		// Best-effort: tell the website to revoke the refresh_token before we
		// clear it locally. Failure (network, 4xx, etc.) must not block local
		// logout — the user expects the IDE to forget them either way.
		const refreshToken = await this._tokenManager.getRefreshTokenForLogout();
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		if (websiteUrl && refreshToken) {
			try {
				await fetch(`${websiteUrl}/api/auth/logout`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ refresh_token: refreshToken }),
				});
			} catch (err) {
				this._logService.warn('[ChipOS Auth] /api/auth/logout failed (continuing local logout):', String(err));
			}
		}
		await this._tokenManager.clearTokens();
		this._logService.info('[ChipOS Auth] Logged out');
	}

	async getWorkerToken(workerId?: string): Promise<IChipOSWorkerTokenResult | undefined> {
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		if (!websiteUrl) {
			this._logService.warn('[ChipOS Auth] getWorkerToken: chipos.auth.websiteUrl not configured');
			return undefined;
		}
		const accessToken = await this._tokenManager.getAccessToken();
		if (!accessToken) {
			this._logService.warn('[ChipOS Auth] getWorkerToken: no access_token (user not logged in)');
			return undefined;
		}
		try {
			const resp = await fetch(`${websiteUrl}/api/auth/worker-token`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${accessToken}`,
				},
				body: JSON.stringify(workerId ? { worker_id: workerId } : {}),
			});
			if (!resp.ok) {
				const text = await resp.text().catch(() => '');
				this._logService.warn('[ChipOS Auth] /api/auth/worker-token failed:', resp.status, text);
				return undefined;
			}
			const data = await resp.json() as { worker_token?: string; expires_in?: number };
			if (!data?.worker_token || !data?.expires_in) {
				this._logService.warn('[ChipOS Auth] /api/auth/worker-token returned malformed response');
				return undefined;
			}
			return { worker_token: data.worker_token, expires_in: data.expires_in };
		} catch (err) {
			this._logService.warn('[ChipOS Auth] getWorkerToken error:', String(err));
			return undefined;
		}
	}

	async handleCallback(uri: URI): Promise<void> {
		// Expected: chipos://callback?code=xxx
		const code = uri.query ? new URLSearchParams(uri.query).get('code') : null;
		if (!code) {
			this._logService.error('[ChipOS Auth] Callback missing code parameter:', uri.toString());
			return;
		}

		this._logService.info('[ChipOS Auth] Received callback, exchanging code...');

		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		if (!websiteUrl) {
			this._logService.error('[ChipOS Auth] chipos.auth.websiteUrl not configured');
			return;
		}

		try {
			const resp = await fetch(`${websiteUrl}/api/auth/token/exchange`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					code,
					challenge: this._pendingChallenge,
				}),
			});

			if (!resp.ok) {
				const text = await resp.text();
				this._logService.error('[ChipOS Auth] Token exchange failed:', resp.status, text);
				return;
			}

			const data = await resp.json() as {
				access_token: string;
				refresh_token: string;
				user?: ChipOSAuthUserResponse;
			};

			const mappedUser = this._tokenManager.mapAuthUser(data.user);
			await this._tokenManager.storeTokens(data.access_token, data.refresh_token, mappedUser);
			this._pendingChallenge = undefined;
			this._logService.info('[ChipOS Auth] Login successful, user:', data.user?.email ?? 'unknown');
		} catch (err) {
			this._logService.error('[ChipOS Auth] Token exchange error:', String(err));
		}
	}

	isLoggedIn(): boolean {
		return this._tokenManager.isLoggedIn();
	}

	getUser(): IChipOSUserInfo | undefined {
		return this._tokenManager.getUser();
	}

	private _generateChallenge(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
	}
}
