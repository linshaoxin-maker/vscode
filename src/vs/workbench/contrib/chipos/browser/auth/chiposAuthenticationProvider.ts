/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  ChipOS Accounts-menu integration (ADDITIVE — does not change existing auth logic).
 *
 *  Surfaces the existing ChipOS OAuth login in VS Code's native Accounts menu
 *  (the person icon): "Sign in to ChipOS" when signed out, the signed-in account
 *  + "Sign Out" when signed in — like the built-in GitHub/Microsoft providers.
 *
 *  This is a thin adapter over the existing services; it never reimplements the
 *  OAuth / token / worker logic:
 *    - getSessions()   -> reads the current token + user from ChipOSTokenManager
 *    - createSession() -> delegates to ChipOSAuthService.login()  (existing OAuth)
 *    - removeSession() -> delegates to ChipOSAuthService.logout() (existing)
 *  The signed-in account + "Sign Out" are rendered automatically by the Accounts
 *  menu (globalCompositeBar) for any registered provider that returns a session.
 *  The logged-out "Sign in to ChipOS" item runs the existing `chipos.auth.login`
 *  command directly; the provider's onDidChangeSessions then surfaces the account.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAuthenticationService, IAuthenticationProvider, AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationProviderSessionOptions } from '../../../../services/authentication/common/authentication.js';
import { IChipOSAuthService } from './chiposAuthService.js';
import { IChipOSTokenManager } from './chiposTokenManager.js';

const CHIPOS_AUTH_PROVIDER_ID = 'chipos';
const CHIPOS_AUTH_PROVIDER_LABEL = 'ChipOS';
const CHIPOS_SESSION_ID = 'chipos.session';
// Mirrors the (const-enum, non-exported) ChipOSCommandId.Login in common/chiposContribution.ts.
const CHIPOS_LOGIN_COMMAND_ID = 'chipos.auth.login';

/** True when a ChipOS user is signed in; drives the logged-out "Sign in" menu item. */
export const ChipOSSignedInContext = new RawContextKey<boolean>('chiposSignedIn', false);

/**
 * VS Code AuthenticationProvider backed entirely by the existing ChipOSAuthService
 * + ChipOSTokenManager. Single account, no multi-account support.
 */
class ChipOSAuthenticationProvider extends Disposable implements IAuthenticationProvider {
	readonly id = CHIPOS_AUTH_PROVIDER_ID;
	readonly label = CHIPOS_AUTH_PROVIDER_LABEL;
	readonly supportsMultipleAccounts = false;

	private readonly _onDidChangeSessions = this._register(new Emitter<AuthenticationSessionsChangeEvent>());
	readonly onDidChangeSessions: Event<AuthenticationSessionsChangeEvent> = this._onDidChangeSessions.event;

	private _lastSession: AuthenticationSession | undefined;

	constructor(
		@IChipOSAuthService private readonly _authService: IChipOSAuthService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		// Keep the Accounts menu in sync when login state changes through ANY path
		// (settings button, command, or the OAuth callback) — not only our own
		// create/removeSession. Delegates to the existing onDidChangeLoginState event.
		this._register(this._authService.onDidChangeLoginState(async isLoggedIn => {
			if (isLoggedIn) {
				const session = await this._buildSession();
				if (session) {
					this._lastSession = session;
					this._onDidChangeSessions.fire({ added: [session], removed: undefined, changed: undefined });
				}
			} else {
				const removed = this._lastSession;
				this._lastSession = undefined;
				this._onDidChangeSessions.fire({ added: undefined, removed: removed ? [removed] : undefined, changed: undefined });
			}
		}));
	}

	async getSessions(scopes: string[] | undefined, _options: IAuthenticationProviderSessionOptions): Promise<readonly AuthenticationSession[]> {
		const session = await this._buildSession(scopes);
		if (session) {
			this._lastSession = session;
		}
		return session ? [session] : [];
	}

	async createSession(scopes: string[], _options: IAuthenticationProviderSessionOptions): Promise<AuthenticationSession> {
		// Single-account provider: if already signed in, hand back the current session.
		if (this._tokenManager.isLoggedIn()) {
			const existing = await this._buildSession(scopes);
			if (existing) {
				this._lastSession = existing;
				return existing;
			}
		}
		// login() is fire-and-forget (opens the browser); the chipos://callback handler
		// exchanges the code and flips login state. Wait for that, bounded by a timeout.
		const loggedIn = Event.toPromise(Event.filter(this._authService.onDidChangeLoginState, s => s === true));
		try {
			await this._authService.login();
		} catch (err) {
			loggedIn.cancel();
			throw err;
		}
		await raceTimeout(loggedIn, 5 * 60 * 1000, () => loggedIn.cancel());
		const session = await this._buildSession(scopes);
		if (!session) {
			this._logService.warn('[ChipOS Auth] createSession: sign-in did not complete within the timeout');
			throw new Error(localize('chipos.auth.signInIncomplete', "ChipOS sign-in was not completed."));
		}
		this._logService.info('[ChipOS Auth] Accounts-menu sign-in completed');
		this._lastSession = session;
		this._onDidChangeSessions.fire({ added: [session], removed: undefined, changed: undefined });
		return session;
	}

	async removeSession(_sessionId: string): Promise<void> {
		const removed = this._lastSession ?? await this._buildSession();
		await this._authService.logout();
		this._lastSession = undefined;
		this._logService.info('[ChipOS Auth] Accounts-menu sign-out completed');
		this._onDidChangeSessions.fire({ added: undefined, removed: removed ? [removed] : undefined, changed: undefined });
	}

	private async _buildSession(scopes?: string[]): Promise<AuthenticationSession | undefined> {
		if (!this._tokenManager.isLoggedIn()) {
			return undefined;
		}
		const accessToken = await this._tokenManager.getAccessToken();
		if (!accessToken) {
			return undefined;
		}
		const user = this._tokenManager.getUser();
		const label = user?.display_name?.trim() || user?.email?.trim() || CHIPOS_AUTH_PROVIDER_LABEL;
		const accountId = user?.user_id?.trim() || user?.email?.trim() || CHIPOS_AUTH_PROVIDER_ID;
		return {
			id: CHIPOS_SESSION_ID,
			accessToken,
			account: { id: accountId, label },
			scopes: scopes ?? [],
		};
	}
}

/**
 * Registers the ChipOS authentication provider with the workbench so it appears
 * in the Accounts menu, and binds the {@link ChipOSSignedInContext} key.
 */
class ChipOSAuthenticationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chiposAuthentication';

	constructor(
		@IAuthenticationService authenticationService: IAuthenticationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IChipOSAuthService authService: IChipOSAuthService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Declare + register the provider. The Accounts menu (globalCompositeBar)
		// then auto-renders the signed-in account and its "Sign Out" entry.
		authenticationService.registerDeclaredAuthenticationProvider({ id: CHIPOS_AUTH_PROVIDER_ID, label: CHIPOS_AUTH_PROVIDER_LABEL });
		const provider = this._register(instantiationService.createInstance(ChipOSAuthenticationProvider));
		authenticationService.registerAuthenticationProvider(CHIPOS_AUTH_PROVIDER_ID, provider);
		this._register(toDisposable(() => {
			authenticationService.unregisterAuthenticationProvider(CHIPOS_AUTH_PROVIDER_ID);
			authenticationService.unregisterDeclaredAuthenticationProvider(CHIPOS_AUTH_PROVIDER_ID);
		}));

		// Context key for the logged-out "Sign in to ChipOS" accounts-menu item.
		const signedIn = ChipOSSignedInContext.bindTo(contextKeyService);
		signedIn.set(authService.isLoggedIn());
		this._register(authService.onDidChangeLoginState(s => signedIn.set(s)));
	}
}

// Accounts menu: "Sign in to ChipOS" (signed-out only). Runs the existing login
// command; the provider's onDidChangeSessions then surfaces the signed-in account.
MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
	group: '2_chipos',
	command: {
		id: CHIPOS_LOGIN_COMMAND_ID,
		title: localize('chipos.auth.signInAccounts', "Sign in to ChipOS"),
	},
	when: ChipOSSignedInContext.isEqualTo(false),
});

registerWorkbenchContribution2(ChipOSAuthenticationContribution.ID, ChipOSAuthenticationContribution, WorkbenchPhase.AfterRestored);
