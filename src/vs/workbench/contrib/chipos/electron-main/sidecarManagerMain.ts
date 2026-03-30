/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R29: sidecarManagerMain — Electron main 进程 IPC handler。
 *
 * 在 main 进程中管理 Reasoner + Worker 子进程的生命周期，
 * renderer 通过 ipcRenderer.invoke('chipos:*') 调用。
 *
 * Fix: 按 webContentsId 隔离进程管理，多窗口不再互相干扰。
 * 每个窗口有自己的 Reasoner + Worker 进程。
 * 窗口关闭时自动清理对应进程。
 */

import * as cp from 'child_process';
import { BrowserWindow, ipcMain } from 'electron';

// ── 进程管理（按窗口隔离） ──────────────────────────────────────────

interface ManagedProcess {
	process: cp.ChildProcess;
	pid: number | undefined;
	role: 'reasoner' | 'worker';
}

/** windowId → role → ManagedProcess */
const windowProcesses = new Map<number, Map<string, ManagedProcess>>();

export interface SpawnProcessArgs {
	pythonPath: string;
	moduleArgs: string[];
	env: Record<string, string>;
	cwd: string;
	role: 'reasoner' | 'worker';
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

/** Clean up all processes for a window (called on window close). */
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

/**
 * 注册所有 ChipOS 进程管理相关的 IPC handler。
 * 应在 app.whenReady() 之后调用。
 */
export function registerSidecarIpcHandlers(): void {

	// Auto-cleanup on window close
	BrowserWindow.getAllWindows().forEach(win => {
		win.on('closed', () => cleanupWindow(win.webContents.id));
	});
	// Also listen for new windows
	const { app } = require('electron');
	app.on('browser-window-created', (_e: unknown, win: BrowserWindow) => {
		win.on('closed', () => cleanupWindow(win.webContents.id));
	});

	// ── chipos:spawnProcess ──────────────────────────────────────────────

	ipcMain.handle('chipos:spawnProcess', async (event, args: SpawnProcessArgs) => {
		const windowId = event.sender.id;
		const { pythonPath, moduleArgs, env, cwd, role } = args;

		const existing = getProc(windowId, role);
		if (existing && !existing.process.killed) {
			return { pid: existing.pid, alreadyRunning: true, role };
		}

		const child = cp.spawn(pythonPath, moduleArgs, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: false,
		});

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

	// ── chipos:spawnWorker（向后兼容） ──────────────────────────────────

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
		child.stderr?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) { console.log(`[ChipOS ${role} stderr] ${line}`); }
		});
		return { pid: child.pid, role };
	});

	// ── chipos:killProcess ───────────────────────────────────────────────

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

	// ── chipos:killWorker（向后兼容） ────────────────────────────────────

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

	// ── chipos:processStatus ─────────────────────────────────────────────

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
		// 返回当前窗口的所有进程状态
		const reasoner = getProc(windowId, 'reasoner');
		const worker = getProc(windowId, 'worker');
		return {
			reasoner: {
				running: reasoner !== undefined && !reasoner.process.killed,
				pid: reasoner?.pid,
			},
			worker: {
				running: worker !== undefined && !worker.process.killed,
				pid: worker?.pid,
			},
		};
	});

	// ── chipos:workerStatus（向后兼容） ──────────────────────────────────

	ipcMain.handle('chipos:workerStatus', async (event) => {
		const windowId = event.sender.id;
		const worker = getProc(windowId, 'worker');
		return {
			running: worker !== undefined && !worker.process.killed,
			pid: worker?.pid,
		};
	});
}
