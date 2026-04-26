/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * IPC contract for the REH-side ChipOS Remote Worker service.
 *
 * Path-3 Stage-2: when the local IDE is connected to a chipos-server REH, the
 * IDE asks the REH to spawn the Worker locally on the remote (no second SSH
 * needed). The IDE→REH RPC goes through this channel.
 *
 * Older REHs (vanilla code-server, or chipos-server prior to Stage-2) won't
 * register this channel; the IDE detects that and falls back to the SSH path
 * exposed by the chipos-remote-ssh extension (Stage-1).
 */

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ChiposRemoteWorkerChannelName = 'chipos-worker';

/** Args sent from local IDE to REH service. */
export interface IEnsureRemoteWorkerArgs {
	/** gRPC target the Worker should dial back to the Reasoner. Always loopback on REH side. */
	reasonerGrpcTarget: string;
	/** Absolute path to the workspace folder on the REH host. */
	workspaceRoot: string;
	/** Optional override of the Worker binary version (defaults to whatever is cached). */
	preferredVersion?: string;
	/** Optional override of the Worker HTTP port. */
	workerHttpPort?: number;
	/**
	 * Worker → Reasoner gRPC API key (legacy / static fallback).
	 *
	 * Used when the user is NOT logged in (no OAuth) or the website rejected
	 * the worker-token exchange. Reasoner side reads `CHIPOS_WORKER_OUTBOUND_KEY`
	 * (preferred) / `CHIPOS_API_KEY` (legacy alias).
	 *
	 * Resolved on IDE side via `chiposEndpoints.resolveWorkerApiKey()`
	 * (settings > product.json > legacy backend.token).
	 *
	 * Phase 1.5+ deployments should prefer `workerToken` (OAuth-vended,
	 * short-TTL, signed by website) and treat this as fallback only.
	 */
	workerApiKey?: string;
	/**
	 * Phase 1.5 Worker JWT minted by the website for the logged-in user.
	 *
	 * When provided, takes precedence over `workerApiKey`. Forwarded into
	 * the spawned Worker process as `CHIPOS_WORKER_TOKEN` env. Reasoner
	 * verifies the signature and extracts user_id from the payload — Worker
	 * no longer needs to self-report user identity.
	 */
	workerToken?: string;
	/** Whether to enable TLS for Worker → Reasoner gRPC. */
	tlsEnabled?: boolean;
	/**
	 * Worker-side MCP servers JSON config path (NEW-1).
	 *
	 * IDE-resolved via `resolveWorkerMcpConfigPath()` (settings >
	 * `~/.chipos/mcp_servers.json` default). MAY contain `~` — the worker's
	 * own `Path(...).expanduser()` resolves it on the REH host's filesystem.
	 *
	 * If unset the REH falls back to the same default. The arg exists so
	 * IDE-side `chipos.worker.mcpConfigPath` overrides take effect against
	 * REH-spawned workers, not just SSH-spawned ones.
	 */
	mcpConfigPath?: string;
}

/** Result returned to the local IDE. */
export interface IEnsureRemoteWorkerResult {
	ok: boolean;
	/** Worker PID on REH host. */
	pid?: number;
	/** Worker HTTP port on REH host (loopback). */
	httpPort?: number;
	/** Which strategy ran on the REH side, useful for IDE-side telemetry. */
	strategy?: 'reused-instance' | 'spawned-binary' | 'spawned-python';
	/** Total time spent in the REH service, milliseconds. */
	elapsedMs?: number;
	/** Populated when ok=false. */
	error?: string;
}

/** Args for releasing a ref count when an IDE window disconnects. */
export interface IReleaseRemoteWorkerArgs {
	workspaceRoot: string;
}

export interface IChiposRemoteWorkerService {
	readonly _serviceBrand: undefined;

	/**
	 * Ensure a Worker process is running for the given workspace.
	 *
	 * Idempotent: if a healthy Worker already exists for this workspace (per
	 * `~/.chipos/instances/<wsHash>/instance.json`), the service acquires a
	 * ref instead of spawning a duplicate.
	 *
	 * Returns ok=false (with `error` populated) on irrecoverable failure;
	 * the IDE will fall back to the SSH path.
	 */
	ensureWorker(args: IEnsureRemoteWorkerArgs): Promise<IEnsureRemoteWorkerResult>;

	/**
	 * Release the IDE-side ref count for this workspace. When ref_count drops
	 * to zero the Worker is terminated.
	 */
	releaseWorker(args: IReleaseRemoteWorkerArgs): Promise<void>;
}

export const IChiposRemoteWorkerService = createDecorator<IChiposRemoteWorkerService>('chiposRemoteWorkerService');
