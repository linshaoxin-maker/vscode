/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  ChipOSOrgService — org member + invite management for the settings Organization tab.
 *
 *  Wraps the pure-HTTP orgSwitchClient member/invite calls with the token manager
 *  (sources websiteUrl + access_token). Active-org *switching* lives on
 *  IChipOSAuthService (it re-issues the token); this service only manages an org's
 *  members + invites and never mutates the local token. All mutations are
 *  admin/owner-gated server-side (403 otherwise) — callers hide the UI for plain
 *  members but must not rely on that for security; the server is authoritative.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChipOSTokenManager } from './chiposTokenManager.js';
import {
	fetchOrgMembers, patchOrgMemberRole, deleteOrgMember,
	createOrgInvite, fetchOrgInvites, deleteOrgInvite,
	type OrgMember as IChipOSOrgMember, type OrgInvite as IChipOSOrgInvite, type InviteCreated as IChipOSInviteCreated,
} from '../chatAgent/statelessInvoke/vendor/auth/orgSwitchClient.js';

export type { OrgMember as IChipOSOrgMember, OrgInvite as IChipOSOrgInvite, InviteCreated as IChipOSInviteCreated } from '../chatAgent/statelessInvoke/vendor/auth/orgSwitchClient.js';

export interface IChipOSOrgService {
	readonly _serviceBrand: undefined;

	/** List the members of an org (any member may read). */
	listMembers(orgId: string): Promise<IChipOSOrgMember[]>;
	/** Change a member's role (admin/owner only). Returns true on success. */
	changeMemberRole(orgId: string, userId: string, role: string): Promise<boolean>;
	/** Remove a member (admin/owner only; cannot remove the owner). Returns true on success. */
	removeMember(orgId: string, userId: string): Promise<boolean>;

	/** List pending/accepted invites (admin/owner only). */
	listInvites(orgId: string): Promise<IChipOSOrgInvite[]>;
	/** Create an invite — returns the one-time token + accept URL (admin/owner only). */
	createInvite(orgId: string, role: string, expiresInDays: number): Promise<IChipOSInviteCreated | undefined>;
	/** Revoke an invite (admin/owner only). Returns true on success. */
	revokeInvite(orgId: string, inviteId: string): Promise<boolean>;
}

export const IChipOSOrgService = createDecorator<IChipOSOrgService>('chipOSOrgService');

export class ChipOSOrgService implements IChipOSOrgService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@ILogService private readonly _logService: ILogService,
	) { }

	private async _ctx(): Promise<{ websiteUrl: string; accessToken: string } | undefined> {
		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		const accessToken = await this._tokenManager.getAccessToken();
		if (!websiteUrl || !accessToken) {
			this._logService.warn('[ChipOS Org] not configured / not logged in');
			return undefined;
		}
		return { websiteUrl, accessToken };
	}

	async listMembers(orgId: string): Promise<IChipOSOrgMember[]> {
		const ctx = await this._ctx();
		if (!ctx) { return []; }
		try {
			return await fetchOrgMembers(ctx.websiteUrl, ctx.accessToken, orgId);
		} catch (err) {
			this._logService.warn('[ChipOS Org] listMembers error:', String(err));
			return [];
		}
	}

	async changeMemberRole(orgId: string, userId: string, role: string): Promise<boolean> {
		const ctx = await this._ctx();
		if (!ctx) { return false; }
		try {
			return await patchOrgMemberRole(ctx.websiteUrl, ctx.accessToken, orgId, userId, role);
		} catch (err) {
			this._logService.warn('[ChipOS Org] changeMemberRole error:', String(err));
			return false;
		}
	}

	async removeMember(orgId: string, userId: string): Promise<boolean> {
		const ctx = await this._ctx();
		if (!ctx) { return false; }
		try {
			return await deleteOrgMember(ctx.websiteUrl, ctx.accessToken, orgId, userId);
		} catch (err) {
			this._logService.warn('[ChipOS Org] removeMember error:', String(err));
			return false;
		}
	}

	async listInvites(orgId: string): Promise<IChipOSOrgInvite[]> {
		const ctx = await this._ctx();
		if (!ctx) { return []; }
		try {
			return await fetchOrgInvites(ctx.websiteUrl, ctx.accessToken, orgId);
		} catch (err) {
			this._logService.warn('[ChipOS Org] listInvites error:', String(err));
			return [];
		}
	}

	async createInvite(orgId: string, role: string, expiresInDays: number): Promise<IChipOSInviteCreated | undefined> {
		const ctx = await this._ctx();
		if (!ctx) { return undefined; }
		try {
			return await createOrgInvite(ctx.websiteUrl, ctx.accessToken, orgId, role, expiresInDays);
		} catch (err) {
			this._logService.warn('[ChipOS Org] createInvite error:', String(err));
			return undefined;
		}
	}

	async revokeInvite(orgId: string, inviteId: string): Promise<boolean> {
		const ctx = await this._ctx();
		if (!ctx) { return false; }
		try {
			return await deleteOrgInvite(ctx.websiteUrl, ctx.accessToken, orgId, inviteId);
		} catch (err) {
			this._logService.warn('[ChipOS Org] revokeInvite error:', String(err));
			return false;
		}
	}
}
