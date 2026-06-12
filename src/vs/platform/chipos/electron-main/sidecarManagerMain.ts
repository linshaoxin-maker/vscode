/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * sidecarManagerMain — Electron main-process IPC handlers for local Worker
 * lifecycle (cache lookup, GitHub-release download, spawn, kill, instance.json
 * + ref counting).
 *
 * This is the local-IDE counterpart to chipos-remote-ssh's WorkerManager.ts —
 * the renderer (sidecarManagerElectron) is the orchestrator (it owns config /
 * auth / JWT / settings), this file just provides the mechanics that need
 * Node APIs unavailable in the renderer.
 *
 * Architectural note: an earlier iteration of this file existed and was
 * removed by aca4974224a (refactor "IDE never spawns backends"). That refactor
 * was over-aggressive — for the "local IDE + remote Reasoner + local files"
 * deployment, no SSH-Remote and no chipos-server REH means *nobody* spawns
 * the Worker, leaving the IDE pointing at a dead 127.0.0.1:8081. This file
 * brings back the local spawn path on parity with the SSH path.
 *
 * IPC contract (renderer ↔ main). Channels prefixed `vscode:chipos:` because
 * `validatedIpcMain.validateEvent` rejects anything not under `vscode:`:
 *   vscode:chipos:findBinary       scan ~/.chipos/workers/<ver>/<binary> cache
 *   vscode:chipos:downloadBinary   GitHub release tar.gz → extract → cache
 *   vscode:chipos:spawnProcess     spawn binary with args/env, track per-window
 *   vscode:chipos:killProcess      SIGTERM → wait → SIGKILL by role/window
 *   vscode:chipos:checkInstance    read instance.json + verify PID alive
 *   vscode:chipos:acquireRef       ref_count++ (multi-window share)
 *   vscode:chipos:releaseRef       ref_count--
 *   vscode:chipos:ensureMcpConfig  write default ~/.chipos/mcp_servers.json
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { app, BrowserWindow } from 'electron';
// `validatedIpcMain` adds sender + origin validation that bare `ipcMain` lacks;
// the layer-checker forbids the bare import in electron-main code.
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
// Shared standalone-folder / legacy single-file resolution (also used by the
// REH spawn path) so the worker cache layout is interpreted identically.
import { resolveWorkerBinary } from '../node/workerBinaryLayout.js';

// ── per-window managed processes ────────────────────────────────────────────

interface ManagedProcess {
	process: cp.ChildProcess;
	pid: number | undefined;
	role: 'reasoner' | 'worker';
	/**
	 * Binary path used for the original spawn. Retained so that the
	 * `vscode:chipos:eda-rescan` handler can re-spawn this exact binary in
	 * one-shot `scan-eda` mode without the renderer having to re-pass it
	 * (the renderer already paid the cost of locating it once).
	 */
	binaryPath: string;
	/**
	 * Env vars merged onto process.env at original spawn time. The one-shot
	 * `scan-eda` subprocess inherits the same PATH so a freshly-installed
	 * EDA tool placed where the worker would have seen it is also visible
	 * to the rescan probe.
	 */
	spawnEnv: Record<string, string>;
	/** cwd from original spawn — same rationale as spawnEnv. */
	spawnCwd: string;
}

/** windowId → role → process. */
const windowProcesses = new Map<number, Map<string, ManagedProcess>>();

export interface SpawnProcessArgs {
	/** Absolute path to a chipos-worker binary. Required. */
	binaryPath: string;
	/** CLI args excluding `--instance-dir` (added below from workspaceRoot). */
	args: string[];
	/** Extra env (merged onto process.env). */
	env: Record<string, string>;
	/** cwd for the spawned process. */
	cwd: string;
	role: 'worker' | 'reasoner';
	/** Workspace root — used to derive instance dir for `--instance-dir`. */
	workspaceRoot?: string;
}

export interface FindBinaryArgs {
	/** Pin to a specific cached version. Otherwise scans for newest. */
	version?: string;
	/** Override the binary base name; defaults to `chipos-worker-<platform-tag>`. */
	binaryName?: string;
}

export interface DownloadBinaryArgs {
	/**
	 * GitHub repo "owner/name" — read from product.json's
	 * chiposReleases.repo by the renderer and forwarded here.
	 */
	repo: string;
	/** "latest" → resolve via /releases/latest, or explicit "1.3.0". */
	version: string;
	/** Override the binary base name. */
	binaryName?: string;
	/** Override the download URL entirely (escape hatch / testing). */
	downloadUrl?: string;
}

export interface CheckInstanceArgs {
	workspaceRoot: string;
}

export interface RefArgs {
	workspaceRoot: string;
	callerId: string;
}

export interface EnsureMcpConfigArgs {
	/** Resolved path (with ~ expanded) — renderer is responsible. */
	mcpConfigPath: string;
}

// ── path / platform helpers ─────────────────────────────────────────────────

function chiposHome(): string {
	return process.env['CHIPOS_HOME'] ?? path.join(os.homedir(), '.chipos');
}

/**
 * F17: read PATH from the user's login shell — picks up entries the user
 * just added to ~/.bashrc / ~/.zshrc / ~/.profile without requiring a full
 * IDE restart. Used by the rescan handler.
 *
 * On macOS GUI launches, IDE inherits PATH from launchd (which doesn't read
 * shell rc files), so freshly-installed Vivado/OpenROAD in ~/.bashrc is
 * invisible. Running `<login-shell> -lc 'echo $PATH'` sources rc files in
 * exactly the same way a fresh terminal would.
 *
 * On Windows: skipped (no shell concept), returns undefined.
 * On unknown shell or non-zero exit: returns undefined and caller falls
 * back to cached env — safe degradation.
 *
 * Timeout: 2s (rc files shouldn't be that slow; if they are, the user has
 * worse problems than rescan latency).
 */
async function readLoginShellPath(): Promise<string | undefined> {
	if (process.platform === 'win32') { return undefined; }
	const shell = process.env['SHELL'] || '/bin/bash';
	return new Promise<string | undefined>((resolve) => {
		const child = cp.spawn(shell, ['-lc', 'printf %s "$PATH"'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* ignore */ }
			resolve(undefined);
		}, 2000);
		child.stdout?.on('data', (b: Buffer) => { stdout += b.toString(); });
		child.on('exit', (code) => {
			clearTimeout(timer);
			if (code === 0 && stdout.trim()) {
				resolve(stdout.trim());
			} else {
				resolve(undefined);
			}
		});
		child.on('error', () => {
			clearTimeout(timer);
			resolve(undefined);
		});
	});
}

/**
 * Canonicalize the workspace path before hashing so that aliases of the same
 * physical directory hash to the same instance dir.
 *
 * Background (2026-05-22): the dev IDE opened `/private/tmp/chipos-wave-demo`
 * while the prod IDE opened `/tmp/chipos-wave-demo`. macOS resolves both to
 * the same realpath, but `fs.fsPath` preserves whichever form the URI was
 * built from, so the two IDEs hashed to different instance dirs and ended
 * up spawning two separate workers (8081 + 8082) for the SAME physical
 * workspace. Same class of bug shows up with symlinked project dirs and
 * Windows junctions.
 *
 * Falls back to the as-given path if realpath throws (workspace doesn't
 * exist, network drive unmounted, permission denied, etc.) — the worker
 * keying becomes wrong in those edge cases but at least nothing crashes,
 * and the alternative would be refusing to spawn entirely.
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

/**
 * Path to the rolling stderr log for a spawned chipos process. The file lives
 * under ~/.chipos/logs/<role>-stderr.log and is opened in append mode so each
 * spawn writes a clearly-delimited block (banner + lines + exit footer) to the
 * same file — making it trivial to grep across crashes ("why did the worker
 * die last time?") instead of hunting in Electron's discarded console.log.
 *
 * Background: stderr from worker/reasoner used to be parsed only for
 * [EdaPack]/[EdaEnv] markers and the rest went to `console.log` in the
 * Electron main process — which is captured by neither renderer.log,
 * main.log, nor macOS unified log. Combined with the worker's
 * `finally: sys.exit(0)` swallowing the real exit code, this made every
 * worker crash look like a clean exit with no traceback.
 */
function stderrLogPath(role: 'worker' | 'reasoner'): string {
	return path.join(chiposHome(), 'logs', `${role}-stderr.log`);
}

function instanceLockPath(workspaceRoot: string): string {
	return path.join(instanceDir(workspaceRoot), 'instance.lock');
}

/** Match platform tags used by the build pipeline + GitHub release assets. */
function detectPlatformTag(): string {
	const osName = os.platform();
	const cpu = os.arch();
	if (osName === 'linux' && cpu === 'x64') { return 'linux-x64'; }
	if (osName === 'linux' && cpu === 'arm64') { return 'linux-arm64'; }
	if (osName === 'darwin' && cpu === 'x64') { return 'darwin-x64'; }
	if (osName === 'darwin' && cpu === 'arm64') { return 'darwin-arm64'; }
	if (osName === 'win32' && cpu === 'x64') { return 'win32-x64'; }
	return `${osName}-${cpu}`;
}

function defaultBinaryName(): string {
	return `chipos-worker-${detectPlatformTag()}`;
}

/**
 * Semver-aware descending compare. Cache version dirs are tagged like
 * `1.2.0`, `1.10.0` — plain string sort puts `1.10.0` BEFORE `1.2.0` and we'd
 * pick the wrong "latest". Returns versions sorted highest-first.
 *
 * Pre-release suffixes (e.g. `1.3.0-beta1`) are treated lower than plain
 * `1.3.0`, matching `sort -V` behavior.
 */
function compareVersionsDesc(a: string, b: string): number {
	const split = (s: string): { nums: number[]; pre: string } => {
		const dash = s.indexOf('-');
		const head = dash === -1 ? s : s.slice(0, dash);
		const pre = dash === -1 ? '' : s.slice(dash + 1);
		return {
			nums: head.split('.').map(p => parseInt(p, 10) || 0),
			pre,
		};
	};
	const sa = split(a);
	const sb = split(b);
	const len = Math.max(sa.nums.length, sb.nums.length);
	for (let i = 0; i < len; i++) {
		const da = sa.nums[i] ?? 0;
		const db = sb.nums[i] ?? 0;
		if (da !== db) { return db - da; } // descending
	}
	// Equal numeric components — pre-release < release.
	if (sa.pre && !sb.pre) { return 1; }
	if (!sa.pre && sb.pre) { return -1; }
	return sb.pre.localeCompare(sa.pre);
}

// ── instance.json (cross-process state for multi-window sharing) ────────────

interface InstanceMeta {
	pid?: number;
	workspace?: string;
	http_port?: number;
	ref_count?: number;
	/**
	 * Live refs holding this worker open. Each entry is one IDE main process
	 * that has acquireRef'd this workspace.
	 *
	 * `ide_pid` was added 2026-05-22 so the worker can self-GC stale entries
	 * when an IDE crashed / kill -9'd / power-lost without going through the
	 * release IPC. Worker periodically checks `os.kill(ide_pid, 0)` and
	 * evicts dead entries; when ref_count hits 0 after GC, worker graceful-
	 * shuts down. Legacy entries without ide_pid are kept (treated as alive
	 * forever) — the field is added by new acquireRef writes, so the leak
	 * fix naturally rolls in as IDEs upgrade.
	 */
	refs?: { caller_id: string; acquired_at: string; ide_pid?: number }[];
	started_at?: string;
	version?: string;
	/**
	 * Per-worker Bearer token for the Worker→IDE permission ASK SSE channel.
	 * See WORKER-PERMISSION-ASK-TRANSPORT §5.7. Empty/missing when the worker
	 * is a legacy build that doesn't expose permission endpoints.
	 */
	permission_token?: string;
	[k: string]: unknown;
}

function readInstanceJson(workspaceRoot: string): InstanceMeta | undefined {
	const f = instanceJsonPath(workspaceRoot);
	if (!fs.existsSync(f)) { return undefined; }
	try {
		return JSON.parse(fs.readFileSync(f, 'utf-8'));
	} catch {
		return undefined;
	}
}

function writeInstanceJson(workspaceRoot: string, data: InstanceMeta): void {
	const dir = instanceDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(instanceJsonPath(workspaceRoot), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Best-effort cross-process atomicity for ref_count read-modify-write.
 *
 * We use mkdir() with O_EXCL semantics (POSIX guarantees atomicity) on a
 * sibling .lock dir to serialize. `proper-lockfile` would be nicer but we
 * deliberately keep this dependency-free since this file runs in the main
 * process before module-graph init for many extensions.
 *
 * Spinwait up to ~1s — plenty for short critical sections (ref_count update
 * is two file ops). On contention we just write what we have; ref_count
 * accuracy is best-effort, the kill decision uses local-process tracking
 * as a backstop.
 */
async function withInstanceLock<T>(workspaceRoot: string, fn: () => T): Promise<T> {
	const lockDir = instanceLockPath(workspaceRoot);
	fs.mkdirSync(instanceDir(workspaceRoot), { recursive: true });
	const start = Date.now();
	while (Date.now() - start < 1000) {
		try {
			fs.mkdirSync(lockDir);
			try {
				return fn();
			} finally {
				try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
			}
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
				await delay(20);
				continue;
			}
			throw err;
		}
	}
	// Contention timeout — proceed unlocked. Worst case: ref_count off by 1.
	return fn();
}

/**
 * Synchronous twin of {@link withInstanceLock} for use in code paths that
 * MUST complete before the main process exits — specifically the
 * `'destroyed'` listener and `app.on('before-quit')` drains during Cmd+Q.
 *
 * The async version's `await delay(20)` yields back to the event loop, which
 * lets the IPC layer schedule but also lets `app.quit()` race ahead and
 * SIGTERM the process before the file lock is acquired. Same root-cause
 * class as the fire-and-forget IPC bug we were trying to fix in the first
 * place — async cleanup at quit time is just unreliable.
 *
 * Busy-waits with `Date.now()` instead. Burns CPU for at most ~1s; in
 * practice the only contention point is the main process competing with
 * itself across senders (rare), so we typically acquire on the first try.
 */
function withInstanceLockSync<T>(workspaceRoot: string, fn: () => T): T {
	const lockDir = instanceLockPath(workspaceRoot);
	fs.mkdirSync(instanceDir(workspaceRoot), { recursive: true });
	const start = Date.now();
	while (Date.now() - start < 1000) {
		try {
			fs.mkdirSync(lockDir);
			try {
				return fn();
			} finally {
				try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
			}
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
				// Busy-wait — no await/yield, this is the whole point.
				const spinEnd = Date.now() + 20;
				while (Date.now() < spinEnd) { /* spin */ }
				continue;
			}
			throw err;
		}
	}
	// Contention timeout — proceed unlocked. Worst case: ref_count off by 1.
	return fn();
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Probe the worker's loopback HTTP /health endpoint.
 *
 * 2026-05-11 fix for the "adopted dead worker" bug: `isPidAlive` alone is
 * insufficient on macOS Nuitka onefile builds. The launcher process and the
 * Python child have separate pids; instance.json records the child's pid
 * (`os.getpid()` inside cli.py). When the parent dies under stopBackend's
 * SIGTERM, the child may briefly remain in a zombie/exiting state — `kill -0`
 * still reports it alive even though it has unbound its HTTP socket and
 * cannot serve requests. The next `startBackend` then reads the stale
 * instance.json, sees an "alive" pid, calls `acquireRef` and reports
 * `[ChipOS Local] adopted existing worker`. The adopted worker is a corpse
 * with no HTTP server, so all subsequent SSE/decide/health requests fail
 * with "Failed to fetch" or hang.
 *
 * Verifying HTTP /health within a tight timeout (1.5s on loopback) gives a
 * trustworthy aliveness signal. Returns true only when the socket accepts a
 * connection AND the response is 200 within the budget. Any other outcome
 * — refused, ECONNREFUSED, timeout, 5xx — is treated as "not alive" and the
 * caller will unlink instance.json so the next spawn is fresh.
 */
function isWorkerHttpResponsive(port: number): Promise<boolean> {
	if (!port || port <= 0) {
		// Pre-permission-token worker builds didn't reliably emit http_port to
		// instance.json. Fall back to pid-only liveness for those — same as
		// the original behavior, just gated on the field being present.
		return Promise.resolve(true);
	}
	return new Promise<boolean>(resolve => {
		let settled = false;
		const finish = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const req = http.get({
				hostname: '127.0.0.1',
				port,
				path: '/health',
				timeout: 1500,
			}, res => {
				res.resume();
				finish(res.statusCode === 200);
			});
			req.on('error', () => finish(false));
			req.on('timeout', () => { req.destroy(); finish(false); });
		} catch {
			finish(false);
		}
	});
}

// ── per-window process tracking ────────────────────────────────────────────

function getWindowMap(windowId: number): Map<string, ManagedProcess> {
	let map = windowProcesses.get(windowId);
	if (!map) {
		map = new Map();
		windowProcesses.set(windowId, map);
	}
	return map;
}

function getProc(windowId: number, role: string): ManagedProcess | undefined {
	return windowProcesses.get(windowId)?.get(role);
}

function setProc(windowId: number, role: string, proc: ManagedProcess | undefined): void {
	const map = getWindowMap(windowId);
	if (proc) {
		map.set(role, proc);
	} else {
		map.delete(role);
		if (map.size === 0) {
			windowProcesses.delete(windowId);
		}
	}
}

function killManagedProcess(managed: ManagedProcess): Promise<boolean> {
	if (managed.process.killed) { return Promise.resolve(true); }
	managed.process.kill('SIGTERM');
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			if (!managed.process.killed) { managed.process.kill('SIGKILL'); }
			resolve(false);
		}, 5000);
		managed.process.on('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function cleanupWindow(windowId: number): void {
	const map = windowProcesses.get(windowId);
	if (!map) { return; }
	for (const [role, managed] of map) {
		console.log(`[ChipOS Sidecar] Cleaning up ${role} for window ${windowId}`);
		if (!managed.process.killed) {
			managed.process.kill('SIGTERM');
			setTimeout(() => {
				if (!managed.process.killed) { managed.process.kill('SIGKILL'); }
			}, 3000);
		}
	}
	windowProcesses.delete(windowId);
}

// ── HTTP fetch (no extra deps; only stdlib `https`) ─────────────────────────

interface HttpResponse {
	status: number;
	body: string;
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			headers: { 'User-Agent': 'chipos-ide-sidecar', ...headers },
			timeout: 15000,
		}, (res) => {
			// Follow up to 5 redirects.
			if (
				res.statusCode &&
				res.statusCode >= 300 && res.statusCode < 400 &&
				res.headers.location
			) {
				const next = new URL(res.headers.location, url).toString();
				res.resume();
				resolve(httpsGet(next, headers));
				return;
			}
			let body = '';
			res.setEncoding('utf-8');
			res.on('data', chunk => body += chunk);
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy(new Error('https.get timeout'));
		});
	});
}

/**
 * Download a file. Optional `onProgress` is called with bytes loaded and
 * total bytes (or undefined when Content-Length is missing). 2026-05-09:
 * progress hook added so the renderer can show a progress notification
 * during worker binary download (was silently spinning).
 */
function downloadFile(
	url: string,
	dest: string,
	onProgress?: (loaded: number, total: number | undefined) => void,
	redirectsLeft = 5,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			headers: { 'User-Agent': 'chipos-ide-sidecar' },
			timeout: 300000,
		}, (res) => {
			if (
				res.statusCode &&
				res.statusCode >= 300 && res.statusCode < 400 &&
				res.headers.location
			) {
				if (redirectsLeft <= 0) {
					reject(new Error('Too many redirects'));
					return;
				}
				const next = new URL(res.headers.location, url).toString();
				res.resume();
				resolve(downloadFile(next, dest, onProgress, redirectsLeft - 1));
				return;
			}
			if (!res.statusCode || res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
				return;
			}
			const totalHeader = res.headers['content-length'];
			const total = totalHeader ? parseInt(Array.isArray(totalHeader) ? totalHeader[0] : totalHeader, 10) : undefined;
			let loaded = 0;
			let lastReport = 0;
			res.on('data', (chunk: Buffer) => {
				loaded += chunk.length;
				if (onProgress) {
					// Throttle to ~10/s so we don't spam the renderer with IPC
					// for every TCP packet on a fast link.
					const now = Date.now();
					if (now - lastReport >= 100 || (total && loaded >= total)) {
						lastReport = now;
						onProgress(loaded, total);
					}
				}
			});
			const out = fs.createWriteStream(dest);
			res.pipe(out);
			out.on('finish', () => out.close(() => resolve()));
			out.on('error', err => {
				try { fs.unlinkSync(dest); } catch { /* ignore */ }
				reject(err);
			});
		});
		req.on('error', reject);
		req.on('timeout', () => req.destroy(new Error('downloadFile timeout')));
	});
}

// ── IPC handler registration ────────────────────────────────────────────────

let _registered = false;

export function registerSidecarIpcHandlers(): void {
	if (_registered) { return; }
	_registered = true;

	// Per-window cleanup. webContents.id is captured at registration time
	// because by the time `'closed'` fires the WebContents is already
	// destroyed — touching `win.webContents.id` then throws "Object has
	// been destroyed" and surfaces as an uncaught main-process exception
	// at IDE shutdown.
	BrowserWindow.getAllWindows().forEach(w => {
		const wcId = w.webContents.id;
		w.on('closed', () => cleanupWindow(wcId));
	});
	app.on('browser-window-created', (_e: unknown, win: BrowserWindow) => {
		const wcId = win.webContents.id;
		win.on('closed', () => cleanupWindow(wcId));
	});

	// chipos:findBinary ────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:findBinary', async (_event, args: FindBinaryArgs = {}) => {
		const name = args.binaryName || defaultBinaryName();
		const workersDir = path.join(chiposHome(), 'workers');

		// Pinned version path. resolveWorkerBinary handles both the standalone
		// folder layout (<ver>/<name>/<name>) and the legacy single-file cache.
		if (args.version) {
			const resolved = resolveWorkerBinary(path.join(workersDir, args.version), name);
			// Best-effort exec bit (cache may have been moved between users).
			if (resolved) { try { fs.chmodSync(resolved, 0o755); } catch { /* ignore */ } }
			return resolved;
		}

		// Latest available.
		if (!fs.existsSync(workersDir)) { return null; }
		try {
			const versions = fs.readdirSync(workersDir)
				.filter(d => resolveWorkerBinary(path.join(workersDir, d), name) !== null)
				.sort(compareVersionsDesc);
			if (versions.length === 0) { return null; }
			const found = resolveWorkerBinary(path.join(workersDir, versions[0]), name);
			if (!found) { return null; }
			// Best-effort exec bit (cache may have been moved between users).
			try { fs.chmodSync(found, 0o755); } catch { /* ignore */ }
			return found;
		} catch {
			return null;
		}
	});

	// chipos:downloadBinary ──────────────────────────────────────────────────
	// `event.sender` is used to ship progress updates back to the renderer
	// while the download streams. The renderer subscribes to the
	// 'vscode:chipos:workerDownloadProgress' channel and feeds these into
	// IProgressService.withProgress. 2026-05-09: was silent before.
	validatedIpcMain.handle('vscode:chipos:downloadBinary', async (event, args: DownloadBinaryArgs) => {
		try {
			const tag = detectPlatformTag();
			const binaryName = args.binaryName || `chipos-worker-${tag}`;
			let version = args.version || 'latest';

			if (version === 'latest') {
				const apiUrl = `https://api.github.com/repos/${args.repo}/releases/latest`;
				const res = await httpsGet(apiUrl, { Accept: 'application/vnd.github.v3+json' });
				if (res.status !== 200) {
					console.warn(`[ChipOS Sidecar] /releases/latest returned ${res.status}; cannot resolve version`);
					return null;
				}
				try {
					const data = JSON.parse(res.body) as { tag_name?: string };
					if (!data.tag_name) { return null; }
					version = data.tag_name.replace(/^v/, '');
				} catch (err) {
					console.warn('[ChipOS Sidecar] failed to parse /releases/latest body:', err);
					return null;
				}
			}

			const dir = path.join(chiposHome(), 'workers', version);
			// Already cached? resolveWorkerBinary handles both the standalone
			// folder layout (<ver>/<name>/<name>) and legacy single-file caches.
			const cachedBinary = resolveWorkerBinary(dir, binaryName);
			if (cachedBinary) { return cachedBinary; }

			// Release asset is `.zip` on Windows (the standalone folder zipped),
			// `.tar.gz` everywhere else. The asset BASE name is unchanged from the
			// onefile era, so pinned release URLs keep resolving.
			const archiveExt = tag.startsWith('win32') ? 'zip' : 'tar.gz';
			const url =
				args.downloadUrl ||
				process.env['CHIPOS_WORKER_DOWNLOAD_URL'] ||
				`https://github.com/${args.repo}/releases/download/v${version}/${binaryName}.${archiveExt}`;

			const cacheDir = path.join(chiposHome(), 'cache');
			const archivePath = path.join(cacheDir, `${binaryName}-v${version}.${archiveExt}`);
			fs.mkdirSync(dir, { recursive: true });
			fs.mkdirSync(cacheDir, { recursive: true });

			console.log(`[ChipOS Sidecar] Downloading ${url} → ${archivePath}`);

			// Tell the renderer we're starting the download (so it can open a
			// progress notification BEFORE Content-Length lands).
			try {
				event.sender.send('vscode:chipos:workerDownloadProgress', {
					phase: 'starting',
					version,
					binaryName,
					loaded: 0,
					total: undefined,
				});
			} catch { /* renderer may have gone away — non-fatal */ }

			await downloadFile(url, archivePath, (loaded, total) => {
				try {
					event.sender.send('vscode:chipos:workerDownloadProgress', {
						phase: 'downloading',
						version,
						binaryName,
						loaded,
						total,
					});
				} catch { /* ignore */ }
			});

			try {
				event.sender.send('vscode:chipos:workerDownloadProgress', {
					phase: 'extracting',
					version,
					binaryName,
				});
			} catch { /* ignore */ }

			// Clean any half-extracted prior attempt, then extract. Win10+
			// ships bsdtar which also unpacks `.zip`; `.tar.gz` everywhere
			// else. The standalone folder (~399 MB / ~2400 files) extracts
			// much slower than a single onefile, so bump the budget to 120s.
			try { fs.rmSync(path.join(dir, binaryName), { recursive: true, force: true }); } catch { /* ignore */ }
			const extractCmd = archivePath.endsWith('.zip')
				? `tar -xf "${archivePath}" -C "${dir}"`
				: `tar xzf "${archivePath}" -C "${dir}"`;
			cp.execSync(extractCmd, { timeout: 120000 });
			const extractedBinary = resolveWorkerBinary(dir, binaryName);
			if (extractedBinary) {
				fs.chmodSync(extractedBinary, 0o755);
			}
			try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

			try {
				event.sender.send('vscode:chipos:workerDownloadProgress', {
					phase: 'done',
					version,
					binaryName,
				});
			} catch { /* ignore */ }

			return extractedBinary;
		} catch (err) {
			console.error('[ChipOS Sidecar] downloadBinary failed:', err);
			try {
				event.sender.send('vscode:chipos:workerDownloadProgress', {
					phase: 'error',
					message: err instanceof Error ? err.message : String(err),
				});
			} catch { /* ignore */ }
			return null;
		}
	});

	// chipos:spawnProcess ───────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:spawnProcess', async (event, args: SpawnProcessArgs) => {
		const windowId = event.sender.id;
		const { binaryPath, env, cwd, role, workspaceRoot } = args;

		const existing = getProc(windowId, role);
		if (existing && !existing.process.killed) {
			return { pid: existing.pid, alreadyRunning: true, role };
		}

		const spawnArgs = [...(args.args ?? [])];
		if (workspaceRoot && !spawnArgs.includes('--instance-dir')) {
			const inst = instanceDir(workspaceRoot);
			fs.mkdirSync(inst, { recursive: true });
			spawnArgs.push('--instance-dir', inst);
		}

		// detached:true so the worker survives an IDE crash; we reattach via
		// instance.json on next launch. unref() so the IDE can exit cleanly
		// while the worker keeps running for shared-instance reuse.
		const child = cp.spawn(binaryPath, spawnArgs, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});
		child.unref();

		const managed: ManagedProcess = {
			process: child,
			pid: child.pid,
			role,
			binaryPath,
			spawnEnv: env,
			spawnCwd: cwd,
		};
		setProc(windowId, role, managed);

		// Open a rolling stderr log so post-mortem of a dead worker is possible.
		// See stderrLogPath(): we used to discard worker stderr into console.log.
		let stderrLogStream: fs.WriteStream | undefined;
		try {
			const logPath = stderrLogPath(role);
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			stderrLogStream = fs.createWriteStream(logPath, { flags: 'a' });
			const banner = `\n=== spawn pid=${child.pid} role=${role} at ${new Date().toISOString()} window=${windowId} ===\n` +
				`args: ${binaryPath} ${spawnArgs.join(' ')}\n`;
			stderrLogStream.write(banner);
		} catch (e) {
			console.warn(`[ChipOS ${role}] could not open stderr log: ${e}`);
			stderrLogStream = undefined;
		}

		child.on('exit', (code, signal) => {
			console.log(`[ChipOS ${role}] exited: code=${code} signal=${signal} (window ${windowId})`);
			if (stderrLogStream) {
				try {
					stderrLogStream.write(`=== exit pid=${child.pid} role=${role} code=${code} signal=${signal} at ${new Date().toISOString()} ===\n`);
					stderrLogStream.end();
				} catch { /* best effort */ }
			}
			setProc(windowId, role, undefined);
		});
		child.on('error', err => {
			console.error(`[ChipOS ${role}] spawn error: ${err.message} (window ${windowId})`);
			if (stderrLogStream) {
				try {
					stderrLogStream.write(`=== spawn error pid=${child.pid} role=${role} err=${err.message} at ${new Date().toISOString()} ===\n`);
				} catch { /* best effort */ }
			}
			setProc(windowId, role, undefined);
		});
		// EDA-PACK-IDE-WIRING gap-2 落地: parse worker stderr for [EdaPack]
		// progress lines and forward to the renderer via IPC. The renderer's
		// `vscode-extension/src/edaPackStatus.ts:EdaPackStatusBar.ingestStderrLine`
		// picks this up and shows the status bar item + first-time notification.
		// Buffer partial lines across data chunks (TCP/pipe buffers split arbitrarily).
		//
		// ROADMAP §11 P2-d: also parse [EdaEnv] lines (ADR-009 worker startup
		// EDA scan protocol — see backend_v2/packages/execution/src/execution/
		// eda_pack/environment.py). [EdaEnv] reports per-tool present/missing
		// status + install_hint URLs; renderer surfaces a notification with a
		// "Open install guide" button for each missing tool.
		let stderrLineBuffer = '';
		child.stderr?.on('data', (data: Buffer) => {
			stderrLineBuffer += data.toString();
			const lines = stderrLineBuffer.split('\n');
			// Last item may be a partial line — keep for next chunk
			stderrLineBuffer = lines.pop() ?? '';
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line) { continue; }
				// Persist every stderr line (including Python tracebacks and
				// gRPC errors) to the rolling log so a dead worker is debuggable.
				if (stderrLogStream) {
					try {
						stderrLogStream.write(`${new Date().toISOString()} ${line}\n`);
					} catch { /* best effort */ }
				}
				console.log(`[ChipOS ${role} stderr] ${line}`);
				if (event.sender.isDestroyed()) { continue; }
				// Forward [EdaPack] lines to the renderer (status bar item).
				// `event.sender` is the BrowserWindow.webContents that called
				// vscode:chipos:spawnProcess — same window gets the progress.
				if (line.startsWith('[EdaPack]')) {
					try {
						event.sender.send('chipos:eda-pack-progress', { line, role });
					} catch (e) {
						// Renderer may have closed mid-download — best effort
						console.warn(`[ChipOS ${role}] failed to forward EdaPack line: ${e}`);
					}
					continue;
				}
				// ROADMAP §11 P2-d: forward [EdaEnv] lines on a separate IPC
				// channel. Renderer (primary `vscode/` workbench) consumes via
				// `vscode:chipos:eda-env-status` to show install guidance /
				// status pill ('all_ready' / 'core_ready' / 'missing <tool>').
				//
				// 2026-05-16 fix: channel renamed from `chipos:eda-env-status`
				// → `vscode:chipos:eda-env-status` because the sandbox preload
				// validateIPC() rejects channels without the `vscode:` prefix.
				// The earlier `chipos:eda-pack-progress` sister channel kept
				// its original name because it's consumed by the secondary
				// `vscode-extension/` (a separate extension with its own
				// preload, no validateIPC restriction). Anything consumed by
				// the primary workbench MUST start with `vscode:`.
				if (line.startsWith('[EdaEnv]')) {
					try {
						event.sender.send('vscode:chipos:eda-env-status', { line, role });
					} catch (e) {
						console.warn(`[ChipOS ${role}] failed to forward EdaEnv line: ${e}`);
					}
				}
			}
		});
		// Drain stdout so the kernel pipe buffer doesn't fill up and stall the worker.
		child.stdout?.on('data', () => { /* discard */ });

		return { pid: child.pid, role };
	});

	// chipos:killProcess ────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:killProcess', async (event, role: 'worker' | 'reasoner') => {
		const windowId = event.sender.id;
		const managed = getProc(windowId, role);
		if (!managed || managed.process.killed) {
			return { success: true, wasRunning: false, role };
		}
		const pid = managed.pid;
		const graceful = await killManagedProcess(managed);
		setProc(windowId, role, undefined);
		return { success: true, wasRunning: true, pid, role, graceful };
	});

	// chipos:eda-rescan ─────────────────────────────────────────────────────
	// Triggered by the renderer's "我已安装完成，重新检测" action button on the
	// EDA missing-tool notification (EdaEnvHandler). Re-runs the worker's
	// [EdaEnv] scan as a SHORT-LIVED subprocess (`<worker-binary> scan-eda`)
	// in the same env/cwd as the live worker. We deliberately do NOT
	// restart the worker — that would tear down the gRPC stream, the
	// HTTP /health port, and the permission_token, just to find out
	// whether a binary appeared in PATH. The one-shot subprocess inherits
	// the same PATH (via `spawnEnv` captured at original spawn time) so a
	// freshly-installed Vivado / OpenROAD shows up.
	//
	// Output: stderr `[EdaEnv]` lines are forwarded to the renderer on the
	// SAME `vscode:chipos:eda-env-status` channel that the live worker uses.
	// The renderer's EdaEnvHandler treats every incoming line uniformly —
	// no separate "rescan" plumbing is needed in the renderer beyond
	// clearing its `_seenMissing` dedup set before the rescan starts.
	validatedIpcMain.handle('vscode:chipos:eda-rescan', async (event) => {
		const windowId = event.sender.id;
		const managed = getProc(windowId, 'worker');
		if (!managed) {
			return { success: false, error: 'worker_not_running' };
		}

		// F17: read login-shell PATH so PATH changes the user just made in
		// ~/.bashrc / ~/.zshrc / ~/.profile (e.g. after Vivado install) are
		// visible to the rescan probe — without this, worker's cached
		// spawnEnv stays stuck on whatever the IDE inherited at launch,
		// which defeats the whole point of rescan when user edits PATH.
		const refreshedPath = await readLoginShellPath().catch((err: unknown) => {
			console.warn(`[ChipOS rescan] login-shell PATH read failed: ${err}`);
			return undefined;
		});
		const effectiveEnv: Record<string, string> = {
			...(process.env as Record<string, string>),
			...managed.spawnEnv,
			...(refreshedPath ? { PATH: refreshedPath } : {}),
		};

		const probe = cp.spawn(managed.binaryPath, ['scan-eda'], {
			cwd: managed.spawnCwd,
			env: effectiveEnv,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: false,
		});

		let stderrLineBuffer = '';
		probe.stderr?.on('data', (data: Buffer) => {
			stderrLineBuffer += data.toString();
			const lines = stderrLineBuffer.split('\n');
			stderrLineBuffer = lines.pop() ?? '';
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line) { continue; }
				console.log(`[ChipOS rescan stderr] ${line}`);
				if (event.sender.isDestroyed()) { continue; }
				if (line.startsWith('[EdaEnv]')) {
					try {
						event.sender.send('vscode:chipos:eda-env-status', { line, role: 'rescan' });
					} catch (e) {
						console.warn(`[ChipOS rescan] failed to forward EdaEnv line: ${e}`);
					}
				}
			}
		});
		probe.stdout?.on('data', () => { /* discard */ });

		return await new Promise<{ success: boolean; exitCode?: number; error?: string }>((resolve) => {
			probe.on('exit', (code) => {
				resolve({ success: code === 0, exitCode: code ?? -1 });
			});
			probe.on('error', (err) => {
				console.error(`[ChipOS rescan] spawn error: ${err.message}`);
				resolve({ success: false, error: err.message });
			});
		});
	});

	// chipos:checkInstance ──────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:checkInstance', async (_event, args: CheckInstanceArgs) => {
		const meta = readInstanceJson(args.workspaceRoot);
		if (!meta || !meta.pid) { return { alive: false }; }

		// Two-stage aliveness check with NON-destructive HTTP probe.
		//
		// Stage 1: `kill -0` — necessary baseline. If the recorded pid is
		// definitively dead, the worker is gone and instance.json is stale:
		// unlink it so the next startBackend spawns fresh.
		//
		// Stage 2: HTTP /health probe — `kill -0` is not sufficient on
		// macOS Nuitka onefile builds (the launcher/child pid split lets a
		// dying child remain `kill -0`-alive briefly after tearing down its
		// HTTP server). We probe /health to confirm responsiveness.
		//
		// 2026-05-12 regression fix: a failed HTTP probe **does NOT** delete
		// instance.json any more. Nuitka onefile binaries take ~25 s to bind
		// their HTTP port during startup; during that window pid is alive,
		// HTTP is not. The previous logic deleted instance.json and the
		// freshly-minted permission_token along with it — every subsequent
		// renderer-side `readInstanceMeta()` then returned an empty token
		// and the permission SSE could never authenticate.
		//
		// New contract: instance.json is deleted only when the pid itself
		// is dead. HTTP unresponsiveness in spite of a live pid yields
		// `alive: false` (so the caller does NOT adopt-without-spawn), but
		// the file is preserved so the next probe a few seconds later can
		// see the worker come online and surface the token.
		const pidAlive = isPidAlive(meta.pid);
		if (!pidAlive) {
			try { fs.unlinkSync(instanceJsonPath(args.workspaceRoot)); } catch { /* ignore */ }
		}
		const httpAlive = pidAlive
			? await isWorkerHttpResponsive(meta.http_port ?? 0)
			: false;
		const alive = pidAlive && httpAlive;

		return {
			alive,
			pid: meta.pid,
			ref_count: meta.ref_count,
			http_port: meta.http_port,
			// WORKER-PERMISSION-ASK-TRANSPORT §5.7: surface the Bearer token so
			// the renderer's WorkerPermissionService can authenticate against
			// the worker's /api/v1/permissions/* endpoints. Empty when missing
			// (legacy worker — IDE-side service should fall back to disabled).
			// Always surfaced when pid is alive, even if HTTP isn't ready yet
			// — caller can decide to retry instead of giving up.
			permission_token: pidAlive && typeof meta.permission_token === 'string'
				? meta.permission_token : '',
		};
	});

	// 2026-05-22 fix: auto-release ref when the renderer that acquired it
	// dies. Renderers call _releaseLocalWorkerRef() from dispose(), but
	// dispose() is synchronous and the IPC is fire-and-forget — when the
	// renderer is reload-window'd or quit, the IPC message is in-flight at
	// destruction time and gets dropped before reaching main process.
	// Real-world evidence (2026-05-22 instance.json): 17 stale caller_id
	// entries accumulated over 20 hours of normal reload-window cycles,
	// keeping ref_count > 0 forever → worker process never auto-killed →
	// orphan workers per workspace pile up indefinitely (~50 MB each)
	// until reboot. The previous "kill decision uses local-process
	// tracking as a backstop" comment was aspirational — there was no
	// actual local-process tracking.
	//
	// Fix: track (senderId → list of (workspaceRoot, callerId)) here, and
	// hook the sender's `destroyed` event to release everything that
	// sender holds. Releases via main-process-internal call so they
	// can't be lost to IPC-during-destruction races.
	type SenderRef = { workspaceRoot: string; callerId: string };
	const senderRefs = new Map<number, SenderRef[]>();
	const senderDestroyArmed = new Set<number>();

	// Release every ref this sender holds. Called from BOTH:
	//   - 'destroyed' (window/IDE close) — sender gone for good
	//   - 'did-start-loading' (reload window) — same webContents reused but
	//     OLD renderer's state is now dead; the new renderer that will
	//     populate this same sender.id is required to acquire its own ref.
	// Both paths drain the map and let the bookkeeping match reality.

	// Reusable inner body — sync code, run under either the async or the
	// sync lock depending on caller. Factored out so we don't drift the two
	// paths apart.
	function _decrementRefOnDisk(r: SenderRef): void {
		const meta = readInstanceJson(r.workspaceRoot);
		if (!meta) { return; }
		meta.ref_count = Math.max((meta.ref_count ?? 1) - 1, 0);
		meta.refs = (meta.refs ?? []).filter(x => x.caller_id !== r.callerId);
		writeInstanceJson(r.workspaceRoot, meta);
	}

	// Async release — used by the reload path. Main process stays alive
	// across reload, no race with app exit, so async + 20ms-yield spin is
	// fine and avoids burning CPU.
	function releaseAllRefsForSender(senderId: number): void {
		const refs = senderRefs.get(senderId) ?? [];
		if (refs.length === 0) { return; }
		// Reset the per-sender list immediately so concurrent acquires by
		// the new renderer don't get drained along with the old refs.
		senderRefs.set(senderId, []);
		void (async () => {
			for (const r of refs) {
				try {
					await withInstanceLock(r.workspaceRoot, () => _decrementRefOnDisk(r));
				} catch {
					// best-effort; lost release is exactly the bug we're
					// trying to fix, but if THIS path raises there's
					// nothing left to fall back on.
				}
			}
		})();
	}

	// 2026-05-22 sync follow-up to the async A fix.
	//
	// SYNC release — used by paths that race with main-process exit:
	//   - 'destroyed' (window/IDE close — under Cmd+Q the main process is
	//     spinning down and any awaited file write gets SIGKILL'd before
	//     it completes; same root-cause class as the original fire-and-
	//     forget IPC bug)
	//   - 'before-quit' (last-chance drain of anything still in the map)
	//
	// fs.writeFileSync inside a sync mkdir-based file lock — no event loop
	// yielding, returns when the bytes are on disk. The async version of A
	// passed e2e on reload because reload doesn't quit the main process,
	// but Cmd+Q is the actual race we care about.
	function releaseAllRefsForSenderSync(senderId: number): void {
		const refs = senderRefs.get(senderId) ?? [];
		if (refs.length === 0) { return; }
		senderRefs.set(senderId, []);
		for (const r of refs) {
			try {
				withInstanceLockSync(r.workspaceRoot, () => _decrementRefOnDisk(r));
			} catch {
				// best-effort, see releaseAllRefsForSender comment
			}
		}
	}

	function autoReleaseOnDestroy(senderId: number, webContents: Electron.WebContents): void {
		if (senderDestroyArmed.has(senderId)) { return; }
		senderDestroyArmed.add(senderId);
		// 1) Window/IDE close path — webContents really gone. Use SYNC
		// release: Cmd+Q fires 'destroyed' while app.quit() is already in
		// flight; an async release loses the race vs the imminent process
		// exit and leaves instance.json unchanged. The sync path's
		// fs.writeFileSync blocks until bytes hit disk, so the decrement
		// is guaranteed to land.
		webContents.once('destroyed', () => {
			releaseAllRefsForSenderSync(senderId);
			senderRefs.delete(senderId);
			senderDestroyArmed.delete(senderId);
		});
		// 2) Reload window path — Electron reuses the SAME webContents (same
		// sender.id) across reload(), so 'destroyed' never fires. But
		// 'did-start-loading' fires every time the renderer navigates,
		// which includes the reload triggered by Cmd+R / Developer:
		// Reload Window. We drain the per-sender refs there too — the new
		// renderer running after reload re-acquires via the normal IPC
		// path and gets fresh entries. Without this, every reload-window
		// leaks 1 ref per workspace into instance.json (the exact bug
		// observed on 2026-05-22: 17 stale callerIds in 20 hours).
		//
		// Async is fine here — reload doesn't end the main process, so no
		// race with exit. (We use sync only where we MUST.)
		//
		// Note: we DON'T `once()` this; reload can happen many times over
		// a window's lifetime. We rely on the senderRefs[]=[] reset inside
		// releaseAllRefsForSender to make repeated calls idempotent.
		webContents.on('did-start-loading', () => {
			releaseAllRefsForSender(senderId);
		});
	}

	// 3) App-wide quit path — belt-and-suspenders. If for any reason a
	// 'destroyed' didn't fire in time (Electron internal ordering quirks,
	// child window closures racing with app.quit, etc.) we drain everything
	// left in the map BEFORE the windows even start closing. 'before-quit'
	// is fired synchronously by Electron and waits for sync handlers to
	// return before continuing the quit sequence, which is exactly the
	// contract we need.
	//
	// Idempotent with the per-sender 'destroyed' handler: each sender's
	// list is reset to [] inside releaseAllRefsForSenderSync, so if both
	// fire the second one is a no-op.
	app.on('before-quit', () => {
		for (const senderId of Array.from(senderRefs.keys())) {
			releaseAllRefsForSenderSync(senderId);
		}
	});

	// chipos:acquireRef ────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:acquireRef', async (event, args: RefArgs) => {
		const senderId = event.sender.id;
		// Record this acquisition under the sender so destroy can roll it back.
		const list = senderRefs.get(senderId) ?? [];
		list.push({ workspaceRoot: args.workspaceRoot, callerId: args.callerId });
		senderRefs.set(senderId, list);
		autoReleaseOnDestroy(senderId, event.sender);
		return withInstanceLock(args.workspaceRoot, () => {
			const meta = readInstanceJson(args.workspaceRoot);
			if (!meta) { return 0; }
			meta.ref_count = (meta.ref_count ?? 1) + 1;
			meta.refs = meta.refs ?? [];
			// 2026-05-22: include main-process pid so worker-side periodic GC
			// can drop this entry if/when the IDE goes away without releasing
			// (kill -9, OS crash, power loss). See InstanceMeta.refs comment.
			meta.refs.push({
				caller_id: args.callerId,
				acquired_at: new Date().toISOString(),
				ide_pid: process.pid,
			});
			writeInstanceJson(args.workspaceRoot, meta);
			return meta.ref_count;
		});
	});

	// chipos:releaseRef ────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:releaseRef', async (event, args: RefArgs) => {
		// Mirror the disk release in the in-memory map so destroy doesn't
		// double-release. Match on (workspaceRoot, callerId) — same key as
		// the disk records.
		const senderId = event.sender.id;
		const list = senderRefs.get(senderId);
		if (list) {
			const idx = list.findIndex(r =>
				r.workspaceRoot === args.workspaceRoot && r.callerId === args.callerId);
			if (idx >= 0) { list.splice(idx, 1); }
		}
		return withInstanceLock(args.workspaceRoot, () => {
			const meta = readInstanceJson(args.workspaceRoot);
			if (!meta) { return 0; }
			meta.ref_count = Math.max((meta.ref_count ?? 1) - 1, 0);
			meta.refs = (meta.refs ?? []).filter(r => r.caller_id !== args.callerId);
			writeInstanceJson(args.workspaceRoot, meta);
			return meta.ref_count;
		});
	});

	// chipos:ensureMcpConfig ────────────────────────────────────────────────
	// Mirrors WorkerManager._ensureMcpConfigFile — same default config, same
	// idempotent semantics. A fresh box without ~/.chipos/mcp_servers.json
	// otherwise gets a worker that loads 0 MCP tools silently.
	validatedIpcMain.handle('vscode:chipos:ensureMcpConfig', async (_event, args: EnsureMcpConfigArgs) => {
		try {
			// Renderer is sandboxed (no Node `process` global) so it can't
			// expand `~`; we do it here. Falls through verbatim if the path
			// is already absolute.
			const target = args.mcpConfigPath.startsWith('~/')
				? path.join(os.homedir(), args.mcpConfigPath.slice(2))
				: args.mcpConfigPath;
			let priorServers: Record<string, unknown> = {};
			if (fs.existsSync(target)) {
				// Heal a stale config. An older onefile-era install wrote the EDA
				// server `command` as the worker binary path `<ver>/<name>`. The
				// onefile->standalone switch turned that path into a DIRECTORY (the
				// binary moved to `<ver>/<name>/<name>`), so spawning `<dir> mcp-server`
				// fails with EACCES and the worker silently loads 0 EDA tools
				// (verilog_lint etc. vanish). The current default below uses 'python'
				// — version/layout-agnostic — so regenerate only when the existing
				// command is an absolute path that resolves to a directory (which can
				// never exec). Leave any other (custom / valid / unreadable) config alone.
				let stale = false;
				try {
					const existing = JSON.parse(fs.readFileSync(target, 'utf-8')) as { mcpServers?: Record<string, { command?: unknown }> };
					if (existing && typeof existing.mcpServers === 'object' && existing.mcpServers) { priorServers = existing.mcpServers as Record<string, unknown>; }
					const cmd = existing?.mcpServers?.['coderust-eda-tools']?.command;
					stale = typeof cmd === 'string' && cmd !== 'python' && cmd !== 'python3'
						&& path.isAbsolute(cmd) && fs.existsSync(cmd) && fs.statSync(cmd).isDirectory();
				} catch {
					// Unreadable / not JSON — don't clobber a file we can't parse.
				}
				if (!stale) { return { existed: true, path: target }; }
				console.log(`[ChipOS Sidecar] Regenerating stale EDA MCP config at ${target} (command pointed at a directory)`);
			}
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const merged = JSON.stringify({
				mcpServers: {
					...priorServers,
					'coderust-eda-tools': {
						command: 'python',
						args: ['-m', 'execution.mcp_server.server'],
						cwd: '.',
						env: {},
					},
				},
			}, null, 2) + '\n';
			fs.writeFileSync(target, merged, 'utf-8');
			console.log(`[ChipOS Sidecar] Wrote default MCP config to ${target}`);
			return { existed: false, path: target };
		} catch (err) {
			// Non-fatal. Worker will run with 0 MCP tools but base 18 tools work.
			console.warn(`[ChipOS Sidecar] ensureMcpConfig failed (non-fatal):`, err);
			return { existed: false, path: args.mcpConfigPath, error: String(err) };
		}
	});
}
