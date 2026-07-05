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
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IChipOSTokenManager, type IChipOSUserInfo } from './chiposTokenManager.js';
import { fetchMyOrgs, postSwitchOrg, type OrgSummary as IChipOSOrgSummary } from '../chatAgent/statelessInvoke/vendor/auth/orgSwitchClient.js';
import { exchangeCode, requestWorkerToken, postLogout } from '../chatAgent/statelessInvoke/vendor/auth/authWire.js';

export type { OrgSummary as IChipOSOrgSummary } from '../chatAgent/statelessInvoke/vendor/auth/orgSwitchClient.js';

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

	/** Active-org switching: list the orgs the signed-in user belongs to + their role. */
	getMyOrgs(): Promise<IChipOSOrgSummary[]>;
	/**
	 * Switch the active org → re-issue + store an org-scoped access_token (its
	 * scopes follow the user's role in that org). Returns the new active org id +
	 * role on success, or undefined if the switch was rejected (e.g. not a member).
	 */
	switchOrg(orgId: string): Promise<{ active_org_id: string; role: string } | undefined>;
}

export const IChipOSAuthService = createDecorator<IChipOSAuthService>('chipOSAuthService');

export class ChipOSAuthService extends Disposable implements IChipOSAuthService {
	declare readonly _serviceBrand: undefined;

	private _pendingChallenge: string | undefined;

	private readonly _onDidChangeLoginState = this._register(new Emitter<boolean>());
	readonly onDidChangeLoginState = this._onDidChangeLoginState.event;

	/**
	 * 2026-05-20 fix (onDidChangeLoginState spurious flip): cached prior
	 * value of `isLoggedIn()` used to gate the event below. Without this gate,
	 * every routine token refresh (storeTokens / restoreUserFromServer in
	 * ChipOSTokenManager) re-fires onDidChangeLoginState even though the
	 * boolean login state has not actually changed -- which made the IDE
	 * sidecar (sidecarManagerElectron.ts:194-202) respawn the worker on
	 * every refresh (~every 55-60 min, matching JWT refresh cadence).
	 *
	 * The event's contract is "login state changed", so this gate just
	 * makes the implementation honor the name. Initialized to `undefined`
	 * so the very first onDidChangeToken event (e.g. token restored from
	 * SecretStorage at startup) still fires for genuine new subscribers.
	 */
	private _lastLoggedInState: boolean | undefined = undefined;

	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILogService private readonly _logService: ILogService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		// Snapshot the initial login state at construction time. Without this
		// the first onDidChangeToken event after IDE startup (which arrives
		// from the first storeTokens / refresh call -- TokenManager.init
		// itself does NOT fire onDidChangeToken when it restores tokens from
		// SecretStorage) would always pass the gate below (undefined !==
		// true) and respawn the worker for what is in fact "we were already
		// logged in, this is just the first refresh after startup". Capture
		// what TokenManager currently reports so the gate has a real
		// baseline. If TokenManager has not finished its async restore yet,
		// isLoggedIn() returns false; then the first true storeTokens after
		// restore will legitimately flip false -> true and that DOES need to
		// fire (it's the first real "logged in" signal). The listener-side
		// guard in sidecarManagerElectron handles "worker already running so
		// don't respawn" for the latter case.
		this._lastLoggedInState = this._tokenManager.isLoggedIn();

		// Forward token changes to login state -- but only when the boolean
		// login state actually flips. Token refreshes that keep the user
		// logged in (true -> true) must NOT re-fire, otherwise sidecar
		// respawns the worker every refresh cycle.
		this._register(this._tokenManager.onDidChangeToken(() => {
			const newState = this._tokenManager.isLoggedIn();
			if (this._lastLoggedInState === newState) {
				this._logService.trace('[ChipOS Auth] onDidChangeToken with unchanged loginState=%s; suppressing spurious flip', String(newState));
				return;
			}
			this._lastLoggedInState = newState;
			this._onDidChangeLoginState.fire(newState);
		}));

		// A persisted session is restored SILENTLY by ChipOSTokenManager.initialize()
		// (it reads the token from SecretStorage without firing onDidChangeToken,
		// then confirms via restoreUserFromServer() which fires only onDidChangeUser).
		// So on startup the access token can land with NO onDidChangeToken — meaning
		// onDidChangeLoginState never fires, and consumers like the chat login gate
		// stay stuck on "sign in" even though we are authenticated (while the settings
		// account card, which listens to onDidChangeUser, correctly shows the user).
		// Re-evaluate login state on user changes too; the same flip-gate suppresses
		// true->true so routine refreshes don't re-fire (no spurious worker respawn).
		this._register(this._tokenManager.onDidChangeUser(() => {
			const newState = this._tokenManager.isLoggedIn();
			if (this._lastLoggedInState === newState) {
				return;
			}
			this._lastLoggedInState = newState;
			this._onDidChangeLoginState.fire(newState);
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
		// PHASE2-AUTH-7: kill any running workers spawned with the credentials
		// we're about to clear. Without this, a worker process keeps running
		// on the EDA box (or locally) with its still-valid worker_token JWT,
		// holding an open gRPC stream to reasoner until the JWT expires
		// (worst case 24h). Done BEFORE clearing tokens so any RPC the stop
		// path needs (e.g. SSH session metadata) is still authenticated.
		try {
			await this._commandService.executeCommand('chipos.backend.stopAll');
		} catch (err) {
			// Best-effort. The stopAll command itself swallows individual
			// failures; if the command isn't registered (very old build) we
			// also ignore — better to log out cleanly than to refuse logout.
			this._logService.warn('[ChipOS Auth] chipos.backend.stopAll on logout failed (continuing):', String(err));
		}

		// Best-effort: tell the website to revoke the refresh_token before we
		// clear it locally. Failure (network, 4xx, etc.) must not block local
		// logout — the user expects the IDE to forget them either way.
		// SEC: chiops `/auth/logout` now requires Bearer access_token to
		// authenticate the caller (prevents third-party RT abuse). If our
		// in-memory access_token is missing or near-expired, we skip the
		// server call entirely — local cleanup still proceeds and the
		// orphaned RT expires naturally. We deliberately do NOT trigger a
		// refresh just to log out.
		const refreshToken = await this._tokenManager.getRefreshTokenForLogout();
		const accessToken = this._tokenManager.getAccessTokenForLogout();
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		if (websiteUrl && refreshToken && accessToken) {
			// A6: canonical postLogout — best-effort, never throws (offline/4xx → false).
			await postLogout(websiteUrl, accessToken, refreshToken);
		} else if (websiteUrl && refreshToken && !accessToken) {
			this._logService.info('[ChipOS Auth] skipping server-side logout — no live access_token (RT will expire naturally)');
		}
		await this._tokenManager.clearTokens();
		this._logService.info('[ChipOS Auth] Logged out (workers stopped, tokens cleared)');
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
		// A6: canonical requestWorkerToken — surfaces status, never throws.
		const r = await requestWorkerToken(websiteUrl, accessToken, workerId ? { workerId } : {});
		if (!r.ok || !r.worker_token || !r.expires_in) {
			this._logService.warn('[ChipOS Auth] /api/auth/worker-token failed or malformed:', r.status);
			return undefined;
		}
		return { worker_token: r.worker_token, expires_in: r.expires_in };
	}

	async getMyOrgs(): Promise<IChipOSOrgSummary[]> {
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		const accessToken = await this._tokenManager.getAccessToken();
		if (!websiteUrl || !accessToken) {
			this._logService.warn('[ChipOS Auth] getMyOrgs: not configured / not logged in');
			return [];
		}
		try {
			return await fetchMyOrgs(websiteUrl, accessToken);
		} catch (err) {
			this._logService.warn('[ChipOS Auth] getMyOrgs error:', String(err));
			return [];
		}
	}

	async switchOrg(orgId: string): Promise<{ active_org_id: string; role: string } | undefined> {
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		const accessToken = await this._tokenManager.getAccessToken();
		if (!websiteUrl || !accessToken) {
			this._logService.warn('[ChipOS Auth] switchOrg: not configured / not logged in');
			return undefined;
		}
		try {
			const result = await postSwitchOrg(websiteUrl, accessToken, orgId);
			if (!result) {
				this._logService.warn('[ChipOS Auth] switchOrg: /switch-org rejected or returned no token');
				return undefined;
			}
			// Swap in the org-scoped token; the reasoner transport reads it per-request,
			// so the next turn runs under the new org's scopes (reasoner-enforced).
			await this._tokenManager.updateAccessToken(result.access_token);
			this._logService.info('[ChipOS Auth] active org switched:', result.active_org_id, result.role);
			return { active_org_id: result.active_org_id, role: result.role };
		} catch (err) {
			this._logService.warn('[ChipOS Auth] switchOrg error:', String(err));
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

		// A6: canonical exchangeCode — undefined on any failure (non-2xx / malformed /
		// network), never throws.
		const bundle = await exchangeCode(websiteUrl, code, this._pendingChallenge);
		if (!bundle) {
			this._logService.error('[ChipOS Auth] Token exchange failed');
			return;
		}
		const mappedUser = this._tokenManager.mapAuthUser(bundle.user);
		await this._tokenManager.storeTokens(bundle.access_token, bundle.refresh_token ?? '', mappedUser);
		this._pendingChallenge = undefined;
		this._logService.info('[ChipOS Auth] Login successful, user:', bundle.user?.email ?? 'unknown');
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
