/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { SshConnection, SshConnectionOptions, ReconnectState } from './sshConnection';
import { ServerManager } from './serverManager';
import { WorkerManager } from './workerManager';
import { getProductInfo, getWorkerInstallPath } from './download';

/**
 * Resolve the Worker → Reasoner gRPC API key with the same fallback chain
 * the workbench uses (settings > product.json > legacy backend.token).
 * Centralized here so both ChipOSSSHResolver and `ensureRemoteWorker` agree.
 */
function resolveWorkerApiKey(): string {
	const cfg = vscode.workspace.getConfiguration('chipos');
	const fromSettings = cfg.get<string>('worker.apiKey');
	if (fromSettings) { return fromSettings; }
	const fromProduct = getProductInfo().chiposDefaults.workerApiKey;
	if (fromProduct) { return fromProduct; }
	const legacy = cfg.get<string>('backend.token');
	return legacy || '';
}

/**
 * Phase 1.5: ask the workbench to mint a Worker JWT.
 *
 * The auth service lives in the workbench renderer; this UI extension can't
 * import it directly, so we go through `vscode.commands.executeCommand`.
 * The command is registered in `workbench/contrib/chipos/common/chiposContribution.ts`.
 *
 * Returns empty string on any failure (user not logged in, website unreachable,
 * workbench contribution not loaded yet at resolve() time, etc.) — caller
 * gracefully falls back to the legacy static apiKey path.
 */
interface WorkerTokenMint {
	worker_token: string;
	/** Seconds until expiry as reported by the website (best-effort hint;
	 *  the real exp is in the JWT payload). */
	expires_in?: number;
}

async function resolveWorkerToken(): Promise<string> {
	const result = await mintWorkerToken();
	return result?.worker_token ?? '';
}

/** Same as resolveWorkerToken but returns the full mint object so callers
 *  scheduling auto-refresh can consult `expires_in` as a fallback when the
 *  JWT lacks an `exp` claim. */
async function mintWorkerToken(): Promise<WorkerTokenMint | undefined> {
	try {
		const result = await vscode.commands.executeCommand<WorkerTokenMint | undefined>(
			'chipos.auth.getWorkerToken',
		);
		if (result?.worker_token) {
			return result;
		}
		return undefined;
	} catch (err) {
		log(`[ChipOS Auth] mint worker_token failed (will fall back to apiKey): ${err}`);
		return undefined;
	}
}

/**
 * P3-D: parse the `exp` claim from a JWT (in seconds since epoch) and return
 * milliseconds-since-epoch. Returns 0 on any parse failure — caller should
 * fall back to the website-reported `expires_in` hint, or assume 0 (= refresh
 * immediately on next tick) if neither is available.
 *
 * No signature verification — that's Reasoner's job. We only read the exp
 * claim for refresh scheduling.
 */
function parseJwtExpMs(token: string): number {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) { return 0; }
		// JWT uses base64url; pad to base64 then decode.
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = b64 + '==='.slice((b64.length + 3) % 4);
		const json = Buffer.from(padded, 'base64').toString('utf-8');
		const exp = JSON.parse(json)?.exp;
		return typeof exp === 'number' ? exp * 1000 : 0;
	} catch {
		return 0;
	}
}

/**
 * B-10: client-side sanity check on a freshly-minted worker_token before we
 * commit to spawning a worker with it.
 *
 * The worker reads `CHIPOS_WORKER_TOKEN` from env at startup. If the token
 * is malformed / already expired / about to expire, the worker registers
 * with Reasoner and gets UNAUTHENTICATED on the next reconnect — looks
 * exactly like "WORKER_UNAVAILABLE" to the user despite the worker process
 * itself being healthy. Catching this client-side lets us fall back to the
 * legacy apiKey path (or surface a clear error if no apiKey configured)
 * instead of spawning a worker that will silently fail in a few seconds.
 *
 * Returns:
 *   'valid'           — token has an exp claim that's at least
 *                       MIN_VALID_REMAINING_MS in the future
 *   'expired'         — exp claim is in the past
 *   'about-to-expire' — exp claim is in the future but within
 *                       MIN_VALID_REMAINING_MS — refresh would fire
 *                       immediately, so don't bother spawning
 *   'malformed'       — couldn't parse as JWT or no exp claim
 *
 * No signature verification (that's Reasoner's job) — we only do
 * structural + temporal checks here.
 */
type WorkerTokenStatus = 'valid' | 'expired' | 'about-to-expire' | 'malformed';

function validateWorkerToken(token: string): WorkerTokenStatus {
	if (!token) { return 'malformed'; }
	const expMs = parseJwtExpMs(token);
	if (expMs === 0) { return 'malformed'; }
	const nowMs = Date.now();
	if (expMs <= nowMs) { return 'expired'; }
	// 5 minutes — generous grace so a clock skew of a few seconds doesn't
	// trip this, but tight enough to catch tokens that would die before
	// the user finishes connecting.
	const MIN_VALID_REMAINING_MS = 5 * 60 * 1000;
	if (expMs - nowMs < MIN_VALID_REMAINING_MS) { return 'about-to-expire'; }
	return 'valid';
}

/**
 * NEW-1: resolve the worker-side MCP servers config path from settings,
 * falling back to the canonical default. Mirrors `resolveWorkerMcpConfigPath`
 * in `vscode/src/.../chiposEndpoints.ts` (kept duplicated because UI extensions
 * can't import workbench code). Returned string MAY contain `~`; expansion
 * happens on the remote — both bash and the worker's own Path(...).expanduser().
 */
function resolveWorkerMcpConfigPath(): string {
	const fromSettings = vscode.workspace.getConfiguration('chipos').get<string>('worker.mcpConfigPath');
	if (fromSettings) { return fromSettings; }
	return '~/.chipos/mcp_servers.json';
}

/**
 * P2-14: ask the workbench to set a per-window runtime URL override.
 *
 * Replaces `cfg.update(..., ConfigurationTarget.Global)` writes that used to
 * leak across windows. The command is registered in workbench
 * `chiposContribution.ts` and writes to a per-window in-memory service —
 * never hits disk, never visible to other windows.
 *
 * Fire-and-forget: failures are logged but don't block the resolver / connect
 * flow. On a workbench build that pre-dates the service the command no-ops
 * silently and the IDE-side resolvers fall through to settings/product/loopback.
 */
function applyRuntimeOverride(key: 'reasoningUrl' | 'workerHttpUrl', value: string, log: (msg: string) => void): void {
	void vscode.commands.executeCommand('chipos.runtime.setOverride', key, value).then(undefined, err => {
		log(`[WARN] runtime.setOverride(${key}) failed: ${err}`);
	});
}

/**
 * NEW-4 helpers: bounded cleanup so disconnect() fits inside VS Code's
 * deactivate budget (~5s) regardless of how many remote sessions are active.
 *
 * `withTimeout` rejects (not resolves) on timeout so the caller logs a
 * specific WARN instead of silently treating a hang as success. The "race"
 * approach intentionally leaks the inner promise — it's about meeting the
 * deactivate deadline, not waiting for full completion.
 */
async function cleanupSession(session: { worker?: WorkerManager; server?: ServerManager }, authority: string): Promise<void> {
	if (session.worker) {
		await session.worker.stopWorker();
	}
	if (session.server) {
		await session.server.stopServer();
	}
	log(`Disconnect for ${authority} done`);
}

/**
 * P3-D: schedule the next worker_token refresh for a session.
 *
 * Refresh happens 30 min before the JWT exp claim, clamped to
 * [60s, 23h] so a misconfigured website can't push the refresh
 * indefinitely far out (and can't spin if the website hands us a
 * just-expired token by accident).
 *
 * Pass `currentToken` so we can read its `exp`. The first call also
 * happens AFTER the worker has spawned successfully — we don't want
 * to refresh a worker that never came up.
 */
function scheduleWorkerTokenRefresh(
	session: RemoteSession,
	authority: string,
	currentToken: string,
	expiresInSecondsHint: number | undefined,
): void {
	if (session.tokenRefreshTimer) {
		clearTimeout(session.tokenRefreshTimer);
		session.tokenRefreshTimer = undefined;
	}
	if (!currentToken) {
		// dev / api_key path — no refresh to schedule.
		return;
	}
	const expEpochMs = parseJwtExpMs(currentToken);
	const nowMs = Date.now();
	const expiresInMs = expEpochMs > 0
		? expEpochMs - nowMs
		: (expiresInSecondsHint ?? 0) * 1000;
	const REFRESH_MARGIN_MS = 30 * 60 * 1000;
	const MIN_DELAY_MS = 60 * 1000;
	const MAX_DELAY_MS = 23 * 60 * 60 * 1000;
	const delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, expiresInMs - REFRESH_MARGIN_MS));
	log(`[ChipOS Auth] worker_token refresh scheduled for ${authority} in ${Math.round(delayMs / 1000)}s`);
	session.tokenRefreshTimer = setTimeout(() => {
		session.tokenRefreshTimer = undefined;
		void runWorkerTokenRefresh(session, authority);
	}, delayMs);
}

async function runWorkerTokenRefresh(session: RemoteSession, authority: string): Promise<void> {
	if (!session.worker) {
		log(`[ChipOS Auth] refresh skipped for ${authority}: no worker on session`);
		return;
	}
	if (!session.reasonerGrpcTarget || !session.workspacePath) {
		log(`[ChipOS Auth] refresh skipped for ${authority}: missing grpcTarget/workspace cache`);
		return;
	}
	log(`[ChipOS Auth] worker_token nearing expiry for ${authority} — minting fresh token`);
	const mint = await mintWorkerToken();
	if (!mint?.worker_token) {
		// Common causes: user signed out, website unreachable, transient 5xx.
		// Reschedule a short retry — don't burn the worker over a transient
		// failure. If it keeps failing, the worker's existing token will
		// still expire and reasoner will UNAUTHENTICATED — but at that point
		// the user seeing the error is the right outcome.
		const RETRY_MS = 60 * 1000;
		log(`[ChipOS Auth] mint failed during refresh — retry in ${RETRY_MS / 1000}s`);
		session.tokenRefreshTimer = setTimeout(() => {
			session.tokenRefreshTimer = undefined;
			void runWorkerTokenRefresh(session, authority);
		}, RETRY_MS);
		return;
	}
	try {
		await session.worker.refreshWorkerToken(mint.worker_token, session.reasonerGrpcTarget, session.workspacePath);
		log(`[ChipOS Auth] worker_token refreshed for ${authority}`);
		// Schedule the NEXT refresh based on the new token's exp.
		scheduleWorkerTokenRefresh(session, authority, mint.worker_token, mint.expires_in);
	} catch (err) {
		log(`[ChipOS Auth][ERROR] worker respawn during token refresh failed: ${err}`);
		// Don't reschedule — the worker is probably in a bad state. User can
		// reload window to recover. Loud-and-actionable rather than a silent
		// retry loop that hides the real problem.
		void vscode.window.showErrorMessage(
			`ChipOS: worker token refresh failed on ${authority}. Tools may stop working when the current token expires. Reload the window to recover.`,
			'Reload Window',
		).then(choice => {
			if (choice === 'Reload Window') {
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, log: (msg: string) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			log(`[WARN] ${label} exceeded ${ms}ms budget — abandoning (worker may leak on remote, will be GC'd on next reconnect)`);
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then(
			val => { clearTimeout(timer); resolve(val); },
			err => { clearTimeout(timer); reject(err); },
		);
	});
}

let outputChannel: vscode.OutputChannel;

interface RemoteSession {
	ssh: SshConnection;
	/** Optional: only set when this extension also deployed/started the REH (chipos-ssh+ flow). */
	server?: ServerManager;
	worker?: WorkerManager;
	/** Synth flag — true when session was created by ensureRemoteWorker for a foreign authority (e.g. ssh-remote+). */
	synth?: boolean;
	/**
	 * P3-D: handle for the worker_token auto-refresh timer. Cleared on
	 * disconnect / refresh-completion / failure-retry. One timer per session
	 * because each session has its own worker process with its own token.
	 */
	tokenRefreshTimer?: NodeJS.Timeout;
	/** Cached for refresh respawn. The grpc target + workspace need to be
	 * re-passed to `ensureWorkerRunning` since `WorkerManager` doesn't cache
	 * them itself. */
	reasonerGrpcTarget?: string;
	workspacePath?: string;
}

const activeSessions = new Map<string, RemoteSession>();
const pendingWorkspacePaths = new Map<string, string>();

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('ChipOS Remote SSH');
	context.subscriptions.push(outputChannel);

	log('ChipOS Remote SSH extension activated');

	// Register the remote authority resolver for 'chipos-ssh' prefix
	// When a URI like vscode-remote://chipos-ssh+user@host/path is opened,
	// this resolver is called to establish the connection.
	const authorityResolver = vscode.workspace.registerRemoteAuthorityResolver(
		'chipos-ssh',
		new ChipOSSSHResolver(context)
	);
	context.subscriptions.push(authorityResolver);

	// ── Commands ──

	context.subscriptions.push(
		vscode.commands.registerCommand('chipos-remote-ssh.connect', () => connectToHost(false)),
		vscode.commands.registerCommand('chipos-remote-ssh.connectInCurrentWindow', () => connectToHost(true)),
		vscode.commands.registerCommand('chipos-remote-ssh.showLog', () => outputChannel.show()),
		vscode.commands.registerCommand('chipos-remote-ssh.disconnect', () => disconnect()),
		vscode.commands.registerCommand('chipos-remote-ssh.ensureRemoteWorker', ensureRemoteWorker),
	);
}

export function deactivate(): Promise<void> {
	return disconnect();
}

// ── Resolver ────────────────────────────────────────────────────────────────

class ChipOSSSHResolver implements vscode.RemoteAuthorityResolver {

	constructor(private readonly _context: vscode.ExtensionContext) { }

	/**
	 * Called by VS Code when it needs to resolve a remote authority.
	 * Authority format: chipos-ssh+user@host
	 *
	 * This method:
	 * 1. Parses the SSH target from the authority
	 * 2. Establishes an SSH connection
	 * 3. Starts ChipOS Server on the remote machine
	 * 4. Returns the resolved authority (host + port + token)
	 */
	async resolve(authority: string, _context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolvedAuthority> {
		log(`Resolving authority: ${authority}`);

		// Parse authority: "chipos-ssh+user@host" → "user@host"
		const sshTarget = parseAuthority(authority);
		if (!sshTarget) {
			throw vscode.RemoteAuthorityResolverError.NotAvailable(
				`Invalid SSH authority: ${authority}. Expected format: chipos-ssh+user@host`,
				true
			);
		}

		log(`SSH target: ${sshTarget}`);

		// Wrap in progress notification so user sees what's happening
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Connecting to ${sshTarget}`,
				cancellable: true,
			},
			async (progress, cancelToken) => {
				let sshConn: SshConnection | undefined;
				let serverMgr: ServerManager | undefined;
				let workerMgr: WorkerManager | undefined;

				try {
				// 1. Establish SSH connection
				progress.report({ message: 'Establishing SSH connection...' });
				const sshOptions = await buildSshOptions(sshTarget);

				// If no key and no agent, ask for password upfront
				if (!sshOptions.privateKeyPath && !process.env.SSH_AUTH_SOCK) {
					const password = await vscode.window.showInputBox({
						prompt: `Enter password for ${sshOptions.username}@${sshOptions.host}`,
						password: true,
					});
					if (!password) {
						throw new Error('Authentication cancelled by user');
					}
					sshOptions.password = password;
					sshOptions.useAgent = false;
				}

				if (cancelToken.isCancellationRequested) {
					throw new Error('Connection cancelled');
				}

				sshConn = new SshConnection(sshOptions, log);
				try {
					await sshConn.connect();
				} catch (firstErr) {
					// Key/agent auth failed — fallback to password
					const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
					if (msg.includes('authentication') || msg.includes('auth')) {
						log(`[SSH] Key/agent auth failed, prompting for password...`);
						sshConn.dispose();
						sshConn = undefined;

						const password = await vscode.window.showInputBox({
							prompt: `Key auth failed. Enter password for ${sshOptions.username}@${sshOptions.host}`,
							password: true,
						});
						if (!password) {
							throw new Error('Authentication cancelled by user');
						}
						sshOptions.password = password;
						sshOptions.privateKeyPath = undefined;
						sshOptions.useAgent = false;

						sshConn = new SshConnection(sshOptions, log);
						await sshConn.connect();
					} else {
						throw firstErr;
					}
				}
				log('SSH connection established');
				attachReconnectNotifier(sshConn, sshConn.host);

				// 2. Start ChipOS Server on remote
				progress.report({ message: 'Starting ChipOS Server on remote...' });
				const installPath = vscode.workspace.getConfiguration('chipos.remote.ssh')
					.get<string>('serverInstallPath', '~/.chipos-server');

				if (cancelToken.isCancellationRequested) {
					throw new Error('Connection cancelled');
				}

				serverMgr = new ServerManager(sshConn, installPath, log);
				const { port, connectionToken } = await serverMgr.ensureServerRunning();
				log(`ChipOS Server running on remote port ${port}`);

				// 3. Create a local TCP tunnel to the remote VS Code Server port
				progress.report({ message: 'Setting up port forwarding...' });
				const localPort = await sshConn.forwardPort(0, '127.0.0.1', port);
				log(`Local port forwarding: 127.0.0.1:${localPort} → remote:${port}`);

				// Note: there is intentionally no "forward Reasoner port" step here.
				// Deployment model A says Reasoner is cloud-hosted and the IDE
				// reaches it directly over the public internet (via product.json's
				// chiposDefaults.reasoningUrl). Only Worker → Reasoner gRPC and
				// IDE → Worker HTTP need to know about the remote — Worker dials
				// Reasoner with its own grpcAddress, IDE → Worker is what we
				// tunnel below in step 5.
				//
				// Earlier builds tried to forward port 8080 + probe a "remote
				// Reasoner /health" here. That assumed an all-in-one self-hosted
				// deployment which is not the supported architecture; it caused
				// "Reasoner not reachable" errors on every connection because the
				// remote box only ran Worker. Removed deliberately.

				// 5. FEAT-R23: Start Worker on remote + forward Worker HTTP port
				progress.report({ message: 'Starting Execution Worker on remote...' });
				log('[Step 5] Starting Worker deployment...');
				const workerInstallPath = getWorkerInstallPath();
				log(`[Step 5] workerInstallPath=${workerInstallPath}`);
				const reasonerGrpcTarget = resolveReasonerGrpcTarget();
				log(`[Step 5] reasonerGrpcTarget=${reasonerGrpcTarget}`);
				// Worker → Reasoner gRPC auth.
				// Phase 1.5: try to mint a Worker JWT via workbench (OAuth-vended).
				// If user is logged in this gives us a signed token; otherwise we fall
				// back to the static apiKey (settings > product.json > legacy backend.token).
				const wmApiKey = resolveWorkerApiKey();
				const wmTokenMint = await mintWorkerToken();
				const wmRawToken = wmTokenMint?.worker_token ?? '';
				const wmTokenStatus = validateWorkerToken(wmRawToken);
				// B-10: don't pass an obviously-bad token through to spawn — it would
				// land the worker in a UNAUTHENTICATED loop right after registration
				// and look identical to "worker crashed" to the user. Drop it and
				// let the apiKey fallback kick in (or fail-fast below if neither
				// path has a usable credential).
				const wmToken = wmTokenStatus === 'valid' ? wmRawToken : '';
				if (wmRawToken && wmTokenStatus !== 'valid') {
					log(`[Step 5][WARN] minted worker_token is ${wmTokenStatus} — dropping, falling back to apiKey path`);
				}
				const wmTls = vscode.workspace.getConfiguration('chipos.backend').get<boolean>('tlsEnabled') ?? false;
				const wmMcpConfig = resolveWorkerMcpConfigPath();
				log(`[Step 5] worker auth: workerToken=${wmToken ? 'set (valid)' : `unset (${wmTokenStatus})`}, apiKey=${wmApiKey ? 'set' : 'unset'}, tls=${wmTls}, mcpConfig=${wmMcpConfig}`);
				if (!wmToken && !wmApiKey) {
					// Hard fail-fast: Reasoner with auth enabled rejects ALL worker
					// connects without credentials, and the user has no way to know
					// from the worker process logs alone. Surface clearly here so
					// they know to log in or set chipos.worker.apiKey.
					log(`[Step 5][ERROR] no worker auth credential available (token=${wmTokenStatus}, no apiKey) — refusing to spawn worker`);
					void vscode.window.showErrorMessage(
						`ChipOS: cannot start Worker on ${sshTarget}. ` +
						'No valid auth credential — please run "ChipOS: Login" first, ' +
						'or set `chipos.worker.apiKey` in Settings if your deployment uses a static key.',
						'Sign In', 'Open Settings',
					).then(choice => {
						if (choice === 'Sign In') {
							void vscode.commands.executeCommand('chipos.auth.login');
						} else if (choice === 'Open Settings') {
							void vscode.commands.executeCommand('workbench.action.openSettings', 'chipos.worker.apiKey');
						}
					});
					// Continue resolving the SSH authority — chat won't work but at
					// least file editing on the remote does. Worker spawn will be
					// retried on next reload window.
				}
				workerMgr = new WorkerManager(sshConn, workerInstallPath, log, wmApiKey, wmTls, wmToken, wmMcpConfig);
				let resolvedWorkspacePath: string | undefined;
				try {
					const folders = vscode.workspace.workspaceFolders;
					const remoteWorkspacePath =
						pendingWorkspacePaths.get(authority)
						|| (folders && folders.length > 0 ? folders[0].uri.path : undefined);
					pendingWorkspacePaths.delete(authority);
					resolvedWorkspacePath = remoteWorkspacePath;
					log(`[Step 5] remoteWorkspacePath=${remoteWorkspacePath}`);
					await workerMgr.ensureWorkerRunning(reasonerGrpcTarget, remoteWorkspacePath);
					log('[Step 5] Execution Worker started on remote');

					const workerHttpPort = vscode.workspace.getConfiguration('chipos.backend')
						.get<number>('workerHttpPort', 8081);
					try {
						const localWorkerPort = await sshConn.forwardPort(0, '127.0.0.1', workerHttpPort);
						log(`[Step 5] Worker HTTP port forwarding: 127.0.0.1:${localWorkerPort} → remote:${workerHttpPort}`);
					if (localWorkerPort !== workerHttpPort) {
						// P2-14: see comment on reasoningUrl override above.
						applyRuntimeOverride('workerHttpUrl', `http://127.0.0.1:${localWorkerPort}`, log);
					}
					} catch (fwdErr) {
						log(`[Step 5][WARN] Could not forward worker HTTP port: ${fwdErr}`);
						vscode.window.showWarningMessage(
							`ChipOS: Failed to forward Worker HTTP port ${workerHttpPort}. Remote execution UI may not work.`);
					}
				} catch (workerErr) {
					const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
					log(`[Step 5][ERROR] Worker start failed: ${workerMsg}`);
					// P0-1: Worker failure is NOT silently non-fatal anymore.
					// The previous "Chat still works" wording was misleading: any tool
					// call (read_file, write_file, run_command, …) will fail with
					// WORKER_UNAVAILABLE — which is what users typically run into a
					// minute after connecting. Make it loud and actionable.
					vscode.window.showErrorMessage(
						`ChipOS: Worker failed to start on ${sshTarget}. ` +
						'Tool execution (file ops, terminal, MCP, …) will not work. ' +
						'See "ChipOS Remote SSH" output channel for the underlying error.',
						'View Logs',
						'Retry Connection',
					).then(choice => {
						if (choice === 'View Logs') {
							outputChannel.show();
						} else if (choice === 'Retry Connection') {
							vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
				}

				// P1-7: Store per-authority session — multiple remote servers can coexist
				const session: RemoteSession = {
					ssh: sshConn,
					server: serverMgr,
					worker: workerMgr,
					reasonerGrpcTarget,
					workspacePath: resolvedWorkspacePath,
				};
				activeSessions.set(authority, session);

				// P3-D: schedule worker_token auto-refresh. No-op when wmToken is
				// empty (api_key path). Done last so `session` is in the map and the
				// timer callback can find it again.
				if (wmToken) {
					scheduleWorkerTokenRefresh(session, authority, wmToken, wmTokenMint?.expires_in);
				}

				return new vscode.ResolvedAuthority('127.0.0.1', localPort, connectionToken);

			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log(`Resolution failed: ${message}`);

				// Clean up on failure — only this authority's resources
				if (sshConn) {
					sshConn.dispose();
				}

				if (message.includes('cancelled')) {
					throw vscode.RemoteAuthorityResolverError.NotAvailable('Connection cancelled', true);
				}
				if (message.includes('ECONNREFUSED') || message.includes('timeout')) {
					throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(
						`Cannot connect to ${sshTarget}: ${message}`
					);
				}

				throw vscode.RemoteAuthorityResolverError.NotAvailable(
					`SSH connection failed: ${message}`,
					true
				);
			}
			}
		);
	}

	/**
	 * P3-A: tunnelFactory and getCanonicalURI are declared as optional members
	 * on `vscode.RemoteAuthorityResolver`. The class doesn't override them —
	 * VS Code defaults to the built-in tunneling and a no-op canonicalization,
	 * which is exactly what this extension wants. The previous `tunnelFactory?: vscode.TunnelFactory`
	 * stub referenced a type that doesn't exist in vscode-dts (the proposed
	 * resolvers.d.ts inlines the function signature on the parent interface);
	 * removing the stub also removes a misleading "this extension owns the
	 * tunnel factory" reading of the source.
	 */
}

// ── Commands ────────────────────────────────────────────────────────────────

async function connectToHost(reuseWindow: boolean): Promise<void> {
	const hosts = await getSshHosts();
	const defaultHost = vscode.workspace.getConfiguration('chipos.remote.ssh')
		.get<string>('defaultHost', '');

	let sshTarget: string | undefined;

	if (hosts.length > 0) {
		// Show QuickPick with existing hosts + manual entry as the FIRST option
		const manualItem: vscode.QuickPickItem = {
			label: '$(edit) Enter host manually...',
			description: '',
			alwaysShow: true,
		};
		const items: vscode.QuickPickItem[] = [
			manualItem,
			...hosts.map(h => ({ label: h, description: 'SSH Host' })),
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select or type a host (e.g. root@192.168.1.1)',
			title: 'ChipOS: Connect via SSH',
		});

		if (!selected) {
			return;
		}
		if (selected === manualItem) {
			sshTarget = undefined; // fall through to input box
		} else {
			sshTarget = selected.label;
		}
	}

	if (!sshTarget) {
		sshTarget = await vscode.window.showInputBox({
			prompt: 'Enter SSH host (e.g. root@192.168.1.1)',
			placeHolder: 'user@hostname',
			value: defaultHost,
		});
	}

	if (!sshTarget) {
		return;
	}

	log(`Connecting to SSH target: ${sshTarget}`);

	const remoteAuthority = `chipos-ssh+${sshTarget}`;

	const folderPath = await vscode.window.showInputBox({
		prompt: 'Enter the remote folder path to open',
		placeHolder: '/root/workspace',
		value: '/root/workspace',
	});

	const effectivePath = folderPath || '/';
	pendingWorkspacePaths.set(remoteAuthority, effectivePath);

	const folderUri = vscode.Uri.parse(`vscode-remote://${remoteAuthority}${effectivePath}`);
	await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: !reuseWindow });
}

/**
 * NEW-4 fix: VS Code awaits the deactivate() promise on a tight budget when
 * the user closes the window — typically ~5s before the extension host is
 * SIGTERMed. The previous sequential per-session loop with default-budget
 * SSH operations (10s flock, 5×500ms wait-for-exit) easily blew that, so
 * `stopWorker` would be killed mid-flight and the worker would leak.
 *
 * New approach:
 *   - Run all sessions' cleanup in PARALLEL via allSettled (one slow session
 *     can't starve the others).
 *   - Wrap each session's cleanup in a hard timeout. If the SSH layer hangs,
 *     we fall through to disposing the ssh connection, which interrupts any
 *     pending `ssh.exec` and frees local resources.
 *   - On the remote side a stale ref_count is a best-effort leak; the worker
 *     binary's instance-staleness detector will GC it on next IDE attach
 *     (fold into the existing "PID alive?" check at acquire time — see
 *     readInstanceJson + isPidAlive in the REH service).
 */
const DISCONNECT_PER_SESSION_BUDGET_MS = 3500;

/**
 * Surface SSH auto-reconnect progress as VS Code notifications so the user
 * doesn't have to watch the SSH output channel for transient drops. Skips the
 * very first attempt to avoid noisy toasts on quick blip recoveries; only fires
 * once per scheduled attempt from attempt #2 onwards. On final give-up, offers
 * "Show Logs" / "Reconnect" buttons.
 */
function attachReconnectNotifier(sshConn: SshConnection, host: string): void {
	sshConn.onReconnectState = (state: ReconnectState): void => {
		switch (state.kind) {
			case 'attempting':
				if (state.attempt >= 2) {
					void vscode.window.showInformationMessage(
						`ChipOS Remote (${host}): reconnecting (${state.attempt}/${state.max})…`,
					);
				}
				break;
			case 'succeeded':
				if (state.afterAttempts > 0) {
					void vscode.window.showInformationMessage(
						`ChipOS Remote (${host}): reconnected.`,
					);
				}
				break;
			case 'gaveUp': {
				const showLogs = 'Show Logs';
				const reconnect = 'Reconnect';
				const detail = state.lastError ? ` Last error: ${state.lastError}` : '';
				void vscode.window.showErrorMessage(
					`ChipOS Remote (${host}): lost connection after ${state.afterAttempts} attempts.${detail}`,
					showLogs,
					reconnect,
				).then(action => {
					if (action === showLogs) {
						outputChannel.show();
					} else if (action === reconnect) {
						void vscode.commands.executeCommand('chipos-remote-ssh.connect');
					}
				});
				break;
			}
		}
	};
}

async function disconnect(): Promise<void> {
	// Snapshot the map so the parallel cleanups can't race against
	// activeSessions.clear() below.
	const sessions = Array.from(activeSessions.entries());
	activeSessions.clear();

	const cleanupPromises = sessions.map(async ([authority, session]) => {
		log(`Disconnecting ${authority}...`);
		// P3-D: cancel pending token refresh first so it can't fire mid-cleanup
		// and re-spawn a worker we're trying to tear down.
		if (session.tokenRefreshTimer) {
			clearTimeout(session.tokenRefreshTimer);
			session.tokenRefreshTimer = undefined;
		}
		try {
			await withTimeout(
				cleanupSession(session, authority),
				DISCONNECT_PER_SESSION_BUDGET_MS,
				`disconnect-${authority}`,
				log,
			);
		} catch (err) {
			log(`[WARN] Cleanup error for ${authority}: ${err}`);
		}
		// Always dispose SSH last — even if stopWorker timed out, this ensures
		// the local socket and forwarded ports are released so a reconnect
		// won't EADDRINUSE on the same local ephemeral port.
		try { session.ssh.dispose(); } catch (e) { log(`[WARN] ssh.dispose threw for ${authority}: ${e}`); }
	});
	await Promise.allSettled(cleanupPromises);

	// P1-6 + P2-14: clear the per-window workerHttpUrl runtime override and any
	// stale Global config left over from older builds. Reasoner URL is no
	// longer tunneled (model A) — chat reads product.json directly — so we
	// don't manage it here, only clean up Global writes that pre-date this
	// architectural decision.
	try {
		await vscode.commands.executeCommand('chipos.runtime.clearOverride');
	} catch (err) {
		log(`[WARN] runtime.clearOverride failed: ${err}`);
	}
	const cfg = vscode.workspace.getConfiguration('chipos.backend');
	await cfg.update('reasoningUrl', undefined, vscode.ConfigurationTarget.Global);
	await cfg.update('workerHttpUrl', undefined, vscode.ConfigurationTarget.Global);

	log('Disconnected from all SSH hosts');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseAuthority(authority: string): string | undefined {
	// authority = "chipos-ssh+user@host" or "chipos-ssh+host"
	const prefix = 'chipos-ssh+';
	if (!authority.startsWith(prefix)) {
		return undefined;
	}
	const target = authority.substring(prefix.length);
	return target || undefined;
}

async function buildSshOptions(sshTarget: string): Promise<SshConnectionOptions> {
	// Parse user@host:port
	let user: string | undefined;
	let host: string;
	let port = 22;

	const atIdx = sshTarget.indexOf('@');
	if (atIdx >= 0) {
		user = sshTarget.substring(0, atIdx);
		host = sshTarget.substring(atIdx + 1);
	} else {
		host = sshTarget;
		user = os.userInfo().username;
	}

	const colonIdx = host.indexOf(':');
	if (colonIdx >= 0) {
		port = parseInt(host.substring(colonIdx + 1), 10) || 22;
		host = host.substring(0, colonIdx);
	}

	// Try to find SSH key
	const sshDir = path.join(os.homedir(), '.ssh');
	const keyFiles = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
	let privateKeyPath: string | undefined;
	for (const keyFile of keyFiles) {
		const keyPath = path.join(sshDir, keyFile);
		try {
			const { stat } = await import('fs/promises');
			await stat(keyPath);
			privateKeyPath = keyPath;
			break;
		} catch {
			// Key file doesn't exist, try next
		}
	}

	return { host, port, username: user || '', privateKeyPath };
}

async function getSshHosts(): Promise<string[]> {
	const hosts: string[] = [];

	// Read from SSH config
	const configFile = vscode.workspace.getConfiguration('chipos.remote.ssh')
		.get<string>('configFile', '');
	const sshConfigPath = configFile || path.join(os.homedir(), '.ssh', 'config');

	try {
		const { readFile } = await import('fs/promises');
		const content = await readFile(sshConfigPath, 'utf-8');
		const hostRegex = /^Host\s+(.+)$/gm;
		let match;
		while ((match = hostRegex.exec(content)) !== null) {
			const hostNames = match[1].trim().split(/\s+/);
			for (const h of hostNames) {
				if (!h.includes('*') && !h.includes('?')) {
					hosts.push(h);
				}
			}
		}
	} catch {
		// SSH config not found, that's fine
	}

	// Add default host if configured
	const defaultHost = vscode.workspace.getConfiguration('chipos.remote.ssh')
		.get<string>('defaultHost', '');
	if (defaultHost && !hosts.includes(defaultHost)) {
		hosts.unshift(defaultHost);
	}

	return hosts;
}

/**
 * Resolve the gRPC target address that the remote Worker uses to dial Reasoner.
 *
 * Default architecture is split-machine: Reasoner is centralized (cloud or
 * shared host), Worker is per-user. So this returns a CROSS-NETWORK address
 * unless the deployment is single-server.
 *
 * Priority (must mirror workbench's `resolveReasonerGrpcAddress` in
 * `chiposEndpoints.ts` since the extension cannot import workbench code):
 *   1. Explicit `chipos.backend.grpcAddress`         (e.g. "reasoning.chipos.ai:50051")
 *   2. `product.chiposDefaults.reasonerGrpcAddress`  (build-time injected)
 *   3. Derived from `chipos.backend.reasoningUrl`    (only when non-loopback)
 *   4. `127.0.0.1:<grpcPort>` last-resort same-machine fallback
 */
function resolveReasonerGrpcTarget(): string {
	const cfg = vscode.workspace.getConfiguration('chipos.backend');
	// (1) Explicit setting
	const explicit = cfg.get<string>('grpcAddress', '');
	if (explicit) {
		return explicit;
	}
	// (2) Build-time default
	const productDefault = getProductInfo().chiposDefaults.reasonerGrpcAddress;
	if (productDefault) {
		return productDefault;
	}
	// (3) Derive from reasoningUrl when it's clearly a cross-network URL
	const grpcPort = cfg.get<number>('grpcPort', 50051);
	const reasoningUrl = cfg.get<string>('reasoningUrl', '');
	if (reasoningUrl) {
		try {
			const url = new URL(reasoningUrl);
			const host = url.hostname.toLowerCase();
			if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
				if (url.protocol === 'https:' || url.port === '443') {
					return `${url.hostname}:443`;
				}
				return `${url.hostname}:${grpcPort}`;
			}
		} catch { /* fall through */ }
	}
	// (4) Same-machine fallback
	return `127.0.0.1:${grpcPort}`;
}

function log(message: string): void {
	const timestamp = new Date().toISOString().substring(11, 23);
	outputChannel.appendLine(`[${timestamp}] ${message}`);
}

// ── chipos-remote-ssh.ensureRemoteWorker ────────────────────────────────────
//
// Path-3 / Stage-1: when the user is connected via Microsoft Remote-SSH (or any
// other SSH-based authority that's NOT chipos-ssh+), the ChipOSSSHResolver
// flow doesn't run, so nobody starts the Worker on the remote host.
//
// SidecarManagerElectron invokes this command in that situation. It opens its
// own ssh2 connection (independent of whatever VS Code's tunnel is doing),
// reuses WorkerManager + ref_count for multi-window safety, and forwards the
// Worker HTTP port so the IDE-side Worker Tools panel can talk to it.
//
// Deployment model A: Reasoner is cloud-hosted and reached directly by both
// the IDE (chat) and the Worker (gRPC), so this command does NOT touch the
// Reasoner port — that traffic never traverses the tunnel.
//
// Idempotent: if a synth session already exists for this target, reuse its
// SshConnection / WorkerManager.

interface EnsureRemoteWorkerArgs {
	/** SSH target as `user@host[:port]` (parseable by buildSshOptions). */
	sshTarget: string;
	/** Remote workspace folder (e.g. `/root/workspace`). */
	workspacePath: string;
}

interface EnsureRemoteWorkerResult {
	ok: boolean;
	/** Local URL where the Worker HTTP API is reachable through the SSH tunnel. */
	workerHttpUrl?: string;
	error?: string;
	/** For diagnostics: which strategy ended up running the Worker. */
	strategy?: 'reused-session' | 'fresh-ssh';
}

async function ensureRemoteWorker(args: EnsureRemoteWorkerArgs): Promise<EnsureRemoteWorkerResult> {
	const t0 = Date.now();
	log(`[ChipOS RemoteWorker] command invoked target=${args.sshTarget} ws=${args.workspacePath}`);

	if (!args?.sshTarget) {
		return { ok: false, error: 'Missing sshTarget' };
	}

	const synthAuthority = `ext-remote-ssh+${args.sshTarget}`;
	const existing = activeSessions.get(synthAuthority);

	let sshConn: SshConnection;
	let strategy: 'reused-session' | 'fresh-ssh';

	if (existing && existing.ssh.connected) {
		log('[ChipOS RemoteWorker] strategy=reused-session');
		sshConn = existing.ssh;
		strategy = 'reused-session';
	} else {
		log('[ChipOS RemoteWorker] strategy=fresh-ssh — opening new SshConnection');
		strategy = 'fresh-ssh';
		const sshOptions = await buildSshOptions(args.sshTarget);
		if (!sshOptions.privateKeyPath && !process.env.SSH_AUTH_SOCK) {
			const password = await vscode.window.showInputBox({
				prompt: `ChipOS Worker: enter password for ${sshOptions.username}@${sshOptions.host}`,
				password: true,
			});
			if (!password) {
				return { ok: false, error: 'Authentication cancelled by user' };
			}
			sshOptions.password = password;
			sshOptions.useAgent = false;
		}
		sshConn = new SshConnection(sshOptions, log);
		try {
			await sshConn.connect();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`[ChipOS RemoteWorker][ERROR] SSH connect failed: ${msg}`);
			return { ok: false, error: `SSH connect failed: ${msg}` };
		}
		log(`[ChipOS RemoteWorker] SSH connected elapsed=${Date.now() - t0}ms`);
		attachReconnectNotifier(sshConn, sshConn.host);
	}

	const cfg = vscode.workspace.getConfiguration('chipos.backend');
	const workerHttpPort = cfg.get<number>('workerHttpPort', 8081);

	// Spawn Worker on remote (reuse existing WorkerManager — same logic as
	// ChipOSSSHResolver.resolve() step 5, including ref_count for multi-window).
	const workerInstallPath = getWorkerInstallPath();
	// Worker → Reasoner gRPC dial target. Default split-machine: settings >
	// product.json > derive from reasoningUrl > 127.0.0.1:50051 fallback.
	const reasonerGrpcTarget = resolveReasonerGrpcTarget();
	const wmApiKey = resolveWorkerApiKey();
	const wmTokenMint = await mintWorkerToken();
	const wmRawToken = wmTokenMint?.worker_token ?? '';
	const wmTokenStatus = validateWorkerToken(wmRawToken);
	// B-10: same client-side validation as the resolve() path. Don't pass an
	// already-bad token to spawn; let apiKey fall back if available.
	const wmToken = wmTokenStatus === 'valid' ? wmRawToken : '';
	if (wmRawToken && wmTokenStatus !== 'valid') {
		log(`[ChipOS RemoteWorker][WARN] minted worker_token is ${wmTokenStatus} — dropping, falling back to apiKey path`);
	}
	const wmTls = vscode.workspace.getConfiguration('chipos.backend').get<boolean>('tlsEnabled') ?? false;
	const wmMcpConfig = resolveWorkerMcpConfigPath();
	log(`[ChipOS RemoteWorker] worker auth: workerToken=${wmToken ? 'set (valid)' : `unset (${wmTokenStatus})`}, apiKey=${wmApiKey ? 'set' : 'unset'}, tls=${wmTls}, mcpConfig=${wmMcpConfig}`);
	if (!wmToken && !wmApiKey) {
		log(`[ChipOS RemoteWorker][ERROR] no worker auth credential available (token=${wmTokenStatus}, no apiKey) — refusing to spawn`);
		return {
			ok: false,
			error: `No worker auth credential available. Run "ChipOS: Login" or set chipos.worker.apiKey.`,
			strategy,
		};
	}
	const workerMgr = existing?.worker ?? new WorkerManager(sshConn, workerInstallPath, log, wmApiKey, wmTls, wmToken, wmMcpConfig);
	try {
		await workerMgr.ensureWorkerRunning(reasonerGrpcTarget, args.workspacePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`[ChipOS RemoteWorker][ERROR] Worker spawn failed: ${msg}`);
		return { ok: false, error: `Worker spawn failed: ${msg}`, strategy };
	}
	log(`[ChipOS RemoteWorker] worker running elapsed=${Date.now() - t0}ms`);

	// Forward Worker HTTP. The Worker listens on `workerHttpPort` (default 8081)
	// on remote loopback; the IDE-side Worker Tools panel + HTTP clients dial
	// through the local forwarded port.
	let localWorkerPort = workerHttpPort;
	try {
		localWorkerPort = await sshConn.forwardPort(0, '127.0.0.1', workerHttpPort);
		log(`[ChipOS RemoteWorker] worker forward 127.0.0.1:${localWorkerPort} → remote:${workerHttpPort}`);
	} catch (err) {
		log(`[ChipOS RemoteWorker][WARN] worker port forwarding failed: ${err} — using direct port`);
	}

	const workerHttpUrl = `http://127.0.0.1:${localWorkerPort}`;

	// P2-14: per-window runtime override for workerHttpUrl. Reasoner is NOT
	// tunneled (model A) — chat goes direct to product.json's cloud Reasoner.
	applyRuntimeOverride('workerHttpUrl', workerHttpUrl, log);

	// Track session for cleanup on disconnect.
	const synthSession: RemoteSession = {
		ssh: sshConn,
		worker: workerMgr,
		synth: true,
		reasonerGrpcTarget,
		workspacePath: args.workspacePath,
	};
	activeSessions.set(synthAuthority, synthSession);

	// P3-D: schedule worker_token auto-refresh for the synth session too.
	if (wmToken) {
		scheduleWorkerTokenRefresh(synthSession, synthAuthority, wmToken, wmTokenMint?.expires_in);
	}

	log(`[ChipOS RemoteWorker] DONE strategy=${strategy} totalElapsed=${Date.now() - t0}ms`);
	return { ok: true, workerHttpUrl, strategy };
}
