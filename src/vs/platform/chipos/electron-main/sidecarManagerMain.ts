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

function downloadFile(url: string, dest: string, redirectsLeft = 5): Promise<void> {
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
				resolve(downloadFile(next, dest, redirectsLeft - 1));
				return;
			}
			if (!res.statusCode || res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
				return;
			}
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

	// Per-window cleanup.
	BrowserWindow.getAllWindows().forEach(w => {
		w.on('closed', () => cleanupWindow(w.webContents.id));
	});
	app.on('browser-window-created', (_e: unknown, win: BrowserWindow) => {
		win.on('closed', () => cleanupWindow(win.webContents.id));
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
	validatedIpcMain.handle('vscode:chipos:downloadBinary', async (_event, args: DownloadBinaryArgs) => {
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
			await downloadFile(url, archivePath);

			// Extract via tar — every supported platform ships tar in PATH.
			cp.execSync(`tar xzf "${archivePath}" -C "${dir}"`, { timeout: 60000 });
			if (fs.existsSync(binaryPath)) {
				fs.chmodSync(binaryPath, 0o755);
			}
			try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

			return fs.existsSync(binaryPath) ? binaryPath : null;
		} catch (err) {
			console.error('[ChipOS Sidecar] downloadBinary failed:', err);
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

		child.on('exit', (code, signal) => {
			console.log(`[ChipOS ${role}] exited: code=${code} signal=${signal} (window ${windowId})`);
			setProc(windowId, role, undefined);
		});
		child.on('error', err => {
			console.error(`[ChipOS ${role}] spawn error: ${err.message} (window ${windowId})`);
			setProc(windowId, role, undefined);
		});
		// EDA-PACK-IDE-WIRING gap-2 落地: parse worker stderr for [EdaPack]
		// progress lines and forward to the renderer via IPC. The renderer's
		// `vscode-extension/src/edaPackStatus.ts:EdaPackStatusBar.ingestStderrLine`
		// picks this up and shows the status bar item + first-time notification.
		// Buffer partial lines across data chunks (TCP/pipe buffers split arbitrarily).
		let stderrLineBuffer = '';
		child.stderr?.on('data', (data: Buffer) => {
			stderrLineBuffer += data.toString();
			const lines = stderrLineBuffer.split('\n');
			// Last item may be a partial line — keep for next chunk
			stderrLineBuffer = lines.pop() ?? '';
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line) { continue; }
				console.log(`[ChipOS ${role} stderr] ${line}`);
				// Forward [EdaPack] lines to the renderer (status bar item).
				// `event.sender` is the BrowserWindow.webContents that called
				// vscode:chipos:spawnProcess — same window gets the progress.
				if (line.startsWith('[EdaPack]') && !event.sender.isDestroyed()) {
					try {
						event.sender.send('chipos:eda-pack-progress', { line, role });
					} catch (e) {
						// Renderer may have closed mid-download — best effort
						console.warn(`[ChipOS ${role}] failed to forward EdaPack line: ${e}`);
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
		const alive = isPidAlive(meta.pid);
		if (!alive) {
			// Stale instance.json — clean up so next start gets a fresh one.
			try { fs.unlinkSync(instanceJsonPath(args.workspaceRoot)); } catch { /* ignore */ }
		}
		return {
			alive,
			pid: meta.pid,
			ref_count: meta.ref_count,
			http_port: meta.http_port,
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
