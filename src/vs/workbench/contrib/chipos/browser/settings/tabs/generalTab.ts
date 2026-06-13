/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { SelectBox, ISelectOptionItem } from '../../../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultSelectBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IChipOSTokenManager } from '../../auth/chiposTokenManager.js';
import { IChipOSAuthService, type IChipOSOrgSummary } from '../../auth/chiposAuthService.js';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'off'];

export class GeneralTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	/** Cached org membership list (loaded once per login; reused across token refreshes). */
	private _orgsCache: IChipOSOrgSummary[] | undefined;
	/** Monotonic guard so a stale `getMyOrgs()` response can't clobber a newer one. */
	private _orgsFetchGeneration = 0;

	constructor(
		private readonly _container: HTMLElement,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextViewService contextViewService: IContextViewService,
		@ICommandService private readonly _commandService: ICommandService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@IChipOSAuthService private readonly _authService: IChipOSAuthService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
		this._render();
	}

	private _render(): void {
		dom.clearNode(this._container);

		// Account (auth) — pinned at the top, similar to Cursor.
		this._renderAccountSection(this._container);

		// Organization (active-org + role + permissions) — sits right under the
		// account so identity and org/role read as one block.
		this._renderOrganizationSection(this._container);

		// Privacy
		const privacySection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(privacySection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.general.privacy', 'Privacy')));

		this._renderToggle(privacySection, 'chipos.telemetry.enabled',
			localize('chipos.general.telemetry', 'Anonymous Usage Telemetry'),
			localize('chipos.general.telemetry.desc', 'Help improve ChipOS by sending anonymous usage data.'));

		this._renderToggle(privacySection, 'chipos.privacy.redactSensitive',
			localize('chipos.general.redact', 'Redact Sensitive Paths'),
			localize('chipos.general.redact.desc', 'Automatically redact file paths and personal identifiers from data sent to AI providers.'));

		// Logging
		const loggingSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(loggingSection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.general.logging', 'Logging')));

		this._renderLogLevel(loggingSection);

		// Editor Integration
		const editorSection = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(editorSection, dom.$('.chipos-settings-section-title', undefined, localize('chipos.general.editor', 'Editor Integration')));

		this._renderToggle(editorSection, 'chipos.editor.showInlineHints',
			localize('chipos.general.inlineHints', 'Show Inline Hints'),
			localize('chipos.general.inlineHints.desc', 'Show subtle inline hints for AI-assisted actions in the editor gutter.'));
	}

	// ── Account / Authentication ─────────────────────────────────────────
	private _renderAccountSection(parent: HTMLElement): void {
		const section = dom.append(parent, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.general.account', 'Account')));

		const auth = dom.append(section, dom.$('.chipos-auth-section'));
		dom.append(auth, dom.$('.chipos-setting-label', undefined,
			localize('chipos.general.auth', 'Authentication')));

		const statusRow = dom.append(auth, dom.$('.chipos-setting-row'));
		const statusText = dom.append(statusRow, dom.$('.chipos-auth-status'));

		// Single button row. Contents (Sign in vs Sign out) are rebuilt
		// whenever auth state changes so we never show both at once.
		const buttonRow = dom.append(auth, dom.$('.chipos-setting-row'));

		const renderButton = (signedIn: boolean) => {
			dom.clearNode(buttonRow);
			if (signedIn) {
				// Destructive action — use the secondary+danger combo so the
				// button reads as "this is a logout" (red text + red border)
				// instead of looking like another primary call-to-action.
				const logoutBtn = dom.append(buttonRow, dom.$('button.chipos-btn-secondary.chipos-btn-danger'));
				logoutBtn.textContent = localize('chipos.auth.logout', 'Sign out');
				this._disposables.add(dom.addDisposableListener(logoutBtn, 'click', () => {
					this._commandService.executeCommand('chipos.auth.logout');
				}));
			} else {
				const loginBtn = dom.append(buttonRow, dom.$('button.chipos-auth-button'));
				loginBtn.textContent = localize('chipos.auth.login', 'Sign in');
				this._disposables.add(dom.addDisposableListener(loginBtn, 'click', () => {
					this._commandService.executeCommand('chipos.auth.login');
				}));
			}
		};

		const updateStatus = () => {
			const user = this._tokenManager.getUser();
			if (user) {
				const displayName = user.display_name?.trim() || user.email;
				statusText.textContent = localize('chipos.auth.loggedIn', 'Logged in as {0}', displayName);
				renderButton(true);
				return;
			}
			if (this._tokenManager.isUsingManualTokenFallback()) {
				statusText.textContent = localize('chipos.auth.manualFallback', 'Using manual token fallback');
				renderButton(true);
				return;
			}
			statusText.textContent = localize('chipos.auth.notLoggedIn', 'Not logged in');
			renderButton(false);
		};

		updateStatus();

		this._disposables.add(this._tokenManager.onDidChangeUser(updateStatus));
		this._disposables.add(this._tokenManager.onDidChangeToken(updateStatus));
	}

	// ── Organization / active-org switching ──────────────────────────────
	private _renderOrganizationSection(parent: HTMLElement): void {
		const section = dom.append(parent, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined,
			localize('chipos.general.organization', 'Organization')));

		// Body is rebuilt on every auth/token change (login, logout, org switch).
		const body = dom.append(section, dom.$('.chipos-org-section'));

		// Sub-store cleared on each refresh so SelectBox instances + their
		// listeners don't accumulate across token-refresh / switch events. The
		// store itself lives for the tab's lifetime; clear() just drops contents.
		const refreshStore = this._disposables.add(new DisposableStore());

		const refresh = () => {
			refreshStore.clear();
			dom.clearNode(body);

			if (!this._tokenManager.isLoggedIn()) {
				this._orgsCache = undefined;
				dom.append(body, dom.$('.chipos-auth-status', undefined,
					localize('chipos.org.signedOut', 'Sign in to view and switch your organization.')));
				return;
			}

			// The membership list resolves the org name + per-org role (owner/
			// admin/member). Load it once, then render — so we never flash a raw
			// org id or the coarse global role before the real values arrive.
			if (this._orgsCache === undefined) {
				dom.append(body, dom.$('.chipos-auth-status', undefined,
					localize('chipos.org.loading', 'Loading organization…')));
				this._loadOrgs(refresh);
				return;
			}

			const claims = this._tokenManager.getTokenClaims();
			const currentOrgId = claims?.org_id;
			const scopes = claims?.scopes ?? [];
			const matched = currentOrgId ? this._orgsCache.find(o => o.org_id === currentOrgId) : undefined;
			const role = matched?.role ?? '';

			// ── Current org + role + permission summary ──
			const summary = dom.append(body, dom.$('.chipos-org-summary'));

			const orgName = matched?.name || localize('chipos.org.unknownName', 'Your organization');
			const nameLine = dom.append(summary, dom.$('.chipos-org-line'));
			dom.append(nameLine, dom.$('.chipos-org-key', undefined, localize('chipos.org.current', 'Current organization')));
			dom.append(nameLine, dom.$('.chipos-org-name', undefined, orgName));

			if (role) {
				const roleLine = dom.append(summary, dom.$('.chipos-org-line'));
				dom.append(roleLine, dom.$('.chipos-org-key', undefined, localize('chipos.org.role', 'Your role')));
				const badge = dom.append(roleLine, dom.$('.chipos-org-role-badge', undefined, role));
				badge.dataset.role = role;
			}

			// Permission legibility: derive from the JWT scopes the reasoner
			// actually enforces (rtl.write is the meaningful owner/admin vs member
			// divide); fall back to the role when an older token carries no scopes.
			dom.append(summary, dom.$('.chipos-org-permission', undefined, this._describePermissions(scopes, role)));

			// ── Switch control (only when there's more than one org to pick) ──
			if (this._orgsCache.length > 1) {
				this._renderSwitchControl(body, refreshStore, this._orgsCache, currentOrgId);
			}
		};

		refresh();

		this._disposables.add(this._tokenManager.onDidChangeToken(refresh));
		this._disposables.add(this._tokenManager.onDidChangeUser(refresh));
	}

	/** Fetch the org membership list once, guarding against stale/overlapping responses. */
	private _loadOrgs(onLoaded: () => void): void {
		const generation = ++this._orgsFetchGeneration;
		this._authService.getMyOrgs().then(orgs => {
			if (generation !== this._orgsFetchGeneration) {
				return; // a newer login/refresh superseded this fetch
			}
			this._orgsCache = orgs;
			onLoaded();
		}).catch(() => {
			if (generation !== this._orgsFetchGeneration) {
				return;
			}
			this._orgsCache = [];
			onLoaded();
		});
	}

	private _renderSwitchControl(
		parent: HTMLElement,
		store: DisposableStore,
		orgs: IChipOSOrgSummary[],
		currentOrgId: string | undefined,
	): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.org.switch', 'Switch Organization')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.org.switch.desc', 'Switching your active organization changes your permissions on the next conversation.')));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		// macOS uses the native <select>, which renders only `text` (no decoratorRight /
		// description), so the role is baked into the option label to stay legible there.
		const options: ISelectOptionItem[] = orgs.map(o => ({ text: `${o.name} · ${o.role}` }));
		let activeIndex = orgs.findIndex(o => o.org_id === currentOrgId);
		if (activeIndex < 0) {
			activeIndex = 0;
		}
		const selectBox = store.add(new SelectBox(options, activeIndex, this._contextViewProvider!, defaultSelectBoxStyles));
		selectBox.render(selectContainer);

		// Switch feedback lives below the row; cleared when the section rebuilds.
		const status = dom.append(parent, dom.$('.chipos-org-switch-status'));
		status.style.display = 'none';

		store.add(selectBox.onDidSelect(async e => {
			const target = orgs[e.index];
			if (!target || target.org_id === currentOrgId) {
				return;
			}
			status.style.display = '';
			status.classList.remove('error');
			status.textContent = localize('chipos.org.switching', 'Switching to {0}…', target.name);
			const result = await this._authService.switchOrg(target.org_id);
			if (result) {
				// Success: updateAccessToken fired onDidChangeToken → the section
				// refresh re-renders with the new org/role/permissions and re-selects.
				return;
			}
			status.classList.add('error');
			status.textContent = localize('chipos.org.switchFailed', 'Could not switch organization. Please try again.');
			selectBox.select(activeIndex); // revert to the still-active org
		}));
	}

	/** One-line permission summary derived from the JWT scopes (authoritative), with a role fallback. */
	private _describePermissions(scopes: string[], role: string): string {
		const canWriteRtl = scopes.length > 0
			? scopes.includes('rtl.write')
			: (role === 'owner' || role === 'admin');
		return canWriteRtl
			? localize('chipos.org.perm.write', 'You can create and modify RTL, and run all analysis tools (simulation, lint, PPA, review).')
			: localize('chipos.org.perm.readonly', 'Read-only RTL — you can run simulations, lint, PPA and review, but cannot modify RTL.');
	}

	private _renderToggle(parent: HTMLElement, key: string, label: string, description: string): void {
		const row = dom.append(parent, dom.$('.chipos-toggle-row'));
		const info = dom.append(row, dom.$('.chipos-toggle-info'));
		dom.append(info, dom.$('.chipos-setting-label', undefined, label));
		dom.append(info, dom.$('.chipos-setting-description', undefined, description));

		const toggle = dom.append(row, dom.$('.chipos-toggle-switch'));
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-label', label);
		toggle.tabIndex = 0;

		const input = dom.append(toggle, dom.$<HTMLInputElement>('input'));
		input.type = 'checkbox';
		const initialChecked = this._configurationService.getValue<boolean>(key) ?? false;
		input.checked = initialChecked;
		toggle.setAttribute('aria-checked', String(initialChecked));
		dom.append(toggle, dom.$('.chipos-toggle-slider'));

		const updateValue = (checked: boolean) => {
			input.checked = checked;
			toggle.setAttribute('aria-checked', String(checked));
			this._configurationService.updateValue(key, checked, ConfigurationTarget.USER);
		};

		this._disposables.add(dom.addDisposableListener(input, 'change', () => {
			toggle.setAttribute('aria-checked', String(input.checked));
			this._configurationService.updateValue(key, input.checked, ConfigurationTarget.USER);
		}));

		this._disposables.add(dom.addDisposableListener(toggle, 'keydown', (e: KeyboardEvent) => {
			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				updateValue(!input.checked);
			}
		}));
	}

	private _renderLogLevel(parent: HTMLElement): void {
		const row = dom.append(parent, dom.$('.chipos-setting-row'));
		dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.general.logLevel', 'ChipOS Log Level')));
		dom.append(row, dom.$('.chipos-setting-description', undefined,
			localize('chipos.general.logLevel.desc', 'Set the verbosity of ChipOS-specific logging output.')));

		const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
		const options: ISelectOptionItem[] = LOG_LEVELS.map(l => ({ text: l.charAt(0).toUpperCase() + l.slice(1) }));
		const current = this._configurationService.getValue<string>('chipos.logLevel') || 'info';
		const selectedIndex = Math.max(0, LOG_LEVELS.indexOf(current));

		const selectBox = this._disposables.add(new SelectBox(options, selectedIndex, this._contextViewProvider!, defaultSelectBoxStyles));
		selectBox.render(selectContainer);

		this._disposables.add(selectBox.onDidSelect(e => {
			if (e.index < LOG_LEVELS.length) {
				this._configurationService.updateValue('chipos.logLevel', LOG_LEVELS[e.index], ConfigurationTarget.USER);
			}
		}));
	}
}
