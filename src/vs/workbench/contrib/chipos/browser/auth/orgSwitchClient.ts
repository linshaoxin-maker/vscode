/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  orgSwitchClient — pure HTTP for org switching + management (no DI / DOM; SDK-extractable).
 *
 *  Active-org switching (`/api/auth/*`) is wrapped by ChipOSAuthService (it applies
 *  the re-issued token via `updateAccessToken`). Member + invite management
 *  (`/api/orgs/{orgId}/*`, admin/owner gated server-side) is wrapped by
 *  ChipOSOrgService. Keeping the request/response shaping here — free of workbench
 *  services — makes it unit-testable and reusable by the future shared TS client
 *  SDK. Mirrors vscode-extension/src/auth/orgSwitchClient.ts.
 *--------------------------------------------------------------------------------------------*/

export interface IChipOSOrgSummary {
	readonly org_id: string;
	readonly name: string;
	/** Per-org role: owner | admin | member (drives scopes; member has no rtl.write). */
	readonly role: string;
}

export interface IChipOSSwitchOrgResult {
	readonly access_token: string;
	readonly active_org_id: string;
	readonly role: string;
}

/** GET /api/auth/my-orgs — the orgs the signed-in user belongs to (+ their role). */
export async function fetchMyOrgs(websiteUrl: string, accessToken: string): Promise<IChipOSOrgSummary[]> {
	const resp = await fetch(`${websiteUrl}/api/auth/my-orgs`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!resp.ok) {
		return [];
	}
	const data = await resp.json() as { orgs?: IChipOSOrgSummary[] };
	return Array.isArray(data?.orgs) ? data.orgs : [];
}

/**
 * POST /api/auth/switch-org — re-issue an access_token scoped to `orgId`.
 * Returns `undefined` on failure (e.g. 403 when the user isn't a member) or when
 * the response carries no token — the caller must then NOT swap the current token.
 */
export async function postSwitchOrg(
	websiteUrl: string,
	accessToken: string,
	orgId: string,
): Promise<IChipOSSwitchOrgResult | undefined> {
	const resp = await fetch(`${websiteUrl}/api/auth/switch-org`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({ org_id: orgId }),
	});
	if (!resp.ok) {
		return undefined;
	}
	const data = await resp.json() as Partial<IChipOSSwitchOrgResult>;
	if (!data?.access_token) {
		return undefined;
	}
	return {
		access_token: data.access_token,
		active_org_id: data.active_org_id ?? orgId,
		role: data.role ?? '',
	};
}

// ── Members + invites (org management; `/api/orgs/{orgId}/*`) ──────────────
// Reads (members list) are allowed for any member; mutations (role/remove/
// invite) are admin/owner only and 403 server-side. The IDE mirrors that gate
// in the UI but never relies on it for security — the server is authoritative.

export interface IChipOSOrgMember {
	readonly user_id: string;
	readonly email: string;
	readonly display_name: string | null;
	/** Per-org role: owner | admin | member. */
	readonly role: string;
	readonly joined_at?: string | null;
}

export interface IChipOSOrgInvite {
	readonly id: string;
	readonly role: string;
	readonly invited_by_email: string;
	readonly expires_at: string;
	readonly accepted: boolean;
	readonly accepted_at?: string | null;
}

export interface IChipOSInviteCreated {
	readonly invite_id: string;
	/** Raw single-use token — shown exactly once at create time. */
	readonly invite_token: string;
	readonly accept_url: string;
	readonly role: string;
	readonly expires_at: string;
}

/** GET /api/orgs/{orgId}/members — any member may list. */
export async function fetchOrgMembers(websiteUrl: string, accessToken: string, orgId: string): Promise<IChipOSOrgMember[]> {
	const resp = await fetch(`${websiteUrl}/api/orgs/${encodeURIComponent(orgId)}/members`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!resp.ok) {
		return [];
	}
	const data = await resp.json() as IChipOSOrgMember[] | null;
	return Array.isArray(data) ? data : [];
}

/** PATCH /api/orgs/{orgId}/members/{userId} {role} — admin/owner only. Returns true on success. */
export async function patchOrgMemberRole(websiteUrl: string, accessToken: string, orgId: string, userId: string, role: string): Promise<boolean> {
	const resp = await fetch(`${websiteUrl}/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({ role }),
	});
	return resp.ok;
}

/** DELETE /api/orgs/{orgId}/members/{userId} — admin/owner only. Returns true on success. */
export async function deleteOrgMember(websiteUrl: string, accessToken: string, orgId: string, userId: string): Promise<boolean> {
	const resp = await fetch(`${websiteUrl}/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return resp.ok;
}

/** POST /api/orgs/{orgId}/invites {role, expires_in_days} — admin/owner only. Token returned once. */
export async function createOrgInvite(websiteUrl: string, accessToken: string, orgId: string, role: string, expiresInDays: number): Promise<IChipOSInviteCreated | undefined> {
	const resp = await fetch(`${websiteUrl}/api/orgs/${encodeURIComponent(orgId)}/invites`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({ role, expires_in_days: expiresInDays }),
	});
	if (!resp.ok) {
		return undefined;
	}
	const data = await resp.json() as Partial<IChipOSInviteCreated>;
	if (!data?.invite_token || !data?.accept_url) {
		return undefined;
	}
	return {
		invite_id: data.invite_id ?? '',
		invite_token: data.invite_token,
		accept_url: data.accept_url,
		role: data.role ?? role,
		expires_at: data.expires_at ?? '',
	};
}

/** GET /api/orgs/{orgId}/invites — admin/owner only. */
export async function fetchOrgInvites(websiteUrl: string, accessToken: string, orgId: string): Promise<IChipOSOrgInvite[]> {
	const resp = await fetch(`${websiteUrl}/api/orgs/${encodeURIComponent(orgId)}/invites`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!resp.ok) {
		return [];
	}
	const data = await resp.json() as IChipOSOrgInvite[] | null;
	return Array.isArray(data) ? data : [];
}

/** DELETE /api/orgs/{orgId}/invites/{inviteId} — admin/owner only. Returns true on success. */
export async function deleteOrgInvite(websiteUrl: string, accessToken: string, orgId: string, inviteId: string): Promise<boolean> {
	const resp = await fetch(`${websiteUrl}/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return resp.ok;
}
