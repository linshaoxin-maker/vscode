/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/auth/orgSwitchClient.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Canonical org wire client — pure HTTP for active-org switching + org member/
 * invite management. NO editor / fs / DI / DOM deps → the one source the three
 * surfaces (IDE / extension / CLI) vendor.
 *
 * SSOT for the endpoints = chiops `backend/app/auth/router.py` + `orgs` router.
 * Collapses three near-identical hand copies:
 *   - vscode/…/chipos/browser/auth/orgSwitchClient.ts   (IChipOS* names)
 *   - vscode-extension/src/auth/orgSwitchClient.ts       (plain names — this file mirrors it)
 *   - chipos-cli/src/host/auth/orgClient.ts              (subset + fetchFn/timeout injection)
 *
 * R1 (security): switching an org is a server-issued TOKEN SWAP — the request
 * body carries only `org_id`; the new JWT's org + scopes are server-derived
 * (chiops `compute_user_authz`). The client NEVER self-reports org/scopes; it
 * just stores the returned token + uses it as the next Bearer. Member/invite
 * mutations are admin/owner gated server-side (403 otherwise) — surfaces hide
 * the UI for plain members but must not rely on that for security.
 *
 * Injectable `opts.fetchFn` (defaults to global fetch) + `opts.timeoutMs`
 * (default 15s — an auth call must not hang forever) keep it unit-testable and
 * give every surface the CLI's original request hardening.
 */

export interface OrgSummary {
	org_id: string;
	name: string;
	/** Per-org role: owner | admin | member (drives scopes; member has no rtl.write). */
	role: string;
}

export interface SwitchOrgResult {
	access_token: string;
	active_org_id: string;
	role: string;
}

export interface OrgMember {
	user_id: string;
	email: string;
	display_name: string | null;
	/** Per-org role: owner | admin | member. */
	role: string;
	joined_at?: string | null;
}

export interface OrgInvite {
	id: string;
	role: string;
	invited_by_email: string;
	expires_at: string;
	accepted: boolean;
	accepted_at?: string | null;
}

export interface InviteCreated {
	invite_id: string;
	/** Raw single-use token — shown exactly once at create time. */
	invite_token: string;
	accept_url: string;
	role: string;
	expires_at: string;
}

/** Injectable request knobs (tests stub `fetchFn`; every call gets a timeout). */
export interface OrgWireOptions {
	fetchFn?: typeof fetch;
	/** Per-request timeout in ms. Default 15_000 — an auth call must not hang. */
	timeoutMs?: number;
}

function base(websiteUrl: string): string {
	return websiteUrl.replace(/\/+$/, '');
}

function bearer(accessToken: string): Record<string, string> {
	return { Authorization: `Bearer ${accessToken}` };
}

function jsonBearer(accessToken: string): Record<string, string> {
	return { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };
}

function signal(opts?: OrgWireOptions): AbortSignal {
	return AbortSignal.timeout(opts?.timeoutMs ?? 15_000);
}

// ── Active-org switching (`/api/auth/*`) ──────────────────────────────────

/** GET /api/auth/my-orgs — the orgs the signed-in user belongs to (+ their role). `[]` on any non-2xx. */
export async function fetchMyOrgs(websiteUrl: string, accessToken: string, opts?: OrgWireOptions): Promise<OrgSummary[]> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/auth/my-orgs`, { headers: bearer(accessToken), signal: signal(opts) });
	if (!resp.ok) {
		return [];
	}
	const data = (await resp.json().catch(() => ({}))) as { orgs?: OrgSummary[] };
	return Array.isArray(data?.orgs) ? data.orgs : [];
}

/**
 * POST /api/auth/switch-org {org_id} — re-issue an access_token scoped to `orgId`.
 * Returns `undefined` on failure (e.g. 403 when the user isn't a member) or when
 * the response carries no token — the caller must then NOT swap the current token.
 */
export async function postSwitchOrg(
	websiteUrl: string,
	accessToken: string,
	orgId: string,
	opts?: OrgWireOptions,
): Promise<SwitchOrgResult | undefined> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/auth/switch-org`, {
		method: 'POST',
		headers: jsonBearer(accessToken),
		body: JSON.stringify({ org_id: orgId }),
		signal: signal(opts),
	});
	if (!resp.ok) {
		return undefined;
	}
	const data = (await resp.json().catch(() => ({}))) as Partial<SwitchOrgResult>;
	if (!data?.access_token) {
		return undefined;
	}
	return { access_token: data.access_token, active_org_id: data.active_org_id ?? orgId, role: data.role ?? '' };
}

// ── Members + invites (org management; `/api/orgs/{orgId}/*`) ──────────────
// Reads (member list) are open to any member; mutations (role/remove/invite)
// are admin/owner only and 403 server-side. Surfaces mirror that gate in the UI
// but never rely on it for security — the server is authoritative.

/** GET /api/orgs/{orgId}/members — any member may list. */
export async function fetchOrgMembers(websiteUrl: string, accessToken: string, orgId: string, opts?: OrgWireOptions): Promise<OrgMember[]> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/orgs/${encodeURIComponent(orgId)}/members`, { headers: bearer(accessToken), signal: signal(opts) });
	if (!resp.ok) {
		return [];
	}
	const data = (await resp.json().catch(() => null)) as OrgMember[] | null;
	return Array.isArray(data) ? data : [];
}

/** PATCH /api/orgs/{orgId}/members/{userId} {role} — admin/owner only. Returns true on success. */
export async function patchOrgMemberRole(websiteUrl: string, accessToken: string, orgId: string, userId: string, role: string, opts?: OrgWireOptions): Promise<boolean> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: 'PATCH',
		headers: jsonBearer(accessToken),
		body: JSON.stringify({ role }),
		signal: signal(opts),
	});
	return resp.ok;
}

/** DELETE /api/orgs/{orgId}/members/{userId} — admin/owner only. Returns true on success. */
export async function deleteOrgMember(websiteUrl: string, accessToken: string, orgId: string, userId: string, opts?: OrgWireOptions): Promise<boolean> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: 'DELETE',
		headers: bearer(accessToken),
		signal: signal(opts),
	});
	return resp.ok;
}

/** POST /api/orgs/{orgId}/invites {role, expires_in_days} — admin/owner only. Token returned once. */
export async function createOrgInvite(websiteUrl: string, accessToken: string, orgId: string, role: string, expiresInDays: number, opts?: OrgWireOptions): Promise<InviteCreated | undefined> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/orgs/${encodeURIComponent(orgId)}/invites`, {
		method: 'POST',
		headers: jsonBearer(accessToken),
		body: JSON.stringify({ role, expires_in_days: expiresInDays }),
		signal: signal(opts),
	});
	if (!resp.ok) {
		return undefined;
	}
	const data = (await resp.json().catch(() => ({}))) as Partial<InviteCreated>;
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
export async function fetchOrgInvites(websiteUrl: string, accessToken: string, orgId: string, opts?: OrgWireOptions): Promise<OrgInvite[]> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/orgs/${encodeURIComponent(orgId)}/invites`, { headers: bearer(accessToken), signal: signal(opts) });
	if (!resp.ok) {
		return [];
	}
	const data = (await resp.json().catch(() => null)) as OrgInvite[] | null;
	return Array.isArray(data) ? data : [];
}

/** DELETE /api/orgs/{orgId}/invites/{inviteId} — admin/owner only. Returns true on success. */
export async function deleteOrgInvite(websiteUrl: string, accessToken: string, orgId: string, inviteId: string, opts?: OrgWireOptions): Promise<boolean> {
	const fetchFn = opts?.fetchFn ?? fetch;
	const resp = await fetchFn(`${base(websiteUrl)}/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`, {
		method: 'DELETE',
		headers: bearer(accessToken),
		signal: signal(opts),
	});
	return resp.ok;
}
