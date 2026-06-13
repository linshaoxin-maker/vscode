/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  orgSwitchClient — pure HTTP for active-org switching (no DI / DOM; SDK-extractable).
 *
 *  ChipOSAuthService wraps these with the token manager (it sources the websiteUrl
 *  + the access_token, and applies the returned token via `updateAccessToken`).
 *  Keeping the request/response shaping here — free of workbench services — makes
 *  it unit-testable and reusable by the future shared TS client SDK. Mirrors
 *  vscode-extension/src/auth/orgSwitchClient.ts.
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
