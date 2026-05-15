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

// ── per-window managed processes ────────────────────────────────────────────

interface ManagedProcess {
	process: cp.ChildProcess;
	pid: number | undefined;
	role: 'reasoner' | 'worker';
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

function workspaceHash(workspaceRoot: string): string {
	return crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
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
	refs?: { caller_id: string; acquired_at: string }[];
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

		// Pinned version path.
		if (args.version) {
			const p = path.join(workersDir, args.version, name);
			return fs.existsSync(p) ? p : null;
		}

		// Latest available.
		if (!fs.existsSync(workersDir)) { return null; }
		try {
			const versions = fs.readdirSync(workersDir)
				.filter(d => {
					try { return fs.existsSync(path.join(workersDir, d, name)); } catch { return false; }
				})
				.sort(compareVersionsDesc);
			if (versions.length === 0) { return null; }
			const found = path.join(workersDir, versions[0], name);
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
			const binaryPath = path.join(dir, binaryName);
			if (fs.existsSync(binaryPath)) { return binaryPath; }

			const url =
				args.downloadUrl ||
				process.env['CHIPOS_WORKER_DOWNLOAD_URL'] ||
				`https://github.com/${args.repo}/releases/download/v${version}/${binaryName}.tar.gz`;

			const cacheDir = path.join(chiposHome(), 'cache');
			const archivePath = path.join(cacheDir, `${binaryName}-v${version}.tar.gz`);
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

			// Extract via tar — every supported platform ships tar in PATH.
			cp.execSync(`tar xzf "${archivePath}" -C "${dir}"`, { timeout: 60000 });
			if (fs.existsSync(binaryPath)) {
				fs.chmodSync(binaryPath, 0o755);
			}
			try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

			try {
				event.sender.send('vscode:chipos:workerDownloadProgress', {
					phase: 'done',
					version,
					binaryName,
				});
			} catch { /* ignore */ }

			return fs.existsSync(binaryPath) ? binaryPath : null;
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
				// channel. Renderer extension consumes via
				// `chipos:eda-env-status` to show install guidance / status
				// pill ('all_ready' / 'core_ready' / 'missing <tool>').
				if (line.startsWith('[EdaEnv]')) {
					try {
						event.sender.send('chipos:eda-env-status', { line, role });
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

	// chipos:acquireRef ────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:acquireRef', async (_event, args: RefArgs) => {
		return withInstanceLock(args.workspaceRoot, () => {
			const meta = readInstanceJson(args.workspaceRoot);
			if (!meta) { return 0; }
			meta.ref_count = (meta.ref_count ?? 1) + 1;
			meta.refs = meta.refs ?? [];
			meta.refs.push({ caller_id: args.callerId, acquired_at: new Date().toISOString() });
			writeInstanceJson(args.workspaceRoot, meta);
			return meta.ref_count;
		});
	});

	// chipos:releaseRef ────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:chipos:releaseRef', async (_event, args: RefArgs) => {
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
			if (fs.existsSync(target)) { return { existed: true, path: target }; }
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const defaultConfig = JSON.stringify({
				mcpServers: {
					'coderust-eda-tools': {
						command: 'python',
						args: ['-m', 'execution.mcp_server.server'],
						cwd: '.',
						env: {},
					},
				},
			}, null, 2) + '\n';
			fs.writeFileSync(target, defaultConfig, 'utf-8');
			console.log(`[ChipOS Sidecar] Wrote default MCP config to ${target}`);
			return { existed: false, path: target };
		} catch (err) {
			// Non-fatal. Worker will run with 0 MCP tools but base 18 tools work.
			console.warn(`[ChipOS Sidecar] ensureMcpConfig failed (non-fatal):`, err);
			return { existed: false, path: args.mcpConfigPath, error: String(err) };
		}
	});
}
