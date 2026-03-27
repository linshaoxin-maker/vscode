/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R29: sidecarManagerMain — Electron main 进程 IPC handler。
 *
 * 在 main 进程中管理 Worker 子进程的生命周期，
 * renderer 通过 ipcRenderer.invoke('chipos:*') 调用。
 */

import * as cp from 'child_process';
import { ipcMain } from 'electron';

let workerProcess: cp.ChildProcess | undefined;
let workerPid: number | undefined;

export interface SpawnWorkerArgs {
	pythonPath: string;
	moduleArgs: string[];
	env: Record<string, string>;
	cwd: string;
}

/**
 * 注册所有 ChipOS Worker 相关的 IPC handler。
 * 应在 app.whenReady() 之后调用。
 */
export function registerSidecarIpcHandlers(): void {

	// ── chipos:spawnWorker ────────────────────────────────────────────────

	ipcMain.handle('chipos:spawnWorker', async (_event, args: SpawnWorkerArgs) => {
		if (workerProcess && !workerProcess.killed) {
			return { pid: workerPid, alreadyRunning: true };
		}

		const { pythonPath, moduleArgs, env, cwd } = args;

		workerProcess = cp.spawn(pythonPath, moduleArgs, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: false,
		});

		workerPid = workerProcess.pid;

		workerProcess.on('exit', (code, signal) => {
			console.log(`[ChipOS Worker] exited: code=${code} signal=${signal}`);
			workerProcess = undefined;
			workerPid = undefined;
		});

		workerProcess.on('error', (err) => {
			console.error(`[ChipOS Worker] error: ${err.message}`);
			workerProcess = undefined;
			workerPid = undefined;
		});

		// 收集 stderr 用于诊断
		workerProcess.stderr?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) {
				console.log(`[ChipOS Worker stderr] ${line}`);
			}
		});

		return { pid: workerPid };
	});

	// ── chipos:killWorker ─────────────────────────────────────────────────

	ipcMain.handle('chipos:killWorker', async () => {
		if (!workerProcess || workerProcess.killed) {
			return { success: true, wasRunning: false };
		}

		const pid = workerPid;

		// SIGTERM first
		workerProcess.kill('SIGTERM');

		// Wait up to 5s for graceful exit
		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 5000);
			workerProcess?.on('exit', () => {
				clearTimeout(timer);
				resolve(true);
			});
		});

		if (!exited && workerProcess && !workerProcess.killed) {
			workerProcess.kill('SIGKILL');
		}

		workerProcess = undefined;
		workerPid = undefined;

		return { success: true, wasRunning: true, pid };
	});

	// ── chipos:workerStatus ───────────────────────────────────────────────

	ipcMain.handle('chipos:workerStatus', async () => {
		return {
			running: workerProcess !== undefined && !workerProcess.killed,
			pid: workerPid,
		};
	});
}
