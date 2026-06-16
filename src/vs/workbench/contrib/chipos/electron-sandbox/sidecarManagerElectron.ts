/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * SidecarManagerElectron — Electron desktop sidecar.
 *
 * Mode resolution (`chipos.backend.mode`, default `auto`):
 *   - workspace is SSH remote (`ssh-remote+` / `chipos-ssh+`)
 *       → Manual (chipos-remote-ssh extension owns remote spawn + tunnels)
 *   - workspace is local AND `reasoningUrl` is non-loopback
 *       → Local (IDE spawns local Worker binary; cache → download → spawn,
 *         Worker connects to remote Reasoner via gRPC)
 *   - workspace is local AND `reasoningUrl` is loopback or absent
 *       → Manual (single-machine dev; user manages everything)
 * Only `developerBuild === true` binaries let end users override the auto
 * decision via the in-IDE Backend Mode picker.
 *
 * Local-mode Worker spawn flow (mirrors chipos-remote-ssh's WorkerManager):
 *   1. Check existing instance (instance.json + PID alive) → acquire ref → done
 *   2. Cache lookup `~/.chipos/workers/*\/chipos-worker-<plat-arch>` → spawn
 *   3. Download from chiposReleases.repo `/releases/latest` → spawn
 *   4. (no Python fallback in Local mode — user installs the binary or uses
 *      Manual + their own Python venv)
 *
 * Multi-window: instance.json + ref_count, IPC handlers in
 * vs/platform/chipos/electron-main/sidecarManagerMain.ts. dispose() releases
 * ref; the worker process only dies when ref_count hits zero.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation, IProgress, IProgressStep } from '../../../../platform/progress/common/progress.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { resolveReasoningUrl, resolveReasonerGrpcAddress, resolveWorkerApiKey, resolveWorkerMcpConfigPath, resolveWorkerHttpUrl } from '../common/chiposEndpoints.js';
import { IChipOSAuthService } from '../browser/auth/chiposAuthService.js';
import { IChipOSRuntimeOverridesService } from '../common/chiposRuntimeOverrides.js';
import {
	ChiposRemoteWorkerChannelName,
	IEnsureRemoteWorkerArgs,
	IEnsureRemoteWorkerResult,
	IReleaseRemoteWorkerArgs,
} from '../../../../platform/chipos/common/chiposRemoteWorker.js';
import {
	ISidecarManagerService,
	IWorkerInstanceMeta,
	SidecarState,
	BackendMode,
	WorkerState,
} from '../common/sidecarService.js';
import { planWorkerAutoRestart } from '../common/workerAutoRestart.js';

export class SidecarManagerElectron extends Disposable implements ISidecarManagerService {

	declare readonly _serviceBrand: undefined;

	// ── Events ───────────────────────────────────────────────────────────

	private readonly _onDidChangeState = this._register(new Emitter<SidecarState>());
	readonly onDidChangeState: Event<SidecarState> = this._onDidChangeState.event;

	private readonly _onDidChangeWorkerState = this._register(new Emitter<WorkerState>());
	readonly onDidChangeWorkerState: Event<WorkerState> = this._onDidChangeWorkerState.event;

	// ── State ────────────────────────────────────────────────────────────

	private _state: SidecarState = SidecarState.NotStarted;
	private _workerState: WorkerState = WorkerState.NotStarted;
	private _mode: BackendMode;
	// FEAT worker self-heal: auto-restart a dropped Local worker with exponential
	// backoff (planWorkerAutoRestart) before falling back to the manual
	// "Worker: Reconnect" button. Reset on Connected, cleared on dispose.
	private _autoRestartAttempts = 0;
	private _autoRestartTimer: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	// Phase 2 Worker JWT auto-refresh: timer fires before the current
	// worker_token expires so we can mint a new one + respawn the Worker
	// before Reasoner starts rejecting on UNAUTHENTICATED.
	private _workerTokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private _refreshingWorkerToken = false;
	// Worker-bootstrap fix: whether the CURRENTLY-running local worker was
	// spawned with a valid worker_token. The onDidChangeLoginState suppression
	// below uses it to tell a spurious startup-restore login flip (worker already
	// has a token -> skip respawn) from a genuine sign-in after a tokenless
	// (logged-out) spawn (worker has no tools -> MUST respawn). Adopted / shared
	// workers keep `true` so a sign-in never kills a worker owned by another window.
	private _workerSpawnedWithToken = false;
	/**
	 * Tracks whether Path-3 Stage-2 RPC was used to spawn the remote Worker.
	 * If set, dispose() must call `releaseWorker` on the same channel so the
	 * REH-side ref_count is decremented (otherwise the Worker leaks on multi-window scenarios).
	 */
	private _rpcSpawnedWorkspaceRoot: string | undefined;
	/**
	 * Workspace root for which we're holding a Local-mode worker ref. Set by
	 * _ensureLocalWorker(); used by stopBackend()/dispose() to release the
	 * ref on the correct workspace key. Multiple windows on the same
	 * workspace share one worker via instance.json ref_count.
	 */
	private _localWorkerWorkspaceRoot: string | undefined;
	/**
	 * Stable caller ID for this window's ref-counting. Generated once at
	 * construction; matched on release so multiple acquires/releases by
	 * different windows don't collide.
	 */
	private readonly _localCallerId: string = `electron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

	/**
	 * Continuous health watcher (2026-05-15). Runs after the initial
	 * registration succeeds; polls every 30s. After 3 consecutive failures
	 * the worker is presumed dead and WorkerState flips to Disconnected so
	 * the status-bar pill stops lying.
	 */
	private _healthWatchTimer: ReturnType<typeof setInterval> | undefined;
	private _healthWatchFailureCount = 0;

	// 2026-05-23: cached "actually-bound" worker HTTP port.
	//
	// Background: `chipos.backend.workerHttpPort` (config) used to equal
	// the worker's actual bound port — the worker bound exactly what
	// --http-port said, no exceptions. The 2026-05-22 port-roll TOCTOU
	// fix (ac0bd277) broke that invariant: on EADDRINUSE the worker
	// falls back to a kernel-assigned port (e.g. 51597 instead of 8081).
	// The actual port is written to instance.json by the worker.
	//
	// Multiple sites in this class previously read the config value as
	// if it were the actual port (workerHttpUrl getter, probe, tools
	// panel base URL, permission SSE base URL, etc). After port-roll
	// fallback fires, all of those silently point at a dead port.
	//
	// Fix: _probeWorkerHealth reads instance.json each probe (1s during
	// observation, 30s during health watch) and stashes the real port
	// here. The synchronous `workerHttpUrl` getter returns this cached
	// value when present, falling back to the config default before the
	// first probe lands or when the worker is intentionally down.
	//
	// Cache invalidation: cleared on stopBackend so a re-spawn doesn't
	// reuse a stale port for the brief window before the next probe.
	private _cachedActualWorkerHttpPort: number | undefined;

	get state(): SidecarState { return this._state; }
	get workerState(): WorkerState { return this._workerState; }
	get mode(): BackendMode { return this._mode; }

	// ── URLs ─────────────────────────────────────────────────────────────

	get reasoningUrl(): string {
		// Three-tier fallback: settings > product.json > loopback.
		//
		// Deployment model A: Reasoner is cloud-hosted (or wherever
		// product.json's chiposDefaults.reasoningUrl points), and the IDE
		// reaches it directly over the public internet. There is intentionally
		// NO per-window runtime override path here — chipos-remote-ssh does
		// not tunnel chat traffic, only Worker HTTP traffic (see workerHttpUrl).
		return resolveReasoningUrl(this._configurationService, this._productService);
	}

	get workerHttpUrl(): string {
		// runtime override > explicit settings — both bypass the derive-from-reasoningUrl
		// path. Fall through to deployment-mode-aware derivation when neither is set.
		const explicit = resolveWorkerHttpUrl(this._configurationService, this._productService, this._runtimeOverrides);
		if (explicit) {
			return explicit;
		}
		// 2026-05-23: prefer the actually-bound port observed via the last
		// instance.json read in _probeWorkerHealth. The config value is
		// only a HINT to the worker (passed via --http-port); the worker
		// may have port-rolled to a kernel-assigned port. See the field
		// declaration of _cachedActualWorkerHttpPort for the full story.
		// Falls back to config when no probe has landed yet (early
		// spawn) or when the user is in REH/Manual mode where the
		// hint is the truth.
		const workerHttpPort = this._cachedActualWorkerHttpPort
			?? this._configurationService.getValue<number>('chipos.backend.workerHttpPort')
			?? 8081;
		if (this._mode === BackendMode.CloudReasoning || this._mode === BackendMode.Local) {
			// CloudReasoning: chipos-remote-ssh forwarded the remote worker HTTP port to local loopback.
			// Local: the worker runs on this machine, also bound to loopback.
			// Both end up at 127.0.0.1:<port>.
			return `http://127.0.0.1:${workerHttpPort}`;
		}
		// Manual mode — derive from the reasoner host the user configured.
		try {
			const url = new URL(this.reasoningUrl);
			return `${url.protocol}//${url.hostname}:${workerHttpPort}`;
		} catch {
			return `http://127.0.0.1:${workerHttpPort}`;
		}
	}

	get grpcAddress(): string {
		// Use the centralized resolver: settings > product.json > derive from
		// reasoningUrl (only when non-loopback) > 127.0.0.1:50051 fallback.
		// Default deployment is split (Reasoner ≠ Worker host) so the loopback
		// fallback is for single-machine dev/testing only.
		return resolveReasonerGrpcAddress(this._configurationService, this._productService);
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	get port(): number { return 0; }
	get wsUrl(): string { return this.reasoningUrl; }

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INativeHostService _nativeHostService: INativeHostService,
		@IEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly _commandService: ICommandService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IProductService private readonly _productService: IProductService,
		@IChipOSAuthService private readonly _authService: IChipOSAuthService,
		@IChipOSRuntimeOverridesService private readonly _runtimeOverrides: IChipOSRuntimeOverridesService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IProgressService private readonly _progressService: IProgressService,
	) {
		super();

		// Provisional mode — final value is computed lazily in startBackend() after
		// auto-detection (workspace authority, port probe). Until then, treat as Auto.
		this._mode = BackendMode.Auto;

		// Phase 2: when the user signs in/out the Worker is now bound to the
		// wrong identity (or none at all). Respawn so the new worker_token
		// (or absence thereof) takes effect immediately instead of after the
		// next 23h refresh cycle. Skipped while no Worker is running yet.
		//
		// 2026-05-20 fix (second layer of onDidChangeLoginState spurious flip):
		// even with the publisher-side gate in chiposAuthService.ts, the FIRST
		// onDidChangeToken after IDE startup can legitimately flip the cached
		// loginState (false -> true) -- which means a real `fire(true)` is
		// emitted even though the user did NOT sign in (their token was just
		// restored from SecretStorage and the first refresh cycle ran). In
		// that case the worker is ALREADY running with the correct identity
		// (we minted its token from the same SecretStorage credentials), so
		// respawning it is pure waste plus 60s+ of UI lag. Track first-event
		// here too: when the worker is already alive and the new state is
		// "logged in", skip respawn.
		let lastSeenLoggedIn: boolean | undefined = undefined;
		this._register(this._authService.onDidChangeLoginState(isLoggedIn => {
			const wasSeen = lastSeenLoggedIn;
			lastSeenLoggedIn = isLoggedIn;
			if (this._workerState === WorkerState.NotStarted) {
				return;
			}
			// First event after listener construction + worker already running
			// + new state is logged-in => this is the startup-restore flow,
			// not a real signin. The worker is already bound to the right
			// identity from the SecretStorage-derived worker_token.
			// Only suppress when the running worker was actually spawned WITH a token
			// (genuine startup-restore). A tokenless spawn (logged out at startup) means
			// this `true` is a real first sign-in and MUST respawn to mint the token.
			if (wasSeen === undefined && isLoggedIn === true && this._workerSpawnedWithToken) {
				this._logService.info('[ChipOS SidecarElectron] initial onDidChangeLoginState(true) with token-bearing worker already running; suppressing startup-flow respawn');
				return;
			}
			this._logService.info('[ChipOS SidecarElectron] login state changed — respawning Worker to refresh identity');
			this._refreshWorkerTokenAndRespawn().catch(err => {
				this._logService.warn('[ChipOS SidecarElectron] respawn-on-login-change failed:', String(err));
			});
		}));

		// P2-14: when chipos-remote-ssh sets a runtime URL override (after port
		// forwarding lands), notify any URL-derived caches downstream. The URL
		// getters consult the override on each read so this only matters for
		// observers that subscribe to a `urlsChanged`-style event — but emit
		// it now so future listeners (HTTP client base, SSE re-subscribe) can
		// hook in without another refactor.
		this._register(this._runtimeOverrides.onDidChangeOverrides(key => {
			this._logService.info(`[ChipOS SidecarElectron] runtime override changed: ${key}=${this._runtimeOverrides.getOverride(key) ?? '(cleared)'}`);
		}));

		this._logService.info('[ChipOS SidecarElectron] constructed, mode will be resolved on startBackend()');
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	async startBackend(): Promise<void> {
		// Path-3 Stage-1: if the workspace is on a foreign Remote-SSH (e.g. Microsoft
		// `ssh-remote+`) where ChipOSSSHResolver never ran, ask the chipos-remote-ssh
		// extension to spawn the Worker on the remote and forward the ports. This
		// MUST happen before _resolveMode() so reasoningUrl is populated when the
		// mode resolver and the health check read config.
		await this._maybeArrangeRemoteWorker();

		this._mode = await this._resolveMode();
		this._logService.info(`[ChipOS SidecarElectron] startBackend() resolved mode=${this._mode}`);

		// Manual: nothing to spawn. Either:
		//   - workspace is remote SSH (chipos-remote-ssh extension owns spawn)
		//   - user explicitly chose manual
		//   - auto-detect found an existing reasoner already serving on the local port
		// In all cases we just verify the reasoning endpoint is reachable.
		if (this._mode === BackendMode.Manual) {
			await this._reasonerOnlyHealthCheck();
			return;
		}

		this._setState(SidecarState.Spawning);

		// Local mode: spawn worker binary on this machine. Reasoner is reached
		// directly via reasoningUrl (cloud or wherever chiposDefaults points).
		// CloudReasoning mode: worker already spawned via _maybeArrangeRemoteWorker;
		// just health-check.
		if (this._mode === BackendMode.Local) {
			try {
				const spawned = await this._ensureLocalWorker();
				if (!spawned) {
					// Deferred (e.g. empty workbench). Health-check the Reasoner
					// only — Worker is intentionally absent. Same code path as
					// Manual mode: reasoner reachable = green-light Chat.
					await this._reasonerOnlyHealthCheck();
					return;
				}
			} catch (err) {
				// Surface the spawn failure as a notification too, not just to
				// the Output panel. Without this the user only ever sees
				// reasoner's downstream "WORKER_UNAVAILABLE" 503 in the chat
				// and has no way to discover the actual cause (download 404 /
				// network blocked / cache permission, etc.). 2026-05-09 fix.
				const msg = err instanceof Error ? err.message : String(err);
				this._logService.error(`[ChipOS SidecarElectron] local worker spawn failed: ${msg}`);
				this._notificationService.notify({
					severity: Severity.Error,
					message: `ChipOS Worker spawn failed — ${msg}`,
					sticky: true,
				});
				this._setState(SidecarState.Error);
				return;
			}
		}

		try {
			await this._healthCheckLoop();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] startBackend failed: ${msg}`);
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * Resolve `chipos.backend.mode`:
	 *   1. developerBuild + explicit value → respect user's choice
	 *   2. Otherwise auto-detect:
	 *      a. workspace is SSH remote → Manual (chipos-remote-ssh / REH owns
	 *         worker spawning + tunnel)
	 *      b. local workspace + non-loopback reasoningUrl → Local
	 *         (IDE spawns worker on this machine; worker connects to remote Reasoner)
	 *      c. fallback → Manual (single-machine dev / no remote reasoner;
	 *         user manages everything)
	 */
	private async _resolveMode(): Promise<BackendMode> {
		const configured = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
		// Build-time flag from product.json (replaces the old runtime
		// `chipos.backend.developerMode` user setting). End-user release builds
		// have this false/absent and chipos.backend.mode is silently ignored.
		const developerBuild = this._productService.chiposDefaults?.developerBuild === true;

		// Developer build override: respect explicit non-auto choice from the
		// in-IDE Backend Mode picker (only rendered when developerBuild=true).
		if (developerBuild && configured !== 'auto' && configured !== '') {
			const forced = this._parseModeOrAuto(configured);
			if (forced !== BackendMode.Auto) {
				this._logService.info(`[ChipOS SidecarElectron] developerBuild=true, forcing mode=${forced}`);
				return forced;
			}
		}

		// Auto-detect path.

		// (a) Remote SSH workspace — let the SSH extension manage the remote backend.
		const remoteAuth = this._detectRemoteAuthority();
		if (remoteAuth) {
			this._logService.info(`[ChipOS SidecarElectron] auto: remote workspace authority='${remoteAuth}', mode=manual`);
			return BackendMode.Manual;
		}

		// (b) Local workspace + non-loopback reasoningUrl → Local mode.
		// Worker runs on this machine (cache → download → spawn) and connects
		// out to the configured Reasoner over gRPC. Without this branch a local
		// IDE has no Worker at all (since SSH extension never activates).
		const reasoningUrl = resolveReasoningUrl(this._configurationService, this._productService);
		if (reasoningUrl && !this._isLoopback(reasoningUrl)) {
			this._logService.info(`[ChipOS SidecarElectron] auto: local workspace + remote reasoningUrl='${reasoningUrl}', mode=local`);
			return BackendMode.Local;
		}

		// (c) Default — Manual. Loopback or empty reasoningUrl, no remote
		// authority: probably single-machine dev with the user running their
		// own Python venv. IDE doesn't try to outsmart that case.
		this._logService.info('[ChipOS SidecarElectron] auto: defaulting to mode=manual');
		return BackendMode.Manual;
	}

	private _parseModeOrAuto(value: string): BackendMode {
		switch (value) {
			case 'local': return BackendMode.Local;
			case 'cloud-reasoning': return BackendMode.CloudReasoning;
			case 'manual': return BackendMode.Manual;
			// Treat any unknown / legacy value as auto so older user settings
			// don't crash the resolver.
			default: return BackendMode.Auto;
		}
	}

	private _detectRemoteAuthority(): string | undefined {
		// 1. INativeEnvironmentService.remoteAuthority (set by VS Code when REH is active).
		const fromEnv = (this._environmentService as { remoteAuthority?: string }).remoteAuthority;
		if (fromEnv) {
			return fromEnv;
		}
		// 2. workspace folder URI authority (e.g. ssh-remote+host, chipos-ssh+host).
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			const auth = folder.uri.authority;
			if (auth && (auth.startsWith('ssh-remote+') || auth.startsWith('chipos-ssh+') || auth.includes('+'))) {
				return auth;
			}
		}
		return undefined;
	}

	/**
	 * Path-3 orchestrator.
	 *
	 * Two strategies, tried in order:
	 *
	 *   A. RPC (Stage-2): if the REH exposes the `chipos-worker` channel
	 *      (i.e. the user is connected to a Stage-2-or-later chipos-server),
	 *      ask REH to spawn the Worker locally. No second SSH connection.
	 *
	 *   B. Command (Stage-1): delegate to the chipos-remote-ssh extension,
	 *      which opens its own ssh2 connection and uses WorkerManager.
	 *      Works regardless of which server is on the remote (vanilla
	 *      VS Code Server, older chipos-server, anything).
	 *
	 * For chipos-ssh+host authorities, ChipOSSSHResolver.resolve() already
	 * spawned the Worker and forwarded the Worker HTTP port, so this is a
	 * no-op.
	 *
	 * For non-remote workspaces this is also a no-op.
	 *
	 * Note (deployment model A): we deliberately do NOT touch reasoningUrl in
	 * any of these paths. Reasoner is reached directly over the public
	 * internet via product.json's chiposDefaults.reasoningUrl; only Worker
	 * HTTP traffic gets tunneled.
	 */
	private async _maybeArrangeRemoteWorker(): Promise<void> {
		const remoteAuth = this._detectRemoteAuthority();
		if (!remoteAuth) {
			return;
		}
		if (remoteAuth.startsWith('chipos-ssh+')) {
			this._logService.info('[ChipOS RemoteWorker] authority=chipos-ssh+ — handled by ChipOSSSHResolver, skipping');
			return;
		}

		// Strategy A: try RPC.
		if (await this._tryEnsureWorkerViaRpc()) {
			return;
		}

		// Strategy B: fall back to chipos-remote-ssh command.
		await this._tryEnsureWorkerViaCommand(remoteAuth);
	}

	/**
	 * Strategy A: probe the chipos-worker channel and call ensureWorker.
	 *
	 * Returns true if the RPC path completed successfully (the IDE can stop
	 * here). False if the channel is missing, errored, or the REH-side
	 * service rejected the request — caller should fall back to Strategy B.
	 */
	private async _tryEnsureWorkerViaRpc(): Promise<boolean> {
		const conn = this._remoteAgentService.getConnection();
		if (!conn) {
			this._logService.info('[ChipOS RemoteWorker] strategy=rpc-skip reason=no-remote-connection');
			return false;
		}

		const t0 = Date.now();
		const folders = this._workspaceContextService.getWorkspace().folders;
		const workspaceRoot = folders[0]?.uri.path ?? '/root/workspace';
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		// Worker → Reasoner gRPC auth: settings > product.json > legacy backend.token.
		const workerApiKey = resolveWorkerApiKey(this._configurationService, this._productService);
		// Worker → Reasoner gRPC dial target. Default architecture is split-machine
		// (Reasoner is centralized, Worker is per-user). Only single-server testing
		// falls back to 127.0.0.1:50051.
		const reasonerGrpcTarget = resolveReasonerGrpcAddress(this._configurationService, this._productService);
		const tlsEnabled = this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false;

		// Phase 1.5 Worker JWT: when logged in, mint a token from the website.
		// REH service prefers it over the static apiKey.
		let workerToken: string | undefined;
		if (this._authService.isLoggedIn()) {
			try {
				const tokenResult = await this._authService.getWorkerToken();
				workerToken = tokenResult?.worker_token;
				if (workerToken) {
					this._logService.info(`[ChipOS RemoteWorker] minted worker_token for RPC (expires_in=${tokenResult!.expires_in}s)`);
				}
			} catch (err) {
				this._logService.warn(`[ChipOS RemoteWorker] worker_token mint threw, falling back to api_key: ${err}`);
			}
		}

		// NEW-1: forward the IDE-resolved MCP config path so a user override
		// (chipos.worker.mcpConfigPath) reaches REH-spawned workers too. The
		// path is resolved on the REH host via Path(...).expanduser(), so `~`
		// expands to REH's $HOME — which is what we want.
		const mcpConfigPath = resolveWorkerMcpConfigPath(this._configurationService);

		const args: IEnsureRemoteWorkerArgs = {
			reasonerGrpcTarget,
			workspaceRoot,
			// IDE-pinned worker version: REH-side `findCachedBinary` uses this
			// to load EXACTLY this Worker release (skip "newest cached" logic).
			// Set at IDE build time via product.json `chiposReleases.workerVersion`.
			// Empty / undefined → REH falls back to "newest cached" (dev mode).
			preferredVersion: this._productService.chiposReleases?.workerVersion,
			workerHttpPort,
			workerApiKey: workerApiKey || undefined,
			workerToken,
			tlsEnabled,
			mcpConfigPath,
		};

		try {
			const channel = conn.getChannel(ChiposRemoteWorkerChannelName);
			// Use a hard timeout — if the channel isn't actually registered,
			// the call may hang indefinitely waiting for a server response.
			const result = await this._withTimeout(
				channel.call<IEnsureRemoteWorkerResult>('ensureWorker', args),
				10_000,
				'rpc-ensureWorker',
			);

			if (!result?.ok) {
				this._logService.warn(`[ChipOS RemoteWorker] strategy=rpc-failed error=${result?.error ?? '(unknown)'} elapsed=${Date.now() - t0}ms`);
				return false;
			}

			this._logService.info(`[ChipOS RemoteWorker] strategy=rpc-ok server-strategy=${result.strategy} pid=${result.pid} httpPort=${result.httpPort} elapsed=${Date.now() - t0}ms`);
			// Track for ref_count release on dispose.
			this._rpcSpawnedWorkspaceRoot = workspaceRoot;
			// Note: we do NOT update reasoningUrl here. In RPC mode the REH is
			// already the host, and reasoningUrl is expected to already be a
			// forwarded URL set by Microsoft Remote-SSH's auto-forwarding or by
			// the user. The Worker's HTTP port is exposed on remote loopback
			// and the IDE accesses it through whatever forwarding mechanism is
			// in use (this is consumer's concern, not ours).
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.info(`[ChipOS RemoteWorker] strategy=rpc-unavailable reason="${msg}" elapsed=${Date.now() - t0}ms — falling back to command`);
			return false;
		}
	}

	/**
	 * Strategy B: invoke the chipos-remote-ssh extension command.
	 */
	private async _tryEnsureWorkerViaCommand(remoteAuth: string): Promise<void> {
		const sshTarget = this._extractSshTarget(remoteAuth);
		if (!sshTarget) {
			this._logService.warn(`[ChipOS RemoteWorker] strategy=command-skip cannot extract SSH target from authority='${remoteAuth}'`);
			return;
		}

		const folders = this._workspaceContextService.getWorkspace().folders;
		const workspacePath = folders[0]?.uri.path ?? '/root/workspace';

		this._logService.info(`[ChipOS RemoteWorker] strategy=command target=${sshTarget} ws=${workspacePath}`);

		const t0 = Date.now();
		try {
			const result = await this._commandService.executeCommand<{ ok: boolean; error?: string; strategy?: string; workerHttpUrl?: string }>(
				'chipos-remote-ssh.ensureRemoteWorker',
				{ sshTarget, workspacePath },
			);
			const elapsed = Date.now() - t0;
			if (!result) {
				this._logService.error(`[ChipOS RemoteWorker][ERROR] strategy=command result=undefined (extension not loaded?) elapsed=${elapsed}ms`);
				return;
			}
			if (result.ok) {
				this._logService.info(`[ChipOS RemoteWorker] strategy=command-ok inner-strategy=${result.strategy} workerHttpUrl=${result.workerHttpUrl} elapsed=${elapsed}ms`);
			} else {
				this._logService.error(`[ChipOS RemoteWorker][ERROR] strategy=command-failed error=${result.error} elapsed=${elapsed}ms`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS RemoteWorker][ERROR] strategy=command-threw error=${msg} elapsed=${Date.now() - t0}ms`);
		}
	}

	private _withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			p.then(
				v => { clearTimeout(timer); resolve(v); },
				e => { clearTimeout(timer); reject(e); },
			);
		});
	}

	/**
	 * Extract `user@host[:port]` from a Remote-SSH authority. Returns undefined
	 * if the format is unrecognised (e.g. an SSH config alias we can't resolve).
	 */
	private _extractSshTarget(authority: string): string | undefined {
		// Microsoft: ssh-remote+<host-or-user@host[:port]>
		// ChipOS:    chipos-ssh+<host-or-user@host[:port]>
		// Generic fallback: anything+<rest>
		const plus = authority.indexOf('+');
		if (plus < 0) {
			return undefined;
		}
		const target = authority.substring(plus + 1);
		if (!target) {
			return undefined;
		}
		// We only support user@host[:port] format. SSH-config aliases without
		// a username cannot be reliably resolved by ssh2 from here, so we hand
		// them through and let buildSshOptions() supply the local username.
		return target;
	}

	private _isLoopback(url: string): boolean {
		try {
			const u = new URL(url);
			const host = u.hostname.toLowerCase();
			return host === 'localhost' || host === '127.0.0.1' || host === '::1';
		} catch {
			return true; // malformed URL — treat as local so we still try to spawn
		}
	}

	/**
	 * Manual / adopted-existing-process variant of the health check.
	 *
	 * Reasoner reachability and Worker registration are reported as separate signals
	 * (P0-3) so the UI can show "Reasoner connected, Worker not ready" without
	 * keeping the whole backend in HealthChecking forever.
	 */
	private async _reasonerOnlyHealthCheck(): Promise<void> {
		this._setState(SidecarState.HealthChecking);
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (this._store.isDisposed) { return; }
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
				clearTimeout(timer);
				if (resp.ok) {
					this._setState(SidecarState.Connected);
					this._logService.info('[ChipOS SidecarElectron] Reasoner health OK (manual/adopted)');
					this._observeWorkerRegistration().catch(() => { /* best effort */ });
					return;
				}
			} catch { /* retry */ }
			await new Promise<void>(r => setTimeout(r, 500));
		}
		this._logService.warn('[ChipOS SidecarElectron] Manual mode: reasoner /health never responded');
		this._setState(SidecarState.Error);
	}

	/**
	 * Independent of the SidecarState machine, watch /health.workers_connected and
	 * mirror it into WorkerState. In manual / SSH-remote scenarios the worker is
	 * spawned by someone else (chipos-remote-ssh, REH, an operator); we just observe.
	 */
	private async _observeWorkerRegistration(): Promise<void> {
		const deadline = Date.now() + 60_000;
		this._setWorkerState(WorkerState.Starting);
		while (Date.now() < deadline) {
			if (this._store.isDisposed) { return; }
			if (await this._probeWorkerHealth()) {
				this._setWorkerState(WorkerState.Connected);
				this._startHealthWatch();
				return;
			}
			await new Promise<void>(r => setTimeout(r, 1500));
		}
		// Give up — leave WorkerState as Starting so the user sees something is in flight.
		this._logService.warn('[ChipOS SidecarElectron] Worker registration not observed within 60s');
		this._setWorkerState(WorkerState.Disconnected);
	}

	/**
	 * Start a continuous health watcher (idempotent). Runs until the
	 * SidecarManager is disposed or stopBackend()/restartWorker() resets
	 * it. Polls _probeWorkerHealth() every 30s; if 3 consecutive probes
	 * fail the worker is presumed gone and WorkerState flips to
	 * Disconnected — that's the signal the status-bar pill, the WORKER
	 * TOOLS panel auto-refresh, and the EDA pill all key off.
	 *
	 * No auto-respawn here — letting the user see the orange pill + click
	 * Reconnect is the explicit recovery path. Auto-respawn is risky
	 * (masks real crashes, races with manual recovery, can loop forever
	 * on a permanently-bad token).
	 *
	 * Why this exists (2026-05-15): the original code only checked health
	 * during the registration window. Once Connected, no one watched. If
	 * the worker died later, WorkerState stayed Connected forever — the
	 * pill lied while the panel + EDA pill correctly showed errors.
	 */
	private _startHealthWatch(): void {
		this._stopHealthWatch();
		this._healthWatchFailureCount = 0;
		this._healthWatchTimer = setInterval(() => {
			void (async () => {
				if (this._store.isDisposed) {
					this._stopHealthWatch();
					return;
				}
				if (this._workerState !== WorkerState.Connected) {
					// Some other path already moved us off Connected (manual
					// restart, dispose, etc.). Stop watching; the next
					// successful registration will start a fresh watcher.
					this._stopHealthWatch();
					return;
				}
				const ok = await this._probeWorkerLiveness();
				if (ok) {
					this._healthWatchFailureCount = 0;
					return;
				}
				// 2026-05-22 fix: worker is single-threaded aiohttp; it
				// briefly blocks on MCP listTools (5-10s) and EDA toolchain
				// self-check (1-3s). A single 30s tick that hits one of
				// those bursts shouldn't snowball into a Disconnected flip
				// — that just lies to the user about the worker being dead
				// while it's actually serving requests. Before counting a
				// real failure, retry once after 500-2000ms jitter. If the
				// burst was transient, retry succeeds and we don't bump
				// the counter; if worker is truly gone, retry also fails
				// and we continue the existing 3/3 logic.
				await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1500));
				const retryOk = await this._probeWorkerLiveness();
				if (retryOk) {
					this._healthWatchFailureCount = 0;
					this._logService.info(
						'[ChipOS SidecarElectron] health probe recovered on jitter-retry; not counting failure',
					);
					return;
				}
				this._healthWatchFailureCount++;
				this._logService.info(
					`[ChipOS SidecarElectron] health watch probe failed `
					+ `(${this._healthWatchFailureCount}/3, retry also failed)`,
				);
				if (this._healthWatchFailureCount >= 3) {
					this._logService.warn(
						'[ChipOS SidecarElectron] worker presumed dead after '
						+ '3 consecutive health failures; flipping to Disconnected',
					);
					this._setWorkerState(WorkerState.Disconnected);
					this._stopHealthWatch();
				}
			})().catch(err => this._logService.debug('[ChipOS SidecarElectron] health watch tick errored', err));
		}, 30_000);
	}

	private _stopHealthWatch(): void {
		if (this._healthWatchTimer !== undefined) {
			clearInterval(this._healthWatchTimer);
			this._healthWatchTimer = undefined;
		}
	}

	/**
	 * Truthful "worker is healthy" probe. Composed because the IDE's
	 * `Worker: Connected` pill is a UX signal that chat will actually work,
	 * which requires:
	 *   (a) the worker process is up and its HTTP server is responsive
	 *       (otherwise the WORKER TOOLS panel + EDA status bar will fail
	 *       to fetch and show ⚠️ even though the pill claims green); AND
	 *   (b) the reasoner has it in its `workers_connected` list (otherwise
	 *       chat round-trips fail with WORKER_UNAVAILABLE).
	 *
	 * Bug observed 2026-05-15: the previous probe checked only (b). Reasoner
	 * keeps a stale gRPC connection in its connected count for a few
	 * seconds after the worker actually dies, so the pill flashed green
	 * while the local panel was failing to fetch. Result: user sees
	 * "✓ Worker: Connected" + ⚠️ "Worker API unavailable" simultaneously.
	 *
	 * In CloudReasoning / Manual modes there is no local worker to probe
	 * (it lives on a remote host or wherever the user put it), so we skip
	 * (a) and rely on the reasoner-side check alone.
	 */
	/**
	 * Local worker liveness ONLY — is the worker PROCESS up and serving its
	 * localhost HTTP `/health`? Deliberately does NOT consult the reasoner's
	 * `workers_connected`: the worker is a LOCAL process, so a worker↔reasoner
	 * gRPC flap (the WAN link to the cloud reasoner) must NOT mark the local
	 * worker as down. Worker↔reasoner connectivity is a separate concern
	 * surfaced via the reasoner ("ChipOS") state, not the "Worker" pill.
	 */
	private async _probeLocalWorkerHealth(): Promise<boolean> {
		// 2026-05-23: read the ACTUAL bound port from instance.json rather than
		// trusting `chipos.backend.workerHttpPort` — the worker rolls to a
		// kernel-assigned port on EADDRINUSE, so the config default (8081) often
		// lies. Fallback to config when instance.json isn't readable yet.
		const folders = this._workspaceContextService.getWorkspace().folders;
		const workspaceRoot = folders[0]?.uri.fsPath ?? '';
		let port = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		if (workspaceRoot) {
			try {
				const meta = await this.readInstanceMeta(workspaceRoot);
				if (meta && typeof meta.http_port === 'number' && meta.http_port > 0) {
					port = meta.http_port;
					// Stash for synchronous callers (workerHttpUrl getter, etc).
					this._cachedActualWorkerHttpPort = meta.http_port;
				}
			} catch {
				// Keep config default; probe failure below will surface it
			}
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 1500);
			const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
			clearTimeout(timer);
			return resp.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Liveness signal for the ongoing health watch + the "Worker" status pill.
	 * In Local mode this is the LOCAL worker process ONLY — a worker↔reasoner
	 * gRPC flap must never flip the local "Worker" pill to Reconnect (the
	 * process is alive; only its upstream blipped). Non-local modes have no
	 * local process, so fall back to the reasoner-aware probe.
	 */
	private async _probeWorkerLiveness(): Promise<boolean> {
		return this._mode === BackendMode.Local
			? this._probeLocalWorkerHealth()
			: this._probeWorkerHealth();
	}

	/**
	 * Full readiness probe used at STARTUP (`_observeWorkerRegistration`): the
	 * local worker is up AND the reasoner has registered it. The reasoner check
	 * is appropriate for "has the worker finished wiring up" but NOT for ongoing
	 * liveness — see `_probeWorkerLiveness`.
	 */
	private async _probeWorkerHealth(): Promise<boolean> {
		// (a) Local worker process alive (localhost /health).
		if (this._mode === BackendMode.Local && !(await this._probeLocalWorkerHealth())) {
			return false;
		}
		// (b) Reasoner sees a worker registered.
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 3000);
			const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
			clearTimeout(timer);
			if (!resp.ok) { return false; }
			const body = await resp.json() as { workers_connected?: number };
			return !!(body.workers_connected && body.workers_connected > 0);
		} catch {
			return false;
		}
	}

	async stopBackend(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] stopBackend()');
		this._stopHealthWatch();
		// Local-mode: we DO own the worker process, so release ref + kill if
		// we were the last consumer. Other modes (Manual / CloudReasoning):
		// we never spawned anything, just clear local observation state.
		if (this._mode === BackendMode.Local) {
			await this._releaseLocalWorkerRef();
		}
		this._setWorkerState(WorkerState.NotStarted);
		this._setState(SidecarState.NotStarted);
		// Invalidate the observed-port cache so the next worker spawn
		// doesn't reuse a stale port for the brief window before its
		// first health probe lands. workerHttpUrl falls back to config
		// in the meantime — same as the original pre-port-roll behavior.
		this._cachedActualWorkerHttpPort = undefined;
	}

	async restartWorker(): Promise<void> {
		// 2026-05-11 — In **Local mode** the IDE *does* own the worker process
		// (spawnProcess IPC), so a real restart means: kill the existing
		// worker, wipe its instance.json, then spawn a new one with a freshly
		// minted token. The previous version of this method was a no-op stub
		// that only re-observed registration — useful for REH/SSH-mode where
		// the worker lives elsewhere, but in Local mode it left dead workers
		// adopted and a fresh `worker_token` un-applied. CloudReasoning/
		// Manual modes keep the lightweight behavior.
		//
		// 2026-05-15 — restartWorker() is **user-initiated** (status-bar
		// Reconnect button + Command Palette). Previously it delegated to
		// `_refreshWorkerTokenAndRespawn()`, which:
		//   (a) returned silently when `isLoggedIn() === false` — auth state
		//       briefly flips false after WORKER_AUTH_FAILED 5×, so the
		//       button felt like a no-op until the user did Reload Window;
		//   (b) was guarded by `_refreshingWorkerToken` dedupe meant for the
		//       background auto-refresh timer — a stuck flag silently
		//       swallowed every click;
		//   (c) only its `_ensureLocalWorker()` branch did the actual kill+
		//       spawn; the !Local branch recursed into restartWorker().
		// Now restartWorker() does its own forceful kill+respawn in Local
		// mode (and re-observe in remote modes), independent of the
		// auto-refresh dedupe + auth gate. The user clicked "Reconnect" —
		// they want a hard reset, not a quiet skip.
		this._logService.info(`[ChipOS SidecarElectron] restartWorker() — mode=${this._mode}, isLoggedIn=${this._authService.isLoggedIn()}`);
		this._clearWorkerTokenRefreshTimer();
		this._stopHealthWatch(); // _observeWorkerRegistration will start a fresh one on success

		if (this._mode === BackendMode.Local) {
			this._setWorkerState(WorkerState.Starting);
			try {
				// Release our ref first so the main-side ref_count is correct
				// when killProcess fires. Non-fatal if no ref is held (e.g.
				// dead worker was already cleared by its exit handler).
				await this._releaseLocalWorkerRef();
				// killProcess waits for SIGTERM→exit (or 5s SIGKILL fallback)
				// inside killManagedProcess(), so by the time this resolves,
				// the OS-level process is actually gone — no zombie left for
				// _ensureLocalWorker's checkInstance to mistakenly adopt.
				await this._invokeIpc('vscode:chipos:killProcess', 'worker').catch(err => {
					this._logService.warn(`[ChipOS SidecarElectron] killProcess during restart failed (non-fatal): ${err}`);
				});
				// _ensureLocalWorker re-mints the worker_token if logged in,
				// or falls through to apiKey path otherwise. Either way the
				// new process gets a fresh env, which is what the user is
				// asking for when they click Reconnect.
				const spawned = await this._ensureLocalWorker();
				if (spawned) {
					this._logService.info('[ChipOS SidecarElectron] restartWorker: respawn complete, observing registration');
					void this._observeWorkerRegistration().catch(() => { /* best effort */ });
				} else {
					this._logService.warn('[ChipOS SidecarElectron] restartWorker: _ensureLocalWorker returned false (no workspace folder?)');
					this._setWorkerState(WorkerState.Disconnected);
				}
				return;
			} catch (err) {
				this._logService.warn(`[ChipOS SidecarElectron] Local restartWorker failed: ${err}`);
				this._setWorkerState(WorkerState.Disconnected);
				// fall through to legacy re-observe path below — at least
				// the WorkerState will recover if a worker happens to come
				// back via some other code path.
			}
		}

		this._setWorkerState(WorkerState.Starting);
		void this._observeWorkerRegistration().catch(() => { /* best effort */ });
	}

	// ── Worker JWT auto-refresh ──────────────────────────────────────────
	//
	// IDE no longer spawns the worker process, so it doesn't own the
	// worker_token either. The chipos-remote-ssh extension (SSH path) and
	// the REH-side ChiposRemoteWorkerService (RPC path) each manage their
	// own token refresh — see scheduleWorkerTokenRefresh() in
	// extensions/chipos-remote-ssh/src/extension.ts.
	//
	// Kept here as a stub because:
	//   - login state changes still trigger restartWorker()
	//   - dispose still has a clear-timer call
	// Both call into the no-op timer guard below.

	private _clearWorkerTokenRefreshTimer(): void {
		if (this._workerTokenRefreshTimer !== undefined) {
			clearTimeout(this._workerTokenRefreshTimer);
			this._workerTokenRefreshTimer = undefined;
		}
	}

	private async _refreshWorkerTokenAndRespawn(): Promise<void> {
		// De-dupe: if a refresh is already running (slow IPC, retry, …) drop
		// the duplicate timer fire instead of stacking respawns.
		if (this._refreshingWorkerToken) {
			return;
		}
		this._refreshingWorkerToken = true;
		try {
			if (!this._authService.isLoggedIn()) {
				this._logService.info('[ChipOS SidecarElectron] worker_token auto-refresh skipped — user signed out');
				return;
			}
			// Local mode: we OWN the worker process, so a stale JWT means the
			// worker is presenting an expired token to Reasoner and getting
			// UNAUTHENTICATED on every reconnect. Stop + spawn anew with the
			// fresh token. Other modes (Manual / CloudReasoning) only need to
			// re-observe — the worker process is owned elsewhere and will pick
			// up the new token on its own respawn cycle.
			if (this._mode === BackendMode.Local) {
				this._logService.info('[ChipOS SidecarElectron] login state changed — Local mode, respawning worker with fresh token');
				try {
					// Mirror restartWorker(): stop the stale health watch + show Starting, and
					// (crucially) re-observe after the respawn so WorkerState flips back to
					// Connected. Without the re-observe the status bar stays "Reconnect" even
					// though the freshly-spawned worker registers fine on the reasoner.
					this._stopHealthWatch();
					this._setWorkerState(WorkerState.Starting);
					await this._releaseLocalWorkerRef();
					await this._invokeIpc('vscode:chipos:killProcess', 'worker').catch(() => { /* best effort */ });
					const spawned = await this._ensureLocalWorker();
					if (spawned) {
						void this._observeWorkerRegistration().catch(() => { /* best effort */ });
					} else {
						this._setWorkerState(WorkerState.Disconnected);
					}
				} catch (err) {
					this._logService.warn(`[ChipOS SidecarElectron] Local respawn during token refresh failed: ${err}`);
					this._setWorkerState(WorkerState.Disconnected);
				}
				return;
			}
			this._logService.info('[ChipOS SidecarElectron] login state changed — re-observing worker registration');
			await this.restartWorker();
		} finally {
			this._refreshingWorkerToken = false;
		}
	}

	override dispose(): void {
		this._disposed = true;
		this._clearAutoRestartTimer();
		this._clearWorkerTokenRefreshTimer();
		this._stopHealthWatch();

		// Path-3 Stage-2/3: release ref_count on REH if we used the RPC path.
		if (this._rpcSpawnedWorkspaceRoot) {
			const conn = this._remoteAgentService.getConnection();
			if (conn) {
				try {
					const channel = conn.getChannel(ChiposRemoteWorkerChannelName);
					const args: IReleaseRemoteWorkerArgs = { workspaceRoot: this._rpcSpawnedWorkspaceRoot };
					channel.call<void>('releaseWorker', args).catch(err => {
						this._logService.warn(`[ChipOS RemoteWorker] dispose: releaseWorker failed: ${err}`);
					});
				} catch (err) {
					this._logService.warn(`[ChipOS RemoteWorker] dispose: could not get channel: ${err}`);
				}
			}
			this._rpcSpawnedWorkspaceRoot = undefined;
		}

		// Local mode: release ref + kill if this was the last consumer. Fire
		// and forget — dispose() can't be async, but the IPC handler updates
		// instance.json synchronously so the next window will see ref_count
		// correctly even if the kill is still in flight.
		if (this._localWorkerWorkspaceRoot) {
			void this._releaseLocalWorkerRef();
		}

		super.dispose();
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	async spawn(): Promise<void> { return this.startBackend(); }
	async kill(): Promise<void> { return this.stopBackend(); }
	setManualUrl(_url: string | undefined): void { /* noop */ }

	// ── Local-mode Worker spawn (cache → download → spawn) ─────────────────
	//
	// Only fires in BackendMode.Local. Mirrors chipos-remote-ssh's
	// WorkerManager.ensureWorkerRunning, but talks to electron-main via
	// IPC instead of ssh2.
	//
	// Per-call sequence:
	//   1. checkInstance — existing PID alive? acquireRef + done.
	//   2. findBinary    — scan ~/.chipos/workers/<ver>/<binary>.
	//   3. downloadBinary — pull from GitHub Release if cache empty.
	//   4. ensureMcpConfig — write default ~/.chipos/mcp_servers.json if absent.
	//   5. spawnProcess  — child_process.spawn() the binary, detached:true so
	//                       the Worker survives an IDE crash.
	//
	// Auth: same precedence as the SSH path (workerToken > workerApiKey).
	// JWT auto-refresh logic stays where it is (no token mutation needed
	// here; respawn is what the refresh path does).
	/** @returns true if a worker is up (spawned or adopted), false if deferred. */
	private async _ensureLocalWorker(): Promise<boolean> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		const workspaceRoot = folders[0]?.uri.fsPath ?? '';
		if (!workspaceRoot) {
			// Empty workbench — no point spawning a Worker since there's nothing
			// to operate on. Workspace hash would be empty and instance.json
			// keying breaks. Skip gracefully; chiposContribution will re-trigger
			// startBackend() when the user opens a folder.
			this._logService.info('[ChipOS Local] no workspace folder open — deferring worker spawn');
			return false;
		}

		const grpcTarget = resolveReasonerGrpcAddress(this._configurationService, this._productService);
		// 2026-05-23: chipos.backend.workerHttpPort no longer passed at spawn —
		// worker always kernel-assigns. Kept as readable-only config so users
		// who set it via legacy settings don't get errors; ignored at spawn.
		const tlsEnabled = this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false;
		const workerApiKey = resolveWorkerApiKey(this._configurationService, this._productService);
		const mcpConfigPath = resolveWorkerMcpConfigPath(this._configurationService);

		// Phase 1.5 Worker JWT (preferred when logged in).
		//
		// Startup race (fix 2026-05-13): at IDE cold start, sidecarManager's
		// startBackend() runs synchronously before ChipOSAuthService finishes
		// restoring tokens from SecretStorage. Result: isLoggedIn() returns
		// false here, no worker_token gets minted, worker spawns with
		// env.CHIPOS_WORKER_TOKEN unset → gRPC register hits
		// WORKER_AUTH_FAILED 5× and the worker self-terminates. The
		// onDidChangeLoginState listener (line ~185) ALSO doesn't help
		// because it bails when workerState===NotStarted, and the
		// false→true transition fires during that window.
		//
		// Fix: if not logged in yet, wait up to 2s for the next login
		// state change. SecretStorage restore typically completes in
		// 200-500ms, so 2s is a generous upper bound. If the user really
		// isn't logged in (manual logout / fresh install), the wait still
		// returns false after 2s and we fall through to api_key path —
		// same behavior as before, just delayed.
		let workerToken: string | undefined;
		if (!this._authService.isLoggedIn()) {
			await new Promise<void>(resolve => {
				let resolved = false;
				const done = () => { if (!resolved) { resolved = true; resolve(); } };
				const timer = setTimeout(done, 2000);
				const disposable = this._authService.onDidChangeLoginState(isLoggedIn => {
					if (isLoggedIn) {
						clearTimeout(timer);
						disposable.dispose();
						done();
					}
				});
			});
			if (this._authService.isLoggedIn()) {
				this._logService.info('[ChipOS Local] auth restored from SecretStorage during spawn wait');
			}
		}
		if (this._authService.isLoggedIn()) {
			try {
				const tokenResult = await this._authService.getWorkerToken();
				workerToken = tokenResult?.worker_token;
				if (workerToken) {
					this._logService.info(`[ChipOS Local] minted worker_token (expires_in=${tokenResult!.expires_in}s)`);
				}
			} catch (err) {
				this._logService.warn(`[ChipOS Local] worker_token mint failed, falling back to api_key: ${err}`);
			}
		}

		// 1. Existing instance? Adopt + ref++.
		const inst = await this._invokeIpc<{ alive: boolean; pid?: number; http_port?: number; ref_count?: number }>(
			'vscode:chipos:checkInstance',
			{ workspaceRoot },
		);
		if (inst?.alive && inst.pid) {
			const newCount = await this._invokeIpc<number>('vscode:chipos:acquireRef', {
				workspaceRoot,
				callerId: this._localCallerId,
			});
			this._localWorkerWorkspaceRoot = workspaceRoot;
			this._logService.info(`[ChipOS Local] adopted existing worker pid=${inst.pid} ref_count=${newCount}`);
			// Adopted a live (possibly cross-window shared) worker — its identity is
			// owned by whoever spawned it; treat as token-bearing so a later sign-in
			// here never kills a shared worker out from under another window.
			this._workerSpawnedWithToken = true;
			return true;
		}

		// 2. Cache lookup. Honor the product.json pin (chiposReleases.workerVersion)
		// so an IDE built against v0.2.2 doesn't accidentally adopt a v0.2.1 binary
		// that happened to be left in cache. The contract documented at
		// vs/base/common/product.ts:140 is "IDE always loads / downloads this exact
		// version — never queries GitHub `latest`". Previously this path violated
		// that contract by passing empty args (find any version) + version: 'latest'
		// (download whatever GitHub /releases/latest resolves to). 2026-05-09 fix.
		const releases = (this._productService as {
			chiposReleases?: { repo?: string; workerVersion?: string };
		}).chiposReleases;
		const pinnedVersion = releases?.workerVersion?.replace(/^v/, '') || undefined;

		let binaryPath = await this._invokeIpc<string | null>(
			'vscode:chipos:findBinary',
			pinnedVersion ? { version: pinnedVersion } : {},
		);
		if (!binaryPath) {
			// 3. Download from GitHub release. Repo from product.json.
			const repo = releases?.repo;
			if (!repo) {
				throw new Error('Cannot download Worker — product.chiposReleases.repo is unset');
			}
			const downloadVersion = pinnedVersion || 'latest';
			this._logService.info(`[ChipOS Local] no cached binary for version=${downloadVersion}; downloading from ${repo}`);

			// Wrap the IPC in a progress notification so the user actually
			// sees what's happening during the 70+MB download (was previously
			// silent — user just stared at a "ChipOS: Connected" status with
			// no chat working until the download finished, sometimes 30s+).
			// 2026-05-09 fix.
			binaryPath = await this._progressService.withProgress<string | null>(
				{
					location: ProgressLocation.Notification,
					title: `Downloading ChipOS Worker v${downloadVersion}`,
					cancellable: false,
				},
				async (progress) => {
					const off = this._subscribeDownloadProgress(progress);
					try {
						return await this._invokeIpc<string | null>('vscode:chipos:downloadBinary', {
							repo,
							version: downloadVersion,
						});
					} finally {
						off();
					}
				},
			);

			if (!binaryPath) {
				const versionStr = pinnedVersion ? `v${pinnedVersion}` : 'latest';
				throw new Error(
					`Worker download failed (repo=${repo}, version=${versionStr}). ` +
					`Likely cause: the ${versionStr} GitHub release is missing the chipos-worker-<platform>.tar.gz asset for this platform. ` +
					`Verify at https://github.com/${repo}/releases/tag/${versionStr}`,
				);
			}
			this._logService.info(`[ChipOS Local] downloaded worker → ${binaryPath}`);
		} else {
			this._logService.info(`[ChipOS Local] using cached worker (version=${pinnedVersion ?? 'latest-available'}) → ${binaryPath}`);
		}

		// 4. Default MCP config (no-op if present). Pass the raw path; main
		// process expands `~/` (renderer is sandboxed and has no Node `process`
		// global, so we can't read HOME here).
		await this._invokeIpc('vscode:chipos:ensureMcpConfig', { mcpConfigPath });

		// 5. Spawn.
		const env: Record<string, string> = {
			CHIPOS_REASONING_SERVER: grpcTarget,
		};
		if (workerToken) {
			env['CHIPOS_WORKER_TOKEN'] = workerToken;
		}
		if (workerApiKey) {
			env['CHIPOS_WORKER_OUTBOUND_KEY'] = workerApiKey;
			env['CHIPOS_API_KEY'] = workerApiKey;
		}
		if (tlsEnabled) {
			env['CHIPOS_TLS_ENABLED'] = 'true';
		}

		const args = [
			'start',
			'--server', grpcTarget,
			'--workspace', workspaceRoot,
			// 2026-05-23: no --http-port by default. Worker uses kernel-
			// assigned port; instance.json is the truth.
			//   Exception below: when user sets chipos.backend.workerHttpPortRange
			//   we pass --http-port-range so the worker binds in the
			//   ops-required range (firewall whitelist scenario).
			// Worker side does its own Path(...).expanduser(); shell expansion
			// not strictly needed here. Pass through verbatim.
			'--mcp-config', mcpConfigPath,
		];

		// 2026-05-25: ops/firewall scenario — let user pin the worker
		// to a port range. Worker validates format + fails loudly if
		// all ports in range are taken (much better failure mode than
		// silent zombie that the old hybrid had).
		const portRange = this._configurationService.getValue<string>('chipos.backend.workerHttpPortRange') || '';
		if (portRange.trim()) {
			args.push('--http-port-range', portRange.trim());
		}

		this._logService.info(`[ChipOS Local] spawning worker (token=${workerToken ? 'set' : 'unset'}, apiKey=${workerApiKey ? 'set' : 'unset'}, tls=${tlsEnabled})`);
		const result = await this._invokeIpc<{ pid?: number; alreadyRunning?: boolean }>('vscode:chipos:spawnProcess', {
			binaryPath,
			args,
			env,
			cwd: workspaceRoot,
			role: 'worker',
			workspaceRoot,
		});
		this._localWorkerWorkspaceRoot = workspaceRoot;
		this._logService.info(`[ChipOS Local] worker spawned pid=${result?.pid} alreadyRunning=${result?.alreadyRunning ?? false}`);
		// Only a FRESH spawn (not a process-level adopt) carries our just-minted
		// token. A tokenless fresh spawn (logged out at spawn) leaves this false, so a
		// later real sign-in is NOT suppressed above and respawns the worker.
		this._workerSpawnedWithToken = result?.alreadyRunning ? true : !!workerToken;

		// Briefly confirm to the user. `alreadyRunning` means we adopted an
		// existing process — no need to celebrate; that's quiet by design.
		// 2026-05-09: was silent before, contributing to the "is anything
		// happening?" UX problem.
		if (!result?.alreadyRunning) {
			this._notificationService.notify({
				severity: Severity.Info,
				message: `ChipOS Worker ready (pid=${result?.pid}).`,
			});
		}
		return true;
	}

	private async _releaseLocalWorkerRef(): Promise<void> {
		if (!this._localWorkerWorkspaceRoot) { return; }
		try {
			const remaining = await this._invokeIpc<number>('vscode:chipos:releaseRef', {
				workspaceRoot: this._localWorkerWorkspaceRoot,
				callerId: this._localCallerId,
			});
			this._logService.info(`[ChipOS Local] released worker ref, remaining=${remaining}`);
			if (remaining === 0) {
				// Last ref — kill the process. Worker writes its instance.json
				// itself, so on next IDE start without the file we'll spawn fresh.
				await this._invokeIpc('vscode:chipos:killProcess', 'worker');
			}
		} catch (err) {
			this._logService.warn(`[ChipOS Local] release ref failed (non-fatal): ${err}`);
		}
		this._localWorkerWorkspaceRoot = undefined;
	}

	/** Thin wrapper around ipcRenderer.invoke with logging on failure. */
	private async _invokeIpc<T = unknown>(channel: string, args?: unknown): Promise<T> {
		try {
			return (await ipcRenderer.invoke(channel, args)) as T;
		} catch (err) {
			this._logService.warn(`[ChipOS Local] IPC ${channel} failed: ${err}`);
			throw err;
		}
	}

	/**
	 * Read instance.json metadata via the existing `checkInstance` IPC — same
	 * payload, additionally surfaces `permission_token` after 2026-05-11.
	 * Used by WorkerPermissionService (Worker→IDE permission ASK channel).
	 */
	readInstanceMeta = async (workspaceRoot: string): Promise<IWorkerInstanceMeta | undefined> => {
		if (!workspaceRoot) {
			return undefined;
		}
		try {
			return await this._invokeIpc<IWorkerInstanceMeta>('vscode:chipos:checkInstance', { workspaceRoot });
		} catch (err) {
			this._logService.debug(`[ChipOS Local] readInstanceMeta failed: ${err}`);
			return undefined;
		}
	};

	/**
	 * Forward progress events from the main-process download into a
	 * renderer-side IProgress. Returns an unsubscribe function. 2026-05-09:
	 * added so the worker download stops being silent.
	 */
	private _subscribeDownloadProgress(progress: IProgress<IProgressStep>): () => void {
		const channel = 'vscode:chipos:workerDownloadProgress';
		type ProgressPayload = {
			phase: 'starting' | 'downloading' | 'extracting' | 'done' | 'error';
			loaded?: number;
			total?: number;
			message?: string;
		};
		const onProgress = (_e: unknown, ...args: unknown[]) => {
			const payload = args[0] as ProgressPayload | undefined;
			if (!payload) { return; }
			switch (payload.phase) {
				case 'starting':
					progress.report({ message: 'Connecting to GitHub Releases…' });
					return;
				case 'downloading': {
					const loaded = payload.loaded ?? 0;
					const total = payload.total;
					if (total && total > 0) {
						const mbLoaded = (loaded / 1024 / 1024).toFixed(1);
						const mbTotal = (total / 1024 / 1024).toFixed(1);
						const pct = Math.min(100, Math.round((loaded / total) * 100));
						progress.report({
							message: `${mbLoaded} / ${mbTotal} MB`,
							increment: pct - (this._lastDownloadPct ?? 0),
						});
						this._lastDownloadPct = pct;
					} else {
						const mbLoaded = (loaded / 1024 / 1024).toFixed(1);
						progress.report({ message: `${mbLoaded} MB downloaded` });
					}
					return;
				}
				case 'extracting':
					progress.report({ message: 'Extracting…' });
					return;
				case 'done':
					progress.report({ message: 'Complete', increment: 100 - (this._lastDownloadPct ?? 0) });
					this._lastDownloadPct = undefined;
					return;
				case 'error':
					this._logService.warn(`[ChipOS Local] download progress error: ${payload.message ?? '?'}`);
					return;
			}
		};
		ipcRenderer.on(channel, onProgress);
		return () => {
			try { ipcRenderer.removeListener(channel, onProgress); } catch { /* ignore */ }
			this._lastDownloadPct = undefined;
		};
	}

	private _lastDownloadPct: number | undefined;

	/**
	 * Two-phase health check (P0-3):
	 *   Phase 1: poll /health until it responds 200 → SidecarState.Connected
	 *            (Reasoner reachability is independent of whether a worker has registered)
	 *   Phase 2: keep polling for `workers_connected > 0` → WorkerState.Connected
	 *            (best-effort; SidecarState stays Connected even if this never succeeds)
	 *
	 * Old behavior coupled the two: a slow-to-register Worker would leave the whole
	 * backend in `HealthChecking` and ultimately surface as `Error`, even though
	 * Chat over SSE would have worked fine.
	 */
	private async _healthCheckLoop(): Promise<void> {
		this._setState(SidecarState.HealthChecking);
		const reasonerTimeout = this._mode === BackendMode.CloudReasoning ? 60_000 : 15_000;
		const interval = 500;
		const start = Date.now();
		let attempts = 0;
		let lastError = '';

		// Phase 1: Reasoner reachable.
		while (Date.now() - start < reasonerTimeout) {
			if (this._store.isDisposed) { return; }
			attempts++;
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
				clearTimeout(timer);
				if (resp.ok) {
					this._setState(SidecarState.Connected);
					this._logService.info(`[ChipOS SidecarElectron] Reasoner health OK after ${attempts} attempts`);
					// Drop into Phase 2 below.
					await this._observeWorkerRegistrationAfterSpawn();
					return;
				}
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
				if (attempts % 10 === 0) {
					this._logService.info(`[ChipOS SidecarElectron] Reasoner health attempt ${attempts}, last error: ${lastError}`);
				}
			}
			await new Promise<void>(r => setTimeout(r, interval));
		}

		this._logService.warn(`[ChipOS SidecarElectron] Reasoner health check failed after ${attempts} attempts. Last error: ${lastError}`);
		this._setState(SidecarState.Error);
	}

	/** Phase 2 — same loop as `_observeWorkerRegistration` but with shorter timeout
	 * because we just spawned the worker, not adopting an existing one.
	 *
	 * 2026-05-15 — phased observation to fix the false "Worker: Error" pill:
	 *   Phase A (0–60s): tight 1s poll, normal flow.
	 *   Phase B (60–600s): slow 5s poll in background; IDE shows Error so the
	 *     user knows something's off, but if the worker eventually completes
	 *     gRPC registration (slow network to remote Reasoner is the common
	 *     case — Aliyun host can need 30–90s under load) we still flip back
	 *     to Connected without requiring a manual Reconnect.
	 *
	 * The previous version gave up at 30s and left WorkerState.Error stuck.
	 * Worker logs from the ChipOS IDE on a real session showed registration
	 * landing at 33–35s — just past the deadline — leaving the user staring
	 * at a "Worker: Reconnect" badge for a worker that was actually about to
	 * come online on its own.
	 */
	private async _observeWorkerRegistrationAfterSpawn(): Promise<void> {
		const phaseADeadline = Date.now() + 60_000;
		const phaseBDeadline = Date.now() + 600_000; // 10 min total observation window
		const probe = this._probeWorkerHealth.bind(this);

		// Phase A — tight 1s poll, expect registration soon.
		while (Date.now() < phaseADeadline) {
			if (this._store.isDisposed) { return; }
			if (await probe()) {
				this._setWorkerState(WorkerState.Connected);
				this._logService.info('[ChipOS SidecarElectron] Worker registered with reasoner');
				this._startHealthWatch();
				return;
			}
			await new Promise<void>(r => setTimeout(r, 1000));
		}

		// Phase B — slow background recovery. Mark Error so user sees the
		// problem, but keep polling because slow gRPC handshakes (remote
		// Reasoner over WAN) routinely complete just past the 60s mark.
		this._logService.warn('[ChipOS SidecarElectron] Worker registration not observed within 60s; entering slow-recovery poll');
		this._setWorkerState(WorkerState.Error);

		while (Date.now() < phaseBDeadline) {
			if (this._store.isDisposed) { return; }
			await new Promise<void>(r => setTimeout(r, 5000));
			if (await probe()) {
				this._setWorkerState(WorkerState.Connected);
				this._logService.info('[ChipOS SidecarElectron] Worker registered with reasoner (slow-recovery)');
				this._startHealthWatch();
				return;
			}
		}

		this._logService.warn('[ChipOS SidecarElectron] Worker still not registered after 10 min; giving up observation');
	}

	// ── State helpers ────────────────────────────────────────────────────

	private _setState(s: SidecarState): void {
		if (this._state !== s) {
			this._state = s;
			this._onDidChangeState.fire(s);
		}
	}

	private _setWorkerState(s: WorkerState): void {
		if (this._workerState !== s) {
			this._workerState = s;
			this._onDidChangeWorkerState.fire(s);
			// FEAT worker self-heal — Connected clears the backoff budget; an
			// unexpected drop (Disconnected/Error, NOT the intentional NotStarted
			// from stopBackend) schedules an auto-restart.
			if (s === WorkerState.Connected) {
				this._autoRestartAttempts = 0;
				this._clearAutoRestartTimer();
			} else if (s === WorkerState.Disconnected || s === WorkerState.Error) {
				this._maybeScheduleAutoRestart();
			}
		}
	}

	/**
	 * Schedule an automatic worker restart with exponential backoff. Local mode
	 * only (the IDE owns the process); one timer in flight at a time; gives up
	 * after the attempt budget, leaving the manual "Worker: Reconnect" button.
	 */
	private _maybeScheduleAutoRestart(): void {
		if (this._disposed || this._mode !== BackendMode.Local || this._autoRestartTimer) {
			return;
		}
		if (this._configurationService.getValue<boolean>('chipos.worker.autoRestart') === false) {
			return;
		}
		const plan = planWorkerAutoRestart(this._autoRestartAttempts);
		if (!plan) {
			this._logService.warn(`[ChipOS SidecarElectron] worker auto-restart exhausted after ${this._autoRestartAttempts} attempts — leaving manual "Worker: Reconnect".`);
			return;
		}
		this._autoRestartAttempts = plan.nextAttempt;
		this._logService.info(`[ChipOS SidecarElectron] worker dropped — auto-restart attempt ${plan.nextAttempt} in ${plan.delayMs}ms`);
		this._autoRestartTimer = setTimeout(() => {
			this._autoRestartTimer = undefined;
			if (this._disposed || this._workerState === WorkerState.Connected) {
				return;
			}
			this.restartWorker().catch(err => this._logService.error('[ChipOS SidecarElectron] auto-restart failed:', String(err)));
		}, plan.delayMs);
	}

	private _clearAutoRestartTimer(): void {
		if (this._autoRestartTimer) {
			clearTimeout(this._autoRestartTimer);
			this._autoRestartTimer = undefined;
		}
	}
}

