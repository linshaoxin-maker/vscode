/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * REH-side implementation of IChiposRemoteWorkerService.
 *
 * Runs in the chipos-server (REH) Node process. Reuses the same `~/.chipos/`
 * cache layout as the local Electron / chipos-remote-ssh paths so a single
 * Worker binary is shared across all entry points on a given host.
 *
 * Strategy order (matches sidecarManagerMain / WorkerManager):
 *   1. Existing healthy Worker (instance.json + PID alive) → acquire ref
 *   2. Cached binary in ~/.chipos/workers/<ver>/ → spawn binary
 *   3. Otherwise → return error (IDE-side falls back to SSH path which can
 *      curl a binary on the remote and retry)
 *
 * We deliberately do NOT auto-download or run a Python fallback here:
 *   - Stage-1 (chipos-remote-ssh) already does both, with a richer UX
 *     (progress, fallback selection, password prompts).
 *   - Keeping REH-side simple reduces the surface area shipped in REH and
 *     means a Stage-2 failure cleanly degrades to Stage-1.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IChiposRemoteWorkerService, IEnsureRemoteWorkerArgs, IEnsureRemoteWorkerResult, IReleaseRemoteWorkerArgs } from '../common/chiposRemoteWorker.js';

const LOG_PREFIX = '[ChipOS Worker REH]';

interface InstanceMeta {
	pid: number;
	workspace: string;
	http_port: number;
	ref_count: number;
	refs?: string[];
	started_at: string;
	version?: string;
}

function chiposHome(): string {
	return process.env['CHIPOS_HOME'] ?? path.join(os.homedir(), '.chipos');
}

/**
 * Canonicalize before hashing — see sidecarManagerMain.ts for the full
 * story. Short version: macOS `/tmp` vs `/private/tmp`, symlinked project
 * dirs, and Windows junctions can produce different fs paths for the same
 * physical directory, which would hash to different instance dirs and
 * fork a second worker for what's really the same workspace. realpath
 * collapses the aliases. Falls back to the as-given path if realpath
 * raises (workspace gone, network drive unmounted, etc.) so we degrade
 * to the previous broken-but-non-crashing behavior instead of refusing
 * to spawn at all.
 *
 * MUST stay byte-identical to the sidecarManagerMain.ts copy — if these
 * two drift the local Electron path and the REH path will hash to
 * different dirs again, reintroducing the dual-worker bug.
 */
function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
	try {
		return fs.realpathSync(workspaceRoot);
	} catch {
		return workspaceRoot;
	}
}

function workspaceHash(workspaceRoot: string): string {
	const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
	return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 12);
}

function instanceDir(workspaceRoot: string): string {
	return path.join(chiposHome(), 'instances', workspaceHash(workspaceRoot));
}

function instanceJsonPath(workspaceRoot: string): string {
	return path.join(instanceDir(workspaceRoot), 'instance.json');
}

function readInstanceJson(workspaceRoot: string): InstanceMeta | undefined {
	const p = instanceJsonPath(workspaceRoot);
	if (!fs.existsSync(p)) {
		return undefined;
	}
	try {
		const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
		return data as InstanceMeta;
	} catch {
		return undefined;
	}
}

function writeInstanceJson(workspaceRoot: string, meta: InstanceMeta): void {
	const dir = instanceDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(instanceJsonPath(workspaceRoot), JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function detectPlatformTag(): string {
	const platform = os.platform();
	const arch = os.arch();
	if (platform === 'linux' && arch === 'x64') { return 'linux-x64'; }
	if (platform === 'linux' && arch === 'arm64') { return 'linux-arm64'; }
	if (platform === 'darwin' && arch === 'x64') { return 'darwin-x64'; }
	if (platform === 'darwin' && arch === 'arm64') { return 'darwin-arm64'; }
	if (platform === 'win32' && arch === 'x64') { return 'win32-x64'; }
	throw new Error(`Unsupported REH platform: ${platform}-${arch}`);
}

/**
 * Find the most recent cached binary, or the one matching `preferredVersion`.
 * Returns undefined if no binary is cached (caller should fall back to SSH path).
 */
function findCachedBinary(preferredVersion?: string): { binaryPath: string; version: string } | undefined {
	const tag = detectPlatformTag();
	const name = `chipos-worker-${tag}`;
	const workersDir = path.join(chiposHome(), 'workers');
	if (!fs.existsSync(workersDir)) {
		return undefined;
	}

	if (preferredVersion) {
		const explicit = path.join(workersDir, preferredVersion, name);
		if (fs.existsSync(explicit)) {
			return { binaryPath: explicit, version: preferredVersion };
		}
	}

	const versions = fs.readdirSync(workersDir)
		.filter(d => fs.existsSync(path.join(workersDir, d, name)))
		.sort()
		.reverse();
	if (versions.length === 0) {
		return undefined;
	}
	const latest = versions[0];
	return { binaryPath: path.join(workersDir, latest, name), version: latest };
}

export class ChiposRemoteWorkerService extends Disposable implements IChiposRemoteWorkerService {

	declare readonly _serviceBrand: undefined;

	/** PID of the worker process this service spawned (if any). */
	private _spawnedPid: number | undefined;
	/** Reference count tracker per workspace, keyed by workspaceRoot. */
	private readonly _refs = new Map<string, number>();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._logService.info(`${LOG_PREFIX} service constructed, chiposHome=${chiposHome()}`);
	}

	async ensureWorker(args: IEnsureRemoteWorkerArgs): Promise<IEnsureRemoteWorkerResult> {
		const t0 = Date.now();
		const { reasonerGrpcTarget, workspaceRoot, preferredVersion } = args;
		const workerHttpPort = args.workerHttpPort ?? 8081;

		this._logService.info(`${LOG_PREFIX} ensureWorker target=${reasonerGrpcTarget} ws=${workspaceRoot} preferredVer=${preferredVersion ?? '(any)'} httpPort=${workerHttpPort}`);

		// (1) Reuse existing instance if alive.
		const existing = readInstanceJson(workspaceRoot);
		if (existing && isPidAlive(existing.pid)) {
			const newCount = (this._refs.get(workspaceRoot) ?? 0) + 1;
			this._refs.set(workspaceRoot, newCount);
			existing.ref_count = (existing.ref_count ?? 1) + 1;
			writeInstanceJson(workspaceRoot, existing);
			this._logService.info(`${LOG_PREFIX} strategy=reused-instance pid=${existing.pid} refCount=${existing.ref_count} elapsed=${Date.now() - t0}ms`);
			return {
				ok: true,
				pid: existing.pid,
				httpPort: existing.http_port,
				strategy: 'reused-instance',
				elapsedMs: Date.now() - t0,
			};
		}

		// (2) Spawn from cached binary.
		const cached = findCachedBinary(preferredVersion);
		if (!cached) {
			this._logService.warn(`${LOG_PREFIX} no cached binary in ${path.join(chiposHome(), 'workers')} — returning error so IDE can fall back`);
			return {
				ok: false,
				error: 'No cached Worker binary on REH host (REH-side download not implemented; falling back to SSH path)',
				elapsedMs: Date.now() - t0,
			};
		}

		this._logService.info(`${LOG_PREFIX} spawning binary=${cached.binaryPath} v${cached.version}`);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			CHIPOS_REASONING_SERVER: reasonerGrpcTarget,
			CHIPOS_WORKER_HTTP_PORT: String(workerHttpPort),
			CHIPOS_WORKSPACE_ROOT: workspaceRoot,
		};

		// Phase 1.5 Worker JWT (preferred when present): IDE minted via OAuth,
		// signed by website, Reasoner verifies + extracts user_id from payload.
		if (args.workerToken) {
			env.CHIPOS_WORKER_TOKEN = args.workerToken;
			this._logService.info(`${LOG_PREFIX} auth source=worker-token (Phase 1.5 OAuth-vended)`);
		}

		// Worker → Reasoner gRPC API key (legacy / fallback when not logged in).
		// Priority:
		//   1. args.workerApiKey       (IDE-supplied via RPC — primary path)
		//   2. CHIPOS_WORKER_OUTBOUND_KEY in REH process env (operator-pinned)
		//   3. CHIPOS_API_KEY in REH process env (legacy fallback)
		//
		// Without either workerToken OR an apiKey, the Worker fails Reasoner auth
		// with WORKER_AUTH_FAILED when the Reasoner has authentication enabled.
		const apiKey = args.workerApiKey
			|| process.env['CHIPOS_WORKER_OUTBOUND_KEY']
			|| process.env['CHIPOS_API_KEY'];
		if (apiKey) {
			env.CHIPOS_WORKER_OUTBOUND_KEY = apiKey;
			env.CHIPOS_API_KEY = apiKey;
			if (!args.workerToken) {
				this._logService.info(`${LOG_PREFIX} auth source=api-key (${args.workerApiKey ? 'rpc-args' : 'reh-env'})`);
			}
		} else if (!args.workerToken) {
			this._logService.info(`${LOG_PREFIX} no auth credentials configured (assuming Reasoner is unauthenticated)`);
		}

		if (args.tlsEnabled) {
			env.CHIPOS_TLS_ENABLED = 'true';
		}

		const dir = instanceDir(workspaceRoot);
		fs.mkdirSync(dir, { recursive: true });

		// NEW-1: pin --mcp-config explicitly. IDE may pass an override; otherwise
		// fall back to the same `~/.chipos/mcp_servers.json` default the SSH path
		// uses, so a worker spawned by REH and a worker spawned by chipos-remote-ssh
		// land on identical config without per-host setup.
		const mcpConfigPath = args.mcpConfigPath || '~/.chipos/mcp_servers.json';

		let proc: cp.ChildProcess;
		try {
			proc = cp.spawn(
				cached.binaryPath,
				[
					'start',
					'--server', reasonerGrpcTarget,
					'--workspace', workspaceRoot,
					'--http-port', String(workerHttpPort),
					'--instance-dir', dir,
					'--mcp-config', mcpConfigPath,
				],
				{
					cwd: workspaceRoot,
					stdio: ['ignore', 'pipe', 'pipe'],
					env,
					detached: true,
				},
			);
		} catch (spawnErr) {
			const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
			this._logService.error(`${LOG_PREFIX} spawn threw: ${msg}`);
			return { ok: false, error: `Spawn failed: ${msg}`, elapsedMs: Date.now() - t0 };
		}

		if (!proc.pid) {
			return { ok: false, error: 'Spawn returned no PID', elapsedMs: Date.now() - t0 };
		}

		// Stdout/stderr → log (cheap diagnostic).
		proc.stdout?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) { this._logService.info(`${LOG_PREFIX} [stdout] ${line}`); }
		});
		proc.stderr?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) { this._logService.warn(`${LOG_PREFIX} [stderr] ${line}`); }
		});
		proc.once('exit', (code, signal) => {
			this._logService.info(`${LOG_PREFIX} worker pid=${proc.pid} exited code=${code} signal=${signal}`);
			this._spawnedPid = undefined;
		});
		proc.unref();

		this._spawnedPid = proc.pid;
		this._refs.set(workspaceRoot, (this._refs.get(workspaceRoot) ?? 0) + 1);

		// Persist instance metadata (Worker may also write its own; first-write wins
		// and we update ref_count on subsequent ensureWorker calls).
		const meta: InstanceMeta = {
			pid: proc.pid,
			workspace: workspaceRoot,
			http_port: workerHttpPort,
			ref_count: 1,
			refs: ['reh-self'],
			started_at: new Date().toISOString(),
			version: cached.version,
		};
		try {
			writeInstanceJson(workspaceRoot, meta);
		} catch (writeErr) {
			this._logService.warn(`${LOG_PREFIX} could not write instance.json: ${writeErr}`);
		}

		const elapsed = Date.now() - t0;
		this._logService.info(`${LOG_PREFIX} strategy=spawned-binary pid=${proc.pid} httpPort=${workerHttpPort} elapsed=${elapsed}ms`);

		return {
			ok: true,
			pid: proc.pid,
			httpPort: workerHttpPort,
			strategy: 'spawned-binary',
			elapsedMs: elapsed,
		};
	}

	async releaseWorker(args: IReleaseRemoteWorkerArgs): Promise<void> {
		const { workspaceRoot } = args;
		const current = this._refs.get(workspaceRoot) ?? 0;
		const next = Math.max(0, current - 1);
		this._refs.set(workspaceRoot, next);

		this._logService.info(`${LOG_PREFIX} releaseWorker ws=${workspaceRoot} ref ${current} → ${next}`);

		const meta = readInstanceJson(workspaceRoot);
		if (meta) {
			meta.ref_count = Math.max(0, (meta.ref_count ?? 1) - 1);
			try {
				writeInstanceJson(workspaceRoot, meta);
			} catch { /* ignore */ }
		}

		// If ref count drops to zero AND we're the spawner, terminate the Worker.
		if (next === 0 && this._spawnedPid && meta && meta.pid === this._spawnedPid) {
			this._logService.info(`${LOG_PREFIX} ref_count=0, terminating worker pid=${this._spawnedPid}`);
			try {
				process.kill(this._spawnedPid, 'SIGTERM');
				setTimeout(() => {
					if (this._spawnedPid && isPidAlive(this._spawnedPid)) {
						try { process.kill(this._spawnedPid, 'SIGKILL'); } catch { /* gone */ }
					}
				}, 5000);
			} catch (err) {
				this._logService.warn(`${LOG_PREFIX} kill failed: ${err}`);
			}
			this._spawnedPid = undefined;
		}
	}
}
