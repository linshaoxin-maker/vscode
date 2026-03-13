/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { createConnection, Socket } from 'net';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISidecarManagerService, SidecarState } from '../../../../workbench/contrib/chipos/common/sidecarService.js';

const DEFAULT_PORT = 8765;
const MAX_PORT_ATTEMPTS = 10;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const MAX_RESTART_COUNT = 3;
const RESTART_DELAY_MS = 1_000;
const KILL_TIMEOUT_MS = 5_000;

export class SidecarManager extends Disposable implements ISidecarManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<SidecarState>());
	readonly onDidChangeState: Event<SidecarState> = this._onDidChangeState.event;

	private _state: SidecarState = SidecarState.NotStarted;
	private _port: number = DEFAULT_PORT;
	private _process: ChildProcess | undefined;
	private _restartCount = 0;
	private _disposed = false;
	private _healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
	private _manualUrl: string | undefined;

	get state(): SidecarState {
		return this._state;
	}

	get port(): number {
		return this._port;
	}

	get wsUrl(): string {
		if (this._manualUrl) {
			return this._manualUrl;
		}
		return `ws://127.0.0.1:${this._port}/ws/agent`;
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		const manualUrl = this._configurationService.getValue<string>('chipos.sidecar.manualUrl');
		if (manualUrl) {
			this._manualUrl = manualUrl;
		}
	}

	async spawn(): Promise<void> {
		if (this._disposed) {
			return;
		}

		if (this._manualUrl) {
			this._logService.info('[ChipOS Sidecar] Using manual URL:', this._manualUrl);
			this._setState(SidecarState.Connected);
			return;
		}

		this._setState(SidecarState.Spawning);

		const backendDir = this._resolveBackendDir();
		const pythonPath = this._resolvePythonPath(backendDir);

		if (!existsSync(pythonPath)) {
			this._logService.error('[ChipOS Sidecar] Python binary not found:', pythonPath);
			this._setState(SidecarState.Error);
			return;
		}

		this._port = await this._findAvailablePort(
			this._configurationService.getValue<number>('chipos.sidecar.port') || DEFAULT_PORT
		);
		this._logService.info('[ChipOS Sidecar] Spawning on port', this._port);

		try {
			this._process = spawn(
				pythonPath,
				['-m', 'uvicorn', 'main_ws:app', '--host', '127.0.0.1', '--port', String(this._port)],
				{
					cwd: backendDir,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
				}
			);

			this._attachProcessHandlers(this._process);
			this._setState(SidecarState.HealthChecking);
			await this._healthCheckLoop();
		} catch (err) {
			this._logService.error('[ChipOS Sidecar] Failed to spawn:', String(err));
			this._setState(SidecarState.Error);
		}
	}

	async kill(): Promise<void> {
		this._clearHealthCheckTimer();

		const proc = this._process;
		if (!proc || proc.killed) {
			this._process = undefined;
			return;
		}

		this._logService.info('[ChipOS Sidecar] Sending SIGTERM');
		proc.kill('SIGTERM');

		const killed = await new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				resolve(false);
			}, KILL_TIMEOUT_MS);

			proc.once('exit', () => {
				clearTimeout(timeout);
				resolve(true);
			});
		});

		if (!killed) {
			this._logService.info('[ChipOS Sidecar] SIGTERM timeout, sending SIGKILL');
			proc.kill('SIGKILL');
		}

		this._process = undefined;
		this._setState(SidecarState.Disconnected);
		this._logService.info('[ChipOS Sidecar] Process killed');
	}

	setManualUrl(url: string | undefined): void {
		this._manualUrl = url;
	}

	override dispose(): void {
		this._disposed = true;
		this._clearHealthCheckTimer();
		if (this._process && !this._process.killed) {
			this._process.kill('SIGKILL');
			this._process = undefined;
		}
		super.dispose();
	}

	// ── Path resolution ────────────────────────────────────────────────────

	private _resolveBackendDir(): string {
		const appRoot = this._environmentService.appRoot;
		return join(appRoot, 'resources', 'chipos-backend');
	}

	private _resolvePythonPath(backendDir: string): string {
		if (process.platform === 'win32') {
			return join(backendDir, 'python', 'python.exe');
		}
		return join(backendDir, 'python', 'bin', 'python3');
	}

	// ── Port detection ─────────────────────────────────────────────────────

	private async _findAvailablePort(startPort: number): Promise<number> {
		for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
			const port = startPort + offset;
			const available = await this._isPortAvailable(port);
			if (available) {
				return port;
			}
			this._logService.info('[ChipOS Sidecar] Port', port, 'in use, trying next');
		}
		this._logService.error('[ChipOS Sidecar] No available port in range', startPort, '-', startPort + MAX_PORT_ATTEMPTS - 1);
		return startPort;
	}

	private _isPortAvailable(port: number): Promise<boolean> {
		return new Promise(resolve => {
			const socket: Socket = createConnection({ port, host: '127.0.0.1' });
			socket.once('connect', () => {
				socket.destroy();
				resolve(false);
			});
			socket.once('error', () => {
				socket.destroy();
				resolve(true);
			});
		});
	}

	// ── Process handlers ───────────────────────────────────────────────────

	private _attachProcessHandlers(proc: ChildProcess): void {
		proc.stdout?.on('data', (data: Buffer) => {
			const lines = data.toString().trim();
			if (lines) {
				this._logService.info('[ChipOS Sidecar stdout]', lines);
			}
		});

		proc.stderr?.on('data', (data: Buffer) => {
			const lines = data.toString().trim();
			if (lines) {
				this._logService.error('[ChipOS Sidecar stderr]', lines);
			}
		});

		proc.once('exit', (code, signal) => {
			this._logService.info('[ChipOS Sidecar] Process exited, code:', code, 'signal:', signal);
			this._process = undefined;

			if (!this._disposed && this._state !== SidecarState.NotStarted) {
				this._handleCrash(code);
			}
		});

		proc.once('error', (err) => {
			this._logService.error('[ChipOS Sidecar] Process error:', err.message);
		});
	}

	// ── Health check ───────────────────────────────────────────────────────

	private async _healthCheckLoop(): Promise<void> {
		const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;

		while (Date.now() < deadline && !this._disposed) {
			if (this._state !== SidecarState.HealthChecking) {
				return;
			}

			const healthy = await this._healthCheck();
			if (healthy) {
				this._restartCount = 0;
				this._setState(SidecarState.Connected);
				this._logService.info('[ChipOS Sidecar] Health check passed, connected on port', this._port);
				return;
			}

			await this._delay(HEALTH_CHECK_INTERVAL_MS);
		}

		if (this._state === SidecarState.HealthChecking) {
			this._logService.error('[ChipOS Sidecar] Health check timed out after', HEALTH_CHECK_TIMEOUT_MS, 'ms');
			this._setState(SidecarState.Error);
		}
	}

	private _healthCheck(): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const socket: Socket = createConnection(
				{ port: this._port, host: '127.0.0.1' },
				() => {
					socket.destroy();
					resolve(true);
				}
			);
			socket.setTimeout(HEALTH_CHECK_INTERVAL_MS);
			socket.once('timeout', () => {
				socket.destroy();
				resolve(false);
			});
			socket.once('error', () => {
				socket.destroy();
				resolve(false);
			});
		});
	}

	// ── Crash recovery ─────────────────────────────────────────────────────

	private _handleCrash(code: number | null): void {
		this._clearHealthCheckTimer();
		this._setState(SidecarState.Disconnected);

		this._restartCount++;
		this._logService.info('[ChipOS Sidecar] Crash detected, exit code:', code, 'restart attempt:', this._restartCount, '/', MAX_RESTART_COUNT);

		if (this._restartCount > MAX_RESTART_COUNT) {
			this._logService.error('[ChipOS Sidecar] Max restart attempts exceeded. Giving up.');
			this._setState(SidecarState.Error);
			return;
		}

		this._logService.info('[ChipOS Sidecar] Scheduling restart in', RESTART_DELAY_MS, 'ms');
		this._healthCheckTimer = setTimeout(() => {
			if (!this._disposed) {
				this.spawn();
			}
		}, RESTART_DELAY_MS);
	}

	// ── State management ───────────────────────────────────────────────────

	private _setState(state: SidecarState): void {
		if (this._state === state) {
			return;
		}
		const prev = this._state;
		this._state = state;
		this._logService.info('[ChipOS Sidecar] State:', prev, '→', state);
		this._onDidChangeState.fire(state);
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	private _clearHealthCheckTimer(): void {
		if (this._healthCheckTimer !== undefined) {
			clearTimeout(this._healthCheckTimer);
			this._healthCheckTimer = undefined;
		}
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(resolve => {
			this._healthCheckTimer = setTimeout(resolve, ms);
		});
	}
}
