/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R30 + R49 + R50: SidecarManagerElectron — Electron desktop 实现。
 *
 * 模式解析（Auto-detect）：
 *   `chipos.backend.mode` 默认 `auto`。
 *   - workspace 是 SSH remote → Manual（chipos-remote-ssh 扩展接管远端 spawn + 端口转发）
 *   - 已有 reasoner 监听本地 8080 → Manual（不要重复 spawn，复用现有进程）
 *   - 显式配了远程 reasoningUrl → CloudReasoning（本地只 spawn Worker）
 *   - 否则 → Local（spawn reasoner + worker）
 *   只有打开 `chipos.backend.developerMode` 后，用户在设置 UI 才能强制覆盖此自动决策。
 *
 * R49: Worker 启动策略改为 "二进制优先"：
 *   1. 已有 Worker（instance.json PID 活着） → acquire ref_count（多窗口共享）
 *   2. 本地二进制缓存 → IPC spawn 二进制
 *   3. 自动下载二进制 → IPC spawn
 *   4. Fallback: Python 开发环境
 *
 * R50: 多窗口隔离（instance.json + ref_count + workspace hash）
 *   - 不同 workspace → 不同 Worker 实例
 *   - 同 workspace 多窗口 → 共享 Worker + ref_count
 *   - dispose() 时 ref_count-- → 归零才 kill
 *
 * IPC 通道（由 sidecarManagerMain.ts 注册）：
 * - chipos:spawnProcess    → 启动子进程
 * - chipos:killProcess     → 停止子进程
 * - chipos:findBinary      → 查找缓存的二进制
 * - chipos:downloadBinary  → 下载二进制
 * - chipos:checkInstance   → 检查 instance.json + PID
 * - chipos:acquireRef      → ref_count++
 * - chipos:releaseRef      → ref_count--
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
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
	SidecarState,
	BackendMode,
	WorkerState,
} from '../common/sidecarService.js';

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
	private _workerPid: number | undefined;
	private _isSharedInstance = false;
	private _callerId: string;
	// Phase 2 Worker JWT auto-refresh: timer fires before the current
	// worker_token expires so we can mint a new one + respawn the Worker
	// before Reasoner starts rejecting on UNAUTHENTICATED.
	private _workerTokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private _refreshingWorkerToken = false;
	/**
	 * Tracks whether Path-3 Stage-2 RPC was used to spawn the remote Worker.
	 * If set, dispose() must call `releaseWorker` on the same channel so the
	 * REH-side ref_count is decremented (otherwise the Worker leaks on multi-window scenarios).
	 */
	private _rpcSpawnedWorkspaceRoot: string | undefined;

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

	get sseUrl(): string {
		return `${this.reasoningUrl}/api/v1/events`;
	}

	get workerHttpUrl(): string {
		// runtime override > explicit settings — both bypass the derive-from-reasoningUrl
		// path. Fall through to deployment-mode-aware derivation when neither is set.
		const explicit = resolveWorkerHttpUrl(this._configurationService, this._productService, this._runtimeOverrides);
		if (explicit) {
			return explicit;
		}
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		if (this._mode === BackendMode.Local || this._mode === BackendMode.CloudReasoning) {
			return `http://127.0.0.1:${workerHttpPort}`;
		}
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
	) {
		super();

		// Provisional mode — final value is computed lazily in startBackend() after
		// auto-detection (workspace authority, port probe). Until then, treat as Auto.
		this._mode = BackendMode.Auto;
		this._callerId = `electron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		// Phase 2: when the user signs in/out the Worker is now bound to the
		// wrong identity (or none at all). Respawn so the new worker_token
		// (or absence thereof) takes effect immediately instead of after the
		// next 23h refresh cycle. Skipped while no Worker is running yet.
		this._register(this._authService.onDidChangeLoginState(() => {
			if (this._workerState === WorkerState.NotStarted) {
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

		try {
			if (this._mode === BackendMode.Local) {
				await this._spawnReasonerViaIpc();
			}

			await this._spawnWorkerViaIpc();
			await this._healthCheckLoop();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] startBackend failed: ${msg}`);
			this._setState(SidecarState.Error);
		}
	}

	/**
	 * Resolve `chipos.backend.mode`:
	 *   1. developerMode + explicit value → respect user's choice
	 *   2. Otherwise auto-detect:
	 *      a. workspace is SSH remote → Manual (chipos-remote-ssh / REH owns spawn)
	 *      b. local /health already responds → Manual (don't fight existing process)
	 *      c. reasoningUrl points to non-loopback host → CloudReasoning (only spawn worker locally)
	 *      d. fallback → Local
	 */
	private async _resolveMode(): Promise<BackendMode> {
		const configured = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
		const developerMode = this._configurationService.getValue<boolean>('chipos.backend.developerMode') ?? false;

		// Developer override: respect explicit non-auto choice.
		if (developerMode && configured !== 'auto' && configured !== '') {
			const forced = this._parseModeOrAuto(configured);
			if (forced !== BackendMode.Auto) {
				this._logService.info(`[ChipOS SidecarElectron] developerMode=true, forcing mode=${forced}`);
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

		// (b) Local Reasoner already running → adopt it instead of spawning a duplicate.
		if (await this._localReasonerAlreadyRunning()) {
			this._logService.info('[ChipOS SidecarElectron] auto: local reasoner already serving, mode=manual');
			return BackendMode.Manual;
		}

		// (c) Reasoner URL points to a remote host (either via settings or
		// product.json default). Use the same resolver as `reasoningUrl` getter
		// so the mode decision sees what the rest of the code will actually use.
		const reasoningUrl = resolveReasoningUrl(this._configurationService, this._productService);
		if (reasoningUrl && !this._isLoopback(reasoningUrl)) {
			this._logService.info(`[ChipOS SidecarElectron] auto: remote reasoningUrl='${reasoningUrl}', mode=cloud-reasoning`);
			return BackendMode.CloudReasoning;
		}

		// (d) Default — spawn everything on this machine.
		this._logService.info('[ChipOS SidecarElectron] auto: defaulting to mode=local');
		return BackendMode.Local;
	}

	private _parseModeOrAuto(value: string): BackendMode {
		switch (value) {
			case 'local': return BackendMode.Local;
			case 'cloud-reasoning': return BackendMode.CloudReasoning;
			case 'manual': return BackendMode.Manual;
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

	private async _localReasonerAlreadyRunning(): Promise<boolean> {
		// Only probe loopback addresses — never touch a configured remote URL here.
		const url = this.reasoningUrl;
		if (!this._isLoopback(url)) {
			return false;
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 1500);
			const resp = await fetch(`${url}/health`, { signal: controller.signal });
			clearTimeout(timer);
			return resp.ok;
		} catch {
			return false;
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
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
				clearTimeout(timer);
				if (resp.ok) {
					const body = await resp.json() as { workers_connected?: number };
					if (body.workers_connected && body.workers_connected > 0) {
						this._setWorkerState(WorkerState.Connected);
						return;
					}
				}
			} catch { /* retry */ }
			await new Promise<void>(r => setTimeout(r, 1500));
		}
		// Give up — leave WorkerState as Starting so the user sees something is in flight.
		this._logService.warn('[ChipOS SidecarElectron] Worker registration not observed within 60s');
		this._setWorkerState(WorkerState.Disconnected);
	}

	async stopBackend(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] stopBackend()');

		if (this._isSharedInstance) {
			const remaining = await this._invokeIpc('chipos:releaseRef', {
				workspaceRoot: this._resolveWorkspaceRoot(),
				callerId: this._callerId,
			});
			this._logService.info(`[ChipOS SidecarElectron] Released ref, remaining=${remaining}`);
			if (remaining && remaining > 0) {
				this._workerPid = undefined;
				this._setWorkerState(WorkerState.NotStarted);
				this._setState(SidecarState.NotStarted);
				return;
			}
		}

		await this._killProcessViaIpc('worker');
		this._setWorkerState(WorkerState.NotStarted);

		if (this._mode === BackendMode.Local) {
			await this._killProcessViaIpc('reasoner');
		}

		this._setState(SidecarState.NotStarted);
	}

	async restartWorker(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] restartWorker()');
		this._clearWorkerTokenRefreshTimer();
		await this._killProcessViaIpc('worker');
		await this._spawnWorkerViaIpc();
	}

	// ── Worker JWT auto-refresh ──────────────────────────────────────────

	/**
	 * Schedule a one-shot timer that re-mints the worker_token + respawns the
	 * Worker process before the current token expires. Reads ``exp`` straight
	 * from the JWT so we honor whatever the website handed us, falling back to
	 * ``expires_in`` when the JWT can't be parsed.
	 *
	 * Clears any existing timer first — the most recent spawn always wins.
	 */
	private _scheduleWorkerTokenRefresh(token: string | undefined, fallbackExpiresInS: number | undefined): void {
		this._clearWorkerTokenRefreshTimer();
		if (!token) {
			return; // dev / api_key path — nothing to refresh
		}
		const expEpochMs = parseJwtExpMs(token);
		const nowMs = Date.now();
		const expiresInMs = expEpochMs > 0
			? expEpochMs - nowMs
			: (fallbackExpiresInS ?? 0) * 1000;
		// Refresh 30 min before expiry, but never sooner than 60s (avoid spin)
		// and never more than 23h out (so a misconfigured server-side exp can't
		// stretch our refresh interval indefinitely).
		const REFRESH_MARGIN_MS = 30 * 60 * 1000;
		const MIN_DELAY_MS = 60 * 1000;
		const MAX_DELAY_MS = 23 * 60 * 60 * 1000;
		const delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, expiresInMs - REFRESH_MARGIN_MS));
		this._workerTokenRefreshTimer = setTimeout(() => {
			this._workerTokenRefreshTimer = undefined;
			this._refreshWorkerTokenAndRespawn().catch(err => {
				this._logService.warn('[ChipOS SidecarElectron] worker_token auto-refresh failed:', String(err));
			});
		}, delayMs);
		this._logService.info('[ChipOS SidecarElectron] worker_token auto-refresh scheduled in %dms', delayMs);
	}

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
			this._logService.info('[ChipOS SidecarElectron] worker_token nearing expiry — respawning Worker');
			await this.restartWorker();
		} finally {
			this._refreshingWorkerToken = false;
		}
	}

	override dispose(): void {
		this._clearWorkerTokenRefreshTimer();
		if (this._isSharedInstance) {
			// R50 fix: dispose 时也要检查 ref_count 归零并 kill Worker
			this._invokeIpc('chipos:releaseRef', {
				workspaceRoot: this._resolveWorkspaceRoot(),
				callerId: this._callerId,
			}).then((remaining: number | undefined) => {
				if (!remaining || remaining <= 0) {
					this._logService.info('[ChipOS SidecarElectron] dispose: ref_count=0, killing Worker');
					this._invokeIpc('chipos:killProcess', 'worker').catch(() => {});
				}
			}).catch(() => {});
		}

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

		super.dispose();
	}

	// ── v1 兼容 ──────────────────────────────────────────────────────────

	async spawn(): Promise<void> { return this.startBackend(); }
	async kill(): Promise<void> { return this.stopBackend(); }
	setManualUrl(_url: string | undefined): void { /* noop */ }

	// ── Private: IPC 委托 ────────────────────────────────────────────────

	private _resolveBackendDir(): string {
		const explicit = this._configurationService.getValue<string>('chipos.backend.dir');
		if (explicit) {
			return explicit;
		}
		const appRoot = this._environmentService.appRoot;
		const productDir = join(appRoot, 'resources', 'chipos-backend');
		const devDir = join(appRoot, '..', 'backend_v2');
		if (appRoot.includes('/out/') || appRoot.endsWith('/out')) {
			return devDir;
		}
		return productDir;
	}

	private _resolveWorkspaceRoot(): string {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders[0].uri.fsPath;
		}
		return '';
	}

	private async _spawnReasonerViaIpc(): Promise<void> {
		this._logService.info('[ChipOS SidecarElectron] Spawning reasoner via IPC...');

		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';
		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		const grpcPort = this._configurationService.getValue<number>('chipos.backend.grpcPort') ?? 50051;

		const env: Record<string, string> = {
			CHIPOS_REASONING_HTTP_PORT: String(httpPort),
			CHIPOS_REASONING_GRPC_PORT: String(grpcPort),
			CHIPOS_DEPLOYMENT_MODE: 'local',
		};

		try {
			const result = await this._invokeIpc('chipos:spawnProcess', {
				pythonPath,
				moduleArgs: ['-m', 'reasoning.server.cli', 'start'],
				env,
				cwd: this._resolveBackendDir(),
				role: 'reasoner',
			});
			this._logService.info(`[ChipOS SidecarElectron] Reasoner spawned: pid=${result?.pid}`);
		} catch (err) {
			throw new Error(`IPC spawn reasoner failed: ${err}`);
		}
	}

	/**
	 * R49 + R50: Worker 启动（二进制优先 + 多窗口隔离）
	 *
	 * 启动策略：
	 *   1. chipos:checkInstance → 已有 Worker → acquireRef → done
	 *   2. chipos:findBinary → 有缓存二进制 → spawn 二进制
	 *   3. chipos:downloadBinary → 自动下载 → spawn 二进制
	 *   4. fallback → spawn Python
	 */
	private async _spawnWorkerViaIpc(): Promise<void> {
		this._setWorkerState(WorkerState.Starting);

		const grpcTarget = this.grpcAddress;
		// Phase 1 Unified Auth: settings > product.json > legacy backend.token.
		const workerApiKey = resolveWorkerApiKey(this._configurationService, this._productService);
		const workerHttpPort = this._configurationService.getValue<number>('chipos.backend.workerHttpPort') ?? 8081;
		const tlsEnabled = this._configurationService.getValue<boolean>('chipos.backend.tlsEnabled') ?? false;
		const workspaceRoot = this._resolveWorkspaceRoot();
		const configDownloadUrl = this._configurationService.getValue<string>('chipos.worker.downloadUrl') || '';
		const configVersion = this._configurationService.getValue<string>('chipos.worker.version') || 'latest';
		const backendDir = this._resolveBackendDir();
		// NEW-1: pin --mcp-config explicitly so the worker doesn't fall through
		// to `cwd/mcp_servers.json` (which is whatever directory cp.spawn used).
		// We pass `~/...` literally because the worker's CLI runs Path(...).expanduser()
		// — see resolve_mcp_config_path in execution.executor.mcp_loader.
		const mcpConfigPath = resolveWorkerMcpConfigPath(this._configurationService);

		// Phase 1.5 Worker JWT: when the user is logged in, mint a Worker JWT
		// from the website. Reasoner trusts the embedded user_id and hard-rejects
		// cross-user task scheduling. Falls back to the legacy api_key path when
		// the user is not logged in or the website is unreachable — that mode
		// keeps the existing dev-only loopback behavior.
		let workerToken: string | undefined;
		let workerTokenExpiresInS: number | undefined;
		if (this._authService.isLoggedIn()) {
			try {
				const tokenResult = await this._authService.getWorkerToken();
				workerToken = tokenResult?.worker_token;
				workerTokenExpiresInS = tokenResult?.expires_in;
				if (workerToken) {
					this._logService.info('[ChipOS SidecarElectron] Minted worker_token (expires_in=%ds)', tokenResult!.expires_in);
				} else {
					this._logService.warn('[ChipOS SidecarElectron] worker_token mint returned empty; falling back to api_key path');
				}
			} catch (err) {
				this._logService.warn('[ChipOS SidecarElectron] worker_token mint threw, falling back to api_key:', String(err));
			}
		}
		// Phase 2: schedule auto-refresh ahead of expiry. Without this the Worker
		// keeps presenting an expired token after ~24h and Reasoner UNAUTHENTICATEDs
		// every reconnect — user has to manually restart the IDE. We respawn the
		// sidecar with a freshly-minted token instead.
		this._scheduleWorkerTokenRefresh(workerToken, workerTokenExpiresInS);

		const env: Record<string, string> = {
			CHIPOS_REASONING_SERVER: grpcTarget,
			CHIPOS_WORKER_HTTP_PORT: String(workerHttpPort),
			CHIPOS_TLS_ENABLED: String(tlsEnabled),
			// Phase 1.5: signed Worker JWT (preferred). Reasoner verifies the
			// signature and extracts user_id from the payload — the Worker no
			// longer needs to self-report user identity.
			...(workerToken ? { CHIPOS_WORKER_TOKEN: workerToken } : {}),
			// P1-6: Worker → Reasoner gRPC API key (legacy / dev fallback).
			// Reasoner reads CHIPOS_WORKER_OUTBOUND_KEY (preferred) and falls back
			// to CHIPOS_API_KEY, so we set both for forward + backward compatibility.
			...(workerApiKey ? {
				CHIPOS_WORKER_OUTBOUND_KEY: workerApiKey,
				CHIPOS_API_KEY: workerApiKey,
			} : {}),
			...(workspaceRoot ? { CHIPOS_WORKSPACE_ROOT: workspaceRoot } : {}),
		};

		// --- Step 1: Check existing Worker instance (R50 multi-window) ---
		const existing = await this._invokeIpc('chipos:checkInstance', { workspaceRoot });
		if (existing?.alive) {
			this._logService.info(`[ChipOS SidecarElectron] Existing Worker (pid=${existing.pid}), acquiring ref`);
			await this._invokeIpc('chipos:acquireRef', { workspaceRoot, callerId: this._callerId });
			this._workerPid = existing.pid;
			this._isSharedInstance = true;
			// Don't blindly trust PID alive = HTTP ready; verify the Worker
			// is actually serving before declaring Connected.
			this._setWorkerState(WorkerState.Starting);
			return;
		}

		// --- Step 2: Find cached binary (R49) ---
		let binaryPath = await this._invokeIpc('chipos:findBinary', {
			version: configVersion !== 'latest' ? configVersion : undefined,
		});

		// --- Step 3: Auto-download if no cache ---
		if (!binaryPath) {
			this._logService.info('[ChipOS SidecarElectron] No cached binary, trying download...');
			binaryPath = await this._invokeIpc('chipos:downloadBinary', {
				version: configVersion,
				downloadUrl: configDownloadUrl || undefined,
			});
		}

		// --- Step 4: Spawn binary or fallback to Python ---
		if (binaryPath) {
			this._logService.info(`[ChipOS SidecarElectron] Spawning binary: ${binaryPath}`);
			try {
				const result = await this._invokeIpc('chipos:spawnProcess', {
					binaryPath,
					args: ['start', '--server', grpcTarget, '--workspace', workspaceRoot,
						'--http-port', String(workerHttpPort),
						'--mcp-config', mcpConfigPath],
					env,
					cwd: workspaceRoot,
					role: 'worker',
					workspaceRoot,
				});
				this._workerPid = result?.pid;
				this._isSharedInstance = true;
				this._logService.info(`[ChipOS SidecarElectron] Binary Worker spawned: pid=${this._workerPid}`);
				return;
			} catch (err) {
				this._logService.warn(`[ChipOS SidecarElectron] Binary spawn failed: ${err}, falling back to Python`);
			}
		}

		// --- Fallback: Python ---
		const pythonPath = this._configurationService.getValue<string>('chipos.backend.pythonPath') ?? 'python3';

		try {
			const result = await this._invokeIpc('chipos:spawnProcess', {
				pythonPath,
				moduleArgs: ['-m', 'execution.server.cli', 'start', '--server', grpcTarget,
					'--workspace', workspaceRoot, '--http-port', String(workerHttpPort),
					'--mcp-config', mcpConfigPath],
				env,
				cwd: backendDir,
				role: 'worker',
				workspaceRoot,
			});
			this._workerPid = result?.pid;
			this._isSharedInstance = true;
			this._logService.info(`[ChipOS SidecarElectron] Python Worker spawned: pid=${this._workerPid}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ChipOS SidecarElectron] Worker start failed: ${msg}`);
			this._setWorkerState(WorkerState.Error);
		}
	}

	private async _killProcessViaIpc(role: 'reasoner' | 'worker'): Promise<void> {
		try {
			await this._invokeIpc('chipos:killProcess', role);
			if (role === 'worker') {
				this._workerPid = undefined;
				this._isSharedInstance = false;
			}
		} catch (err) {
			this._logService.warn(`[ChipOS SidecarElectron] kill ${role} failed: ${err}`);
		}
	}

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
	 * because we just spawned the worker, not adopting an existing one. */
	private async _observeWorkerRegistrationAfterSpawn(): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (this._store.isDisposed) { return; }
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 3000);
				const resp = await fetch(`${this.reasoningUrl}/health`, { signal: controller.signal });
				clearTimeout(timer);
				if (resp.ok) {
					const body = await resp.json() as { workers_connected?: number };
					if (body.workers_connected && body.workers_connected > 0) {
						this._setWorkerState(WorkerState.Connected);
						this._logService.info('[ChipOS SidecarElectron] Worker registered with reasoner');
						return;
					}
				}
			} catch { /* retry */ }
			await new Promise<void>(r => setTimeout(r, 1000));
		}
		// Worker never showed up — keep SidecarState.Connected (Reasoner is fine)
		// but flag Worker explicitly so the UI/Chat layer can warn the user.
		this._logService.warn('[ChipOS SidecarElectron] Worker registration not observed within 30s after spawn');
		this._setWorkerState(WorkerState.Error);
	}

	private async _invokeIpc(channel: string, ...args: any[]): Promise<any> {
		const bridge = (globalThis as any).chiposIpc;
		if (!bridge) {
			const msg = `ChipOS IPC bridge not available for "${channel}". IDE installation may be incomplete.`;
			this._logService.error(`[ChipOS SidecarElectron] ${msg}`);
			throw new Error(msg);
		}
		return bridge.invoke(channel, ...args);
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
		}
	}
}

/**
 * Decode the ``exp`` claim from a JWT without verifying the signature.
 * Returns 0 when the token is malformed — caller should use a fallback.
 *
 * Signature verification is the Reasoner's job; here we only need the expiry
 * timestamp to schedule a local refresh, so we deliberately skip verification.
 */
function parseJwtExpMs(token: string): number {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) {
			return 0;
		}
		// JWT base64url → base64
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = b64 + '==='.slice((b64.length + 3) % 4);
		const json = JSON.parse(atob(padded));
		return typeof json.exp === 'number' ? json.exp * 1000 : 0;
	} catch {
		return 0;
	}
}
