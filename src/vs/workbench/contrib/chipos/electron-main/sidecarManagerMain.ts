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
 * 复盘 Fix1: Reasoner 和 Worker 是两个独立进程，必须用独立变量管理。
 * 之前只有一个 workerProcess 变量，导致 spawn Reasoner 后 Worker 永远不会启动。
 */

import * as cp from 'child_process';
import { ipcMain } from 'electron';

// ── 进程管理（Reasoner + Worker 独立） ──────────────────────────────────

interface ManagedProcess {
	process: cp.ChildProcess;
	pid: number | undefined;
	role: 'reasoner' | 'worker';
}

let reasonerProc: ManagedProcess | undefined;
let workerProc: ManagedProcess | undefined;

export interface SpawnProcessArgs {
	pythonPath: string;
	moduleArgs: string[];
	env: Record<string, string>;
	cwd: string;
	role: 'reasoner' | 'worker';
}

function getProc(role: 'reasoner' | 'worker'): ManagedProcess | undefined {
	return role === 'reasoner' ? reasonerProc : workerProc;
}

function setProc(role: 'reasoner' | 'worker', proc: ManagedProcess | undefined): void {
	if (role === 'reasoner') {
		reasonerProc = proc;
	} else {
		workerProc = proc;
	}
}

/**
 * 注册所有 ChipOS 进程管理相关的 IPC handler。
 * 应在 app.whenReady() 之后调用。
 */
export function registerSidecarIpcHandlers(): void {

	// ── chipos:spawnProcess ──────────────────────────────────────────────
	// 替代原来的 chipos:spawnWorker，支持 role 区分 Reasoner/Worker

	ipcMain.handle('chipos:spawnProcess', async (_event, args: SpawnProcessArgs) => {
		const { pythonPath, moduleArgs, env, cwd, role } = args;

		const existing = getProc(role);
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
			role,
		};
		setProc(role, managed);

		child.on('exit', (code, signal) => {
			console.log(`[ChipOS ${role}] exited: code=${code} signal=${signal}`);
			setProc(role, undefined);
		});

		child.on('error', (err) => {
			console.error(`[ChipOS ${role}] error: ${err.message}`);
			setProc(role, undefined);
		});

		child.stderr?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) {
				console.log(`[ChipOS ${role} stderr] ${line}`);
			}
		});

		return { pid: child.pid, role };
	});

	// ── chipos:spawnWorker（向后兼容，委托 spawnProcess） ─────────────────

	ipcMain.handle('chipos:spawnWorker', async (_event, args: any) => {
		const role = args.role || 'worker';
		return ipcMain.emit('chipos:spawnProcess', _event, { ...args, role });
	});

	// ── chipos:killProcess ───────────────────────────────────────────────

	ipcMain.handle('chipos:killProcess', async (_event, role: 'reasoner' | 'worker') => {
		const managed = getProc(role);
		if (!managed || managed.process.killed) {
			return { success: true, wasRunning: false, role };
		}

		const pid = managed.pid;
		managed.process.kill('SIGTERM');

		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 5000);
			managed.process.on('exit', () => {
				clearTimeout(timer);
				resolve(true);
			});
		});

		if (!exited) {
			const current = getProc(role);
			if (current && !current.process.killed) {
				current.process.kill('SIGKILL');
			}
		}

		setProc(role, undefined);
		return { success: true, wasRunning: true, pid, role };
	});

	// ── chipos:killWorker（向后兼容） ────────────────────────────────────

	ipcMain.handle('chipos:killWorker', async () => {
		const managed = getProc('worker');
		if (!managed || managed.process.killed) {
			return { success: true, wasRunning: false };
		}
		const pid = managed.pid;
		managed.process.kill('SIGTERM');
		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 5000);
			managed.process.on('exit', () => { clearTimeout(timer); resolve(true); });
		});
		if (!exited) {
			const current = getProc('worker');
			if (current && !current.process.killed) {
				current.process.kill('SIGKILL');
			}
		}
		setProc('worker', undefined);
		return { success: true, wasRunning: true, pid };
	});

	// ── chipos:processStatus ─────────────────────────────────────────────

	ipcMain.handle('chipos:processStatus', async (_event, role?: 'reasoner' | 'worker') => {
		if (role) {
			const managed = getProc(role);
			return {
				role,
				running: managed !== undefined && !managed.process.killed,
				pid: managed?.pid,
			};
		}
		// 返回所有进程状态
		return {
			reasoner: {
				running: reasonerProc !== undefined && !reasonerProc.process.killed,
				pid: reasonerProc?.pid,
			},
			worker: {
				running: workerProc !== undefined && !workerProc.process.killed,
				pid: workerProc?.pid,
			},
		};
	});

	// ── chipos:workerStatus（向后兼容） ──────────────────────────────────

	ipcMain.handle('chipos:workerStatus', async () => {
		return {
			running: workerProc !== undefined && !workerProc.process.killed,
			pid: workerProc?.pid,
		};
	});
}
