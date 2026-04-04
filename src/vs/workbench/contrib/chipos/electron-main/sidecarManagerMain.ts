/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R29 + R49 + R50: sidecarManagerMain — Electron main 进程 IPC handler。
 *
 * R49: chipos:spawnProcess 支持 binaryPath 字段（二进制优先启动）
 * R50: 新增 chipos:checkInstance / acquireRef / releaseRef / findBinary / downloadBinary
 *      实现基于 instance.json 的多窗口 ref_count 隔离
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { BrowserWindow, ipcMain } from 'electron';

// ── 进程管理（按窗口隔离） ──────────────────────────────────────────

interface ManagedProcess {
	process: cp.ChildProcess;
	pid: number | undefined;
	role: 'reasoner' | 'worker';
}

const windowProcesses = new Map<number, Map<string, ManagedProcess>>();

export interface SpawnProcessArgs {
	pythonPath?: string;
	binaryPath?: string;
	moduleArgs?: string[];
	args?: string[];
	env: Record<string, string>;
	cwd: string;
	role: 'reasoner' | 'worker';
	workspaceRoot?: string;
}

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
	if (managed.process.killed) {
		return Promise.resolve(true);
	}
	managed.process.kill('SIGTERM');
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			if (!managed.process.killed) {
				managed.process.kill('SIGKILL');
			}
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
		console.log(`[ChipOS] Cleaning up ${role} process for window ${windowId}`);
		if (!managed.process.killed) {
			managed.process.kill('SIGTERM');
			setTimeout(() => {
				if (!managed.process.killed) {
					managed.process.kill('SIGKILL');
				}
			}, 3000);
		}
	}
	windowProcesses.delete(windowId);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readInstanceJson(workspaceRoot: string): any | undefined {
	const f = instanceJsonPath(workspaceRoot);
	if (!fs.existsSync(f)) { return undefined; }
	try {
		return JSON.parse(fs.readFileSync(f, 'utf-8'));
	} catch {
		return undefined;
	}
}

function writeInstanceJson(workspaceRoot: string, data: any): void {
	const dir = instanceDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(instanceJsonPath(workspaceRoot), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

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

export function registerSidecarIpcHandlers(): void {

	BrowserWindow.getAllWindows().forEach(win => {
		win.on('closed', () => cleanupWindow(win.webContents.id));
	});
	const { app } = require('electron');
	app.on('browser-window-created', (_e: unknown, win: BrowserWindow) => {
		win.on('closed', () => cleanupWindow(win.webContents.id));
	});

	// ── chipos:spawnProcess (R49: supports binaryPath) ───────────────────

	ipcMain.handle('chipos:spawnProcess', async (event, args: SpawnProcessArgs) => {
		const windowId = event.sender.id;
		const { env, cwd, role, workspaceRoot } = args;

		const existing = getProc(windowId, role);
		if (existing && !existing.process.killed) {
			return { pid: existing.pid, alreadyRunning: true, role };
		}

		let child: cp.ChildProcess;

		if (args.binaryPath) {
			const spawnArgs = args.args ?? [];
			if (workspaceRoot) {
				const instDir = instanceDir(workspaceRoot);
				fs.mkdirSync(instDir, { recursive: true });
				spawnArgs.push('--instance-dir', instDir);
			}
			child = cp.spawn(args.binaryPath, spawnArgs, {
				cwd,
				env: { ...process.env, ...env },
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: false,
			});
		} else {
			const pythonPath = args.pythonPath ?? 'python3';
			const moduleArgs = args.moduleArgs ?? [];
			if (workspaceRoot) {
				const instDir = instanceDir(workspaceRoot);
				fs.mkdirSync(instDir, { recursive: true });
				moduleArgs.push('--instance-dir', instDir);
			}
			child = cp.spawn(pythonPath, moduleArgs, {
				cwd,
				env: { ...process.env, ...env },
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: false,
			});
		}

		const managed: ManagedProcess = {
			process: child,
			pid: child.pid,
			role: role as 'reasoner' | 'worker',
		};
		setProc(windowId, role, managed);

		child.on('exit', (code, signal) => {
			console.log(`[ChipOS ${role}] exited: code=${code} signal=${signal} (window ${windowId})`);
			setProc(windowId, role, undefined);
		});

		child.on('error', (err) => {
			console.error(`[ChipOS ${role}] error: ${err.message} (window ${windowId})`);
			setProc(windowId, role, undefined);
		});

		child.stderr?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) {
				console.log(`[ChipOS ${role} stderr] ${line}`);
			}
		});

		return { pid: child.pid, role };
	});

	// ── chipos:checkInstance (R50) ────────────────────────────────────────

	ipcMain.handle('chipos:checkInstance', async (_event, args: { workspaceRoot: string }) => {
		const meta = readInstanceJson(args.workspaceRoot);
		if (!meta) { return { alive: false }; }
		const alive = isPidAlive(meta.pid);
		if (!alive) {
			try { fs.unlinkSync(instanceJsonPath(args.workspaceRoot)); } catch { /* ignore */ }
		}
		return { alive, pid: meta.pid, ref_count: meta.ref_count, http_port: meta.http_port };
	});

	// ── chipos:acquireRef (R50) ──────────────────────────────────────────

	ipcMain.handle('chipos:acquireRef', async (_event, args: { workspaceRoot: string; callerId: string }) => {
		const meta = readInstanceJson(args.workspaceRoot);
		if (!meta) { return 0; }
		meta.ref_count = (meta.ref_count ?? 1) + 1;
		if (!meta.refs) { meta.refs = []; }
		meta.refs.push({ caller_id: args.callerId, acquired_at: new Date().toISOString() });
		writeInstanceJson(args.workspaceRoot, meta);
		return meta.ref_count;
	});

	// ── chipos:releaseRef (R50) ──────────────────────────────────────────

	ipcMain.handle('chipos:releaseRef', async (_event, args: { workspaceRoot: string; callerId: string }) => {
		const meta = readInstanceJson(args.workspaceRoot);
		if (!meta) { return 0; }
		meta.ref_count = Math.max((meta.ref_count ?? 1) - 1, 0);
		meta.refs = (meta.refs ?? []).filter((r: any) => r.caller_id !== args.callerId);
		writeInstanceJson(args.workspaceRoot, meta);
		return meta.ref_count;
	});

	// ── chipos:findBinary (R49) ──────────────────────────────────────────

	ipcMain.handle('chipos:findBinary', async (_event, args: { version?: string }) => {
		const tag = detectPlatformTag();
		const name = `chipos-worker-${tag}`;
		const workersDir = path.join(chiposHome(), 'workers');

		if (args.version) {
			const p = path.join(workersDir, args.version, name);
			return fs.existsSync(p) ? p : null;
		}

		if (!fs.existsSync(workersDir)) { return null; }
		const versions = fs.readdirSync(workersDir)
			.filter(d => fs.existsSync(path.join(workersDir, d, name)))
			.sort()
			.reverse();
		return versions.length > 0 ? path.join(workersDir, versions[0], name) : null;
	});

	// ── chipos:downloadBinary (R49) ──────────────────────────────────────

	ipcMain.handle('chipos:downloadBinary', async (_event, args: { version: string; downloadUrl?: string }) => {
		try {
			const tag = detectPlatformTag();
			const name = `chipos-worker-${tag}`;
			let version = args.version;

			if (version === 'latest') {
				try {
					const result = cp.execFileSync('curl', [
						'-fsSL', '-H', 'Accept: application/vnd.github.v3+json',
						'https://api.github.com/repos/linshaoxin-maker/coderust/releases/latest'
					], { timeout: 10000, encoding: 'utf-8' });
					const data = JSON.parse(result);
					version = (data.tag_name as string)?.replace(/^v/, '') ?? version;
				} catch {
					return null;
				}
			}

			const dir = path.join(chiposHome(), 'workers', version);
			const binaryPath = path.join(dir, name);
			if (fs.existsSync(binaryPath)) { return binaryPath; }

			const url = args.downloadUrl
				|| process.env['CHIPOS_WORKER_DOWNLOAD_URL']
				|| `https://github.com/linshaoxin-maker/coderust/releases/download/v${version}/${name}.tar.gz`;

			const cacheDir = path.join(chiposHome(), 'cache');
			const archivePath = path.join(cacheDir, `${name}-v${version}.tar.gz`);
			fs.mkdirSync(dir, { recursive: true });
			fs.mkdirSync(cacheDir, { recursive: true });

			cp.execSync(`curl -fSL --retry 3 -o "${archivePath}" "${url}"`, { timeout: 300000 });
			cp.execSync(`tar xzf "${archivePath}" -C "${dir}"`);
			if (fs.existsSync(binaryPath)) {
				fs.chmodSync(binaryPath, 0o755);
			}
			try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

			return fs.existsSync(binaryPath) ? binaryPath : null;
		} catch (err) {
			console.error('[ChipOS] downloadBinary failed:', err);
			return null;
		}
	});

	// ── Legacy compat handlers ───────────────────────────────────────────

	ipcMain.handle('chipos:spawnWorker', async (event, args: any) => {
		const windowId = event.sender.id;
		const role = args.role || 'worker';
		const existing = getProc(windowId, role);
		if (existing && !existing.process.killed) {
			return { pid: existing.pid, alreadyRunning: true, role };
		}
		const { pythonPath, moduleArgs, env, cwd } = args;
		const child = cp.spawn(pythonPath, moduleArgs, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: false,
		});
		const managed: ManagedProcess = { process: child, pid: child.pid, role };
		setProc(windowId, role, managed);
		child.on('exit', () => setProc(windowId, role, undefined));
		child.on('error', () => setProc(windowId, role, undefined));
		return { pid: child.pid, role };
	});

	ipcMain.handle('chipos:killProcess', async (event, role: 'reasoner' | 'worker') => {
		const windowId = event.sender.id;
		const managed = getProc(windowId, role);
		if (!managed || managed.process.killed) {
			return { success: true, wasRunning: false, role };
		}
		const pid = managed.pid;
		const exited = await killManagedProcess(managed);
		setProc(windowId, role, undefined);
		return { success: true, wasRunning: true, pid, role, graceful: exited };
	});

	ipcMain.handle('chipos:killWorker', async (event) => {
		const windowId = event.sender.id;
		const managed = getProc(windowId, 'worker');
		if (!managed || managed.process.killed) {
			return { success: true, wasRunning: false };
		}
		const pid = managed.pid;
		const exited = await killManagedProcess(managed);
		setProc(windowId, 'worker', undefined);
		return { success: true, wasRunning: true, pid, graceful: exited };
	});

	ipcMain.handle('chipos:processStatus', async (event, role?: 'reasoner' | 'worker') => {
		const windowId = event.sender.id;
		if (role) {
			const managed = getProc(windowId, role);
			return {
				role,
				running: managed !== undefined && !managed.process.killed,
				pid: managed?.pid,
			};
		}
		const reasoner = getProc(windowId, 'reasoner');
		const worker = getProc(windowId, 'worker');
		return {
			reasoner: { running: !!reasoner && !reasoner.process.killed, pid: reasoner?.pid },
			worker: { running: !!worker && !worker.process.killed, pid: worker?.pid },
		};
	});

	ipcMain.handle('chipos:workerStatus', async (event) => {
		const windowId = event.sender.id;
		const worker = getProc(windowId, 'worker');
		return { running: !!worker && !worker.process.killed, pid: worker?.pid };
	});
}
