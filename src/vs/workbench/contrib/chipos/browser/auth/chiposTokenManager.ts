/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  ChipOSTokenManager — IDE (DI service) adapter over the canonical auth core.
 *
 *  doc-20 · A2: the token-lifecycle state machine now lives in the vendored
 *  `chatAgent/statelessInvoke/vendor/auth/tokenManagerCore` (canonical source
 *  packages/invoke-client/src/auth/). This file is the THIN workbench adapter —
 *  it binds the core's ports to platform services (SecretStorage / Configuration /
 *  Log / Product), bridges the core's structural events to vscode `Emitter`s, and
 *  wires cross-window sync (onDidChangeSecret → core.syncFromStore). The DI shape
 *  (decorator + interface + registerSingleton) is unchanged, so consumers are
 *  untouched.
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
import {
	AuthTokenManagerCore,
	KEY_ACCESS_TOKEN,
	type AuthTokenClaims,
	type AuthUserInfo,
	type AuthUserResponse,
	type TokenManagerDeps,
} from '../chatAgent/statelessInvoke/vendor/auth/tokenManagerCore.js';

// Public type names IDE consumers import from here (aliases of the canonical types).
export type IChipOSUserInfo = AuthUserInfo;
export type IChipOSTokenClaims = AuthTokenClaims;
export type ChipOSAuthUserResponse = AuthUserResponse;

export interface IChipOSTokenManager {
	readonly _serviceBrand: undefined;

	readonly onDidChangeToken: Event<string | undefined>;
	readonly onDidChangeUser: Event<IChipOSUserInfo | undefined>;

	initialize(): Promise<void>;
	getAccessToken(): Promise<string | undefined>;
	refreshAccessToken(): Promise<string | undefined>;
	/**
	 * The current refresh_token, for the logout flow only (so the caller can ask
	 * the website to revoke it before clearing local state). Never use for regular
	 * auth — refresh_token must not leave the IDE process.
	 */
	getRefreshTokenForLogout(): Promise<string | undefined>;
	/**
	 * The in-memory access_token WITHOUT triggering a refresh (logout flow needs a
	 * Bearer but must not mint a fresh RT in a soon-to-be-revoked family). Undefined
	 * when missing/expired → caller skips the server-side revoke.
	 */
	getAccessTokenForLogout(): string | undefined;
	storeTokens(accessToken: string, refreshToken: string, user?: IChipOSUserInfo): Promise<void>;
	/**
	 * Active-org switch: replace ONLY the access_token (refresh_token + user
	 * unchanged), persist, re-schedule auto-refresh, fire onDidChangeToken.
	 */
	updateAccessToken(accessToken: string): Promise<void>;
	clearTokens(): Promise<void>;
	getUser(): IChipOSUserInfo | undefined;
	/** Decode the active org / role / scopes from the in-memory access_token's JWT. */
	getTokenClaims(): IChipOSTokenClaims | undefined;
	isLoggedIn(): boolean;
	isUsingManualTokenFallback(): boolean;
	resolveWebsiteUrl(): string | undefined;
	mapAuthUser(user: ChipOSAuthUserResponse | undefined): IChipOSUserInfo | undefined;
	restoreUserFromServer(): Promise<void>;
}

export const IChipOSTokenManager = createDecorator<IChipOSTokenManager>('chipOSTokenManager');

export class ChipOSTokenManager extends Disposable implements IChipOSTokenManager {
	declare readonly _serviceBrand: undefined;

	private readonly _core: AuthTokenManagerCore;

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

		const deps: TokenManagerDeps = {
			store: {
				get: (key) => this._secretStorage.get(key).then((v) => v ?? undefined),
				set: (key, value) => this._secretStorage.set(key, value),
				delete: (key) => this._secretStorage.delete(key),
			},
			resolveWebsiteUrl: () => {
				const resolved = resolveWebsiteUrl(this._configurationService, this._productService).trim();
				return resolved || undefined;
			},
			logger: this._logService,
			readLegacyToken: () => this._configurationService.getValue<string>('chipos.backend.token') || undefined,
		};
		this._core = new AuthTokenManagerCore(deps);
		this._register({ dispose: () => this._core.dispose() });

		// Bridge the core's structural events to vscode Emitters (Event<T> contract).
		this._register(this._core.onDidChangeToken((t) => this._onDidChangeToken.fire(t)));
		this._register(this._core.onDidChangeUser((u) => this._onDidChangeUser.fire(u)));

		// Cross-window auth sync. SecretStorage is APPLICATION-scoped, so a token
		// write in ANY window fires onDidChangeSecret here — adopt it so this window
		// doesn't go stale (its requests would otherwise keep 401ing). The core's
		// syncFromStore no-ops when already in sync (incl. the writer's own write).
		this._register(
			this._secretStorage.onDidChangeSecret((key) => {
				if (key === KEY_ACCESS_TOKEN) {
					void this._core.syncFromStore();
				}
			}),
		);
	}

	initialize(): Promise<void> {
		return this._core.initialize();
	}
	getAccessToken(): Promise<string | undefined> {
		return this._core.getAccessToken();
	}
	refreshAccessToken(): Promise<string | undefined> {
		return this._core.refreshAccessToken();
	}
	getRefreshTokenForLogout(): Promise<string | undefined> {
		return this._core.getRefreshTokenForLogout();
	}
	getAccessTokenForLogout(): string | undefined {
		return this._core.getAccessTokenForLogout();
	}
	storeTokens(accessToken: string, refreshToken: string, user?: IChipOSUserInfo): Promise<void> {
		return this._core.storeTokens(accessToken, refreshToken, user);
	}
	updateAccessToken(accessToken: string): Promise<void> {
		return this._core.updateAccessToken(accessToken);
	}
	clearTokens(): Promise<void> {
		return this._core.clearTokens();
	}
	getUser(): IChipOSUserInfo | undefined {
		return this._core.getUser();
	}
	getTokenClaims(): IChipOSTokenClaims | undefined {
		return this._core.getTokenClaims();
	}
	isLoggedIn(): boolean {
		return this._core.isLoggedIn();
	}
	isUsingManualTokenFallback(): boolean {
		return this._core.isUsingManualTokenFallback();
	}
	resolveWebsiteUrl(): string | undefined {
		return this._core.resolveWebsiteUrl();
	}
	mapAuthUser(user: ChipOSAuthUserResponse | undefined): IChipOSUserInfo | undefined {
		return this._core.mapAuthUser(user);
	}
	restoreUserFromServer(): Promise<void> {
		return this._core.restoreUserFromServer();
	}
}
