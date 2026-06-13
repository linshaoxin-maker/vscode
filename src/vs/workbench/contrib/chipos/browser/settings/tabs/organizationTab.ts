/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  OrganizationTab — the settings panel's Organization tab: current org + active-org
 *  switch, member management (role change / remove), and invites. Member-list reads
 *  are open to any member; mutations are admin/owner only and the server 403s
 *  otherwise — the UI mirrors that gate (hides the controls for plain members) but
 *  never relies on it for security.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { SelectBox, ISelectOptionItem } from '../../../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultSelectBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextViewProvider } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IChipOSTokenManager } from '../../auth/chiposTokenManager.js';
import { IChipOSAuthService, type IChipOSOrgSummary } from '../../auth/chiposAuthService.js';
import { IChipOSOrgService, type IChipOSOrgMember, type IChipOSOrgInvite } from '../../auth/chiposOrgService.js';

const ASSIGNABLE_ROLES = ['member', 'admin']; // owner transfer is intentionally not exposed here
const INVITE_EXPIRY_DAYS = [7, 14, 30];

export class OrganizationTab extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	/** Cleared + rebuilt on every render so SelectBoxes / listeners don't accumulate. */
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _contextViewProvider: IContextViewProvider | undefined;

	/** Bumped each render; async loads check it so a stale fetch can't paint over a newer one. */
	private _generation = 0;
	/** Invite role + expiry chosen in the invite form (persist across re-renders of the form). */
	private _inviteRole = 'member';
	private _inviteExpiryDays = 7;

	constructor(
		private readonly _container: HTMLElement,
		@IContextViewService contextViewService: IContextViewService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@IChipOSAuthService private readonly _authService: IChipOSAuthService,
		@IChipOSOrgService private readonly _orgService: IChipOSOrgService,
	) {
		super();
		this._contextViewProvider = contextViewService ?? undefined;
		this._render();
		this._disposables.add(this._tokenManager.onDidChangeToken(() => this._render()));
		this._disposables.add(this._tokenManager.onDidChangeUser(() => this._render()));
	}

	private _render(): void {
		const gen = ++this._generation;
		this._renderStore.clear();
		dom.clearNode(this._container);

		if (!this._tokenManager.isLoggedIn()) {
			const section = dom.append(this._container, dom.$('.chipos-settings-section'));
			dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.org.title', 'Organization')));
			dom.append(section, dom.$('.chipos-auth-status', undefined,
				localize('chipos.org.signedOut', 'Sign in to view and manage your organization.')));
			return;
		}

		const loading = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(loading, dom.$('.chipos-settings-section-title', undefined, localize('chipos.org.title', 'Organization')));
		dom.append(loading, dom.$('.chipos-auth-status', undefined, localize('chipos.org.loading', 'Loading organization…')));

		void this._loadAndRender(gen);
	}

	private async _loadAndRender(gen: number): Promise<void> {
		const claims = this._tokenManager.getTokenClaims();
		const currentOrgId = claims?.org_id;
		const scopes = claims?.scopes ?? [];

		const orgs = await this._authService.getMyOrgs();
		if (gen !== this._generation) { return; }
		const matched = currentOrgId ? orgs.find(o => o.org_id === currentOrgId) : undefined;
		const role = matched?.role ?? '';
		const canManage = role === 'owner' || role === 'admin';

		const members = currentOrgId ? await this._orgService.listMembers(currentOrgId) : [];
		if (gen !== this._generation) { return; }
		const invites = (canManage && currentOrgId) ? await this._orgService.listInvites(currentOrgId) : [];
		if (gen !== this._generation) { return; }

		dom.clearNode(this._container);
		this._renderCurrentOrg(orgs, matched, currentOrgId, scopes, role);
		this._renderMembers(currentOrgId, members, canManage);
		if (canManage && currentOrgId) {
			this._renderInvites(currentOrgId, invites);
		}
	}

	// ── Current org + switch ─────────────────────────────────────────────
	private _renderCurrentOrg(orgs: IChipOSOrgSummary[], matched: IChipOSOrgSummary | undefined, currentOrgId: string | undefined, scopes: string[], role: string): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.org.title', 'Organization')));
		const body = dom.append(section, dom.$('.chipos-org-section'));

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
		dom.append(summary, dom.$('.chipos-org-permission', undefined, this._describePermissions(scopes, role)));

		if (orgs.length > 1) {
			const row = dom.append(body, dom.$('.chipos-setting-row'));
			dom.append(row, dom.$('.chipos-setting-label', undefined, localize('chipos.org.switch', 'Switch Organization')));
			dom.append(row, dom.$('.chipos-setting-description', undefined,
				localize('chipos.org.switch.desc', 'Switching your active organization changes your permissions on the next conversation.')));
			const selectContainer = dom.append(row, dom.$('.chipos-setting-input-container'));
			const options: ISelectOptionItem[] = orgs.map(o => ({ text: `${o.name} · ${o.role}` }));
			let activeIndex = orgs.findIndex(o => o.org_id === currentOrgId);
			if (activeIndex < 0) { activeIndex = 0; }
			const selectBox = this._renderStore.add(new SelectBox(options, activeIndex, this._contextViewProvider!, defaultSelectBoxStyles));
			selectBox.render(selectContainer);
			this._renderStore.add(selectBox.onDidSelect(async e => {
				const target = orgs[e.index];
				if (!target || target.org_id === currentOrgId) { return; }
				const result = await this._authService.switchOrg(target.org_id);
				if (!result) {
					selectBox.select(activeIndex);
				}
				// success → onDidChangeToken fires → _render() rebuilds the whole tab.
			}));
		}
	}

	// ── Members ──────────────────────────────────────────────────────────
	private _renderMembers(currentOrgId: string | undefined, members: IChipOSOrgMember[], canManage: boolean): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		const header = dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.org.members', 'Members')));
		header.append(dom.$('span.chipos-org-count', undefined, ` (${members.length})`));

		if (members.length === 0) {
			dom.append(section, dom.$('.chipos-auth-status', undefined, localize('chipos.org.noMembers', 'No members to show.')));
			return;
		}

		const list = dom.append(section, dom.$('.chipos-org-member-list'));
		for (const m of members) {
			const row = dom.append(list, dom.$('.chipos-org-member-row'));
			const name = (m.display_name?.trim() || m.email || '?').trim();

			const avatar = dom.append(row, dom.$('.chipos-org-member-avatar'));
			avatar.textContent = name.charAt(0).toUpperCase();

			const info = dom.append(row, dom.$('.chipos-org-member-info'));
			dom.append(info, dom.$('.chipos-org-member-name', undefined, name));
			if (m.email && m.email !== name) {
				dom.append(info, dom.$('.chipos-org-member-email', undefined, m.email));
			}

			const actions = dom.append(row, dom.$('.chipos-org-member-actions'));
			// Owner row, or a viewer without manage rights → role is read-only.
			if (!canManage || m.role === 'owner' || !currentOrgId) {
				const badge = dom.append(actions, dom.$('.chipos-org-role-badge', undefined, m.role));
				badge.dataset.role = m.role;
				continue;
			}

			// Manager view of a non-owner member → role dropdown + remove.
			const roleContainer = dom.append(actions, dom.$('.chipos-org-role-select'));
			const roleOptions: ISelectOptionItem[] = ASSIGNABLE_ROLES.map(r => ({ text: r }));
			let roleIndex = ASSIGNABLE_ROLES.indexOf(m.role);
			if (roleIndex < 0) { roleIndex = 0; }
			const roleSelect = this._renderStore.add(new SelectBox(roleOptions, roleIndex, this._contextViewProvider!, defaultSelectBoxStyles));
			roleSelect.render(roleContainer);
			this._renderStore.add(roleSelect.onDidSelect(async e => {
				const newRole = ASSIGNABLE_ROLES[e.index];
				if (!newRole || newRole === m.role) { return; }
				const ok = await this._orgService.changeMemberRole(currentOrgId, m.user_id, newRole);
				if (ok) {
					this._render();
				} else {
					roleSelect.select(roleIndex);
				}
			}));

			const removeBtn = dom.append(actions, dom.$('button.chipos-org-icon-btn'));
			removeBtn.title = localize('chipos.org.remove', 'Remove from organization');
			removeBtn.setAttribute('aria-label', removeBtn.title);
			dom.append(removeBtn, dom.$('span.codicon.codicon-trash'));
			this._renderStore.add(dom.addDisposableListener(removeBtn, 'click', async () => {
				const confirmed = await this._dialogService.confirm({
					message: localize('chipos.org.removeConfirm', 'Remove {0} from this organization?', name),
					detail: localize('chipos.org.removeDetail', 'They will lose access to this organization until re-invited.'),
					primaryButton: localize('chipos.org.removeYes', 'Remove'),
				});
				if (!confirmed.confirmed) { return; }
				const ok = await this._orgService.removeMember(currentOrgId, m.user_id);
				if (ok) { this._render(); }
			}));
		}
	}

	// ── Invites (admin/owner only) ───────────────────────────────────────
	private _renderInvites(currentOrgId: string, invites: IChipOSOrgInvite[]): void {
		const section = dom.append(this._container, dom.$('.chipos-settings-section'));
		dom.append(section, dom.$('.chipos-settings-section-title', undefined, localize('chipos.org.invites', 'Invites')));

		// ── Create-invite form ──
		const form = dom.append(section, dom.$('.chipos-org-invite-form'));
		const roleContainer = dom.append(form, dom.$('.chipos-org-invite-field'));
		const roleOptions: ISelectOptionItem[] = ASSIGNABLE_ROLES.map(r => ({ text: r }));
		const roleSelect = this._renderStore.add(new SelectBox(roleOptions, Math.max(0, ASSIGNABLE_ROLES.indexOf(this._inviteRole)), this._contextViewProvider!, defaultSelectBoxStyles));
		roleSelect.render(roleContainer);
		this._renderStore.add(roleSelect.onDidSelect(e => { this._inviteRole = ASSIGNABLE_ROLES[e.index] ?? 'member'; }));

		const expiryContainer = dom.append(form, dom.$('.chipos-org-invite-field'));
		const expiryOptions: ISelectOptionItem[] = INVITE_EXPIRY_DAYS.map(d => ({ text: localize('chipos.org.expiryDays', '{0} days', d) }));
		const expirySelect = this._renderStore.add(new SelectBox(expiryOptions, Math.max(0, INVITE_EXPIRY_DAYS.indexOf(this._inviteExpiryDays)), this._contextViewProvider!, defaultSelectBoxStyles));
		expirySelect.render(expiryContainer);
		this._renderStore.add(expirySelect.onDidSelect(e => { this._inviteExpiryDays = INVITE_EXPIRY_DAYS[e.index] ?? 7; }));

		const genBtn = dom.append(form, dom.$('button.chipos-auth-button'));
		genBtn.textContent = localize('chipos.org.generateInvite', 'Generate invite link');
		const result = dom.append(section, dom.$('.chipos-org-invite-result'));
		result.style.display = 'none';

		this._renderStore.add(dom.addDisposableListener(genBtn, 'click', async () => {
			genBtn.setAttribute('disabled', 'true');
			const created = await this._orgService.createInvite(currentOrgId, this._inviteRole, this._inviteExpiryDays);
			genBtn.removeAttribute('disabled');
			if (!created) {
				result.style.display = '';
				result.className = 'chipos-org-invite-result error';
				dom.clearNode(result);
				dom.append(result, dom.$('span', undefined, localize('chipos.org.inviteFailed', 'Could not create invite. Please try again.')));
				return;
			}
			result.style.display = '';
			result.className = 'chipos-org-invite-result';
			dom.clearNode(result);
			dom.append(result, dom.$('.chipos-org-invite-hint', undefined,
				localize('chipos.org.inviteOnce', 'Share this single-use link — it is shown only once:')));
			const linkRow = dom.append(result, dom.$('.chipos-org-invite-link-row'));
			const link = dom.append(linkRow, dom.$<HTMLInputElement>('input.chipos-org-invite-link'));
			link.type = 'text';
			link.readOnly = true;
			link.value = created.accept_url;
			const copyBtn = dom.append(linkRow, dom.$('button.chipos-org-icon-btn'));
			copyBtn.title = localize('chipos.org.copy', 'Copy link');
			copyBtn.setAttribute('aria-label', copyBtn.title);
			dom.append(copyBtn, dom.$('span.codicon.codicon-copy'));
			this._renderStore.add(dom.addDisposableListener(copyBtn, 'click', async () => {
				await this._clipboardService.writeText(created.accept_url);
				link.select();
			}));
			// Refresh the invite list below to include the new row.
			this._render();
		}));

		// ── Existing invites ──
		const pending = invites.filter(i => !i.accepted);
		if (pending.length > 0) {
			const list = dom.append(section, dom.$('.chipos-org-invite-list'));
			for (const inv of pending) {
				const row = dom.append(list, dom.$('.chipos-org-invite-item'));
				const info = dom.append(row, dom.$('.chipos-org-invite-info'));
				const roleBadge = dom.append(info, dom.$('.chipos-org-role-badge', undefined, inv.role));
				roleBadge.dataset.role = inv.role;
				dom.append(info, dom.$('span.chipos-org-invite-meta', undefined,
					localize('chipos.org.invitedBy', 'invited by {0}', inv.invited_by_email || '—')));

				const revokeBtn = dom.append(row, dom.$('button.chipos-org-icon-btn'));
				revokeBtn.title = localize('chipos.org.revoke', 'Revoke invite');
				revokeBtn.setAttribute('aria-label', revokeBtn.title);
				dom.append(revokeBtn, dom.$('span.codicon.codicon-trash'));
				this._renderStore.add(dom.addDisposableListener(revokeBtn, 'click', async () => {
					const ok = await this._orgService.revokeInvite(currentOrgId, inv.id);
					if (ok) { this._render(); }
				}));
			}
		}
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
}
