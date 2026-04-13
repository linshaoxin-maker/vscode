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

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IChipOSTokenManager, type ChipOSAuthUserResponse, type IChipOSUserInfo } from './chiposTokenManager.js';

export interface IChipOSAuthService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeLoginState: Event<boolean>;

	login(): Promise<void>;
	logout(): Promise<void>;
	handleCallback(uri: URI): Promise<void>;
	isLoggedIn(): boolean;
	getUser(): IChipOSUserInfo | undefined;
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
		await this._tokenManager.clearTokens();
		this._logService.info('[ChipOS Auth] Logged out');
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
