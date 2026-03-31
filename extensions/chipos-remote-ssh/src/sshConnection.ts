/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * SSH Connection Manager — 封装 ssh2 库，管理 SSH 连接生命周期。
 *
 * 职责：
 * 1. 建立 SSH 连接（密码/密钥/agent）
 * 2. 在远程执行命令
 * 3. 端口转发（本地端口 → 远程端口）
 * 4. 连接健康检查和断线重连
 */

import { Client, ConnectConfig, ClientChannel } from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';

export interface SshConnectionOptions {
	host: string;
	port?: number;
	username: string;
	privateKeyPath?: string;
	password?: string;
	/** Use SSH agent for authentication */
	useAgent?: boolean;
}

export class SshConnection {

	private _client: Client | undefined;
	private _connected = false;
	private _forwardedPorts: Map<number, net.Server> = new Map();

	get connected(): boolean { return this._connected; }

	constructor(
		private readonly _options: SshConnectionOptions,
		private readonly _log: (msg: string) => void,
	) { }

	/**
	 * Establish SSH connection to the remote host.
	 */
	async connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const client = new Client();

			const config: ConnectConfig = {
				host: this._options.host,
				port: this._options.port ?? 22,
				username: this._options.username,
			};

			// Authentication: private key > agent > password
			if (this._options.privateKeyPath) {
				const keyPath = this._options.privateKeyPath.replace(/^~/, os.homedir());
				try {
					config.privateKey = fs.readFileSync(keyPath);
					this._log(`[SSH] Using private key: ${keyPath}`);
				} catch (err) {
					reject(new Error(`Cannot read SSH key: ${keyPath} — ${err}`));
					return;
				}
			} else if (this._options.useAgent !== false) {
				// Try SSH agent (default on macOS/Linux)
				config.agent = process.env.SSH_AUTH_SOCK;
				this._log('[SSH] Using SSH agent');
			} else if (this._options.password) {
				config.password = this._options.password;
				this._log('[SSH] Using password authentication');
			}

			// Interactive keyboard auth (for 2FA, password prompts, etc.)
			config.tryKeyboard = true;

			client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
				// For simple password prompts, use the stored password
				if (prompts.length === 1 && this._options.password) {
					finish([this._options.password]);
				} else {
					// For other prompts (2FA, etc.), we'd need UI integration
					// For now, send empty responses
					finish(prompts.map(() => ''));
				}
			});

			client.on('ready', () => {
				this._log(`[SSH] Connected to ${this._options.host}`);
				this._client = client;
				this._connected = true;
				resolve();
			});

			client.on('error', (err) => {
				this._log(`[SSH] Connection error: ${err.message}`);
				this._connected = false;
				reject(err);
			});

			client.on('close', () => {
				this._log('[SSH] Connection closed');
				this._connected = false;
				this._client = undefined;
			});

			this._log(`[SSH] Connecting to ${this._options.username}@${this._options.host}:${config.port}...`);
			client.connect(config);
		});
	}

	/**
	 * Execute a command on the remote host.
	 * Returns stdout output. Rejects on non-zero exit code.
	 */
	async exec(command: string): Promise<string> {
		if (!this._client) {
			throw new Error('SSH not connected');
		}

		return new Promise<string>((resolve, reject) => {
			this._client!.exec(command, (err, channel) => {
				if (err) {
					reject(err);
					return;
				}

				let stdout = '';
				let stderr = '';

				channel.on('data', (data: Buffer) => {
					stdout += data.toString();
				});

				channel.stderr.on('data', (data: Buffer) => {
					stderr += data.toString();
					this._log(`[SSH stderr] ${data.toString().trim()}`);
				});

				channel.on('close', (code: number) => {
					if (code === 0) {
						resolve(stdout);
					} else {
						reject(new Error(`Command exited with code ${code}: ${stderr.trim()}`));
					}
				});
			});
		});
	}

	/**
	 * Execute a command and pipe data to its stdin.
	 * Used for uploading files via `cat > remote_path`.
	 * Handles large buffers by writing in chunks with backpressure.
	 */
	async execWithStdin(command: string, data: Buffer): Promise<string> {
		if (!this._client) {
			throw new Error('SSH not connected');
		}

		return new Promise<string>((resolve, reject) => {
			this._client!.exec(command, (err, channel) => {
				if (err) {
					reject(err);
					return;
				}

				let stdout = '';
				let stderr = '';

				channel.on('data', (chunk: Buffer) => {
					stdout += chunk.toString();
				});

				channel.stderr.on('data', (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				channel.on('close', (code: number) => {
					if (code === 0) {
						resolve(stdout);
					} else {
						reject(new Error(`Command exited with code ${code}: ${stderr.trim()}`));
					}
				});

				// Write data in chunks to handle backpressure
				const CHUNK_SIZE = 64 * 1024; // 64KB chunks
				let offset = 0;

				const writeNext = () => {
					let canContinue = true;
					while (canContinue && offset < data.length) {
						const end = Math.min(offset + CHUNK_SIZE, data.length);
						const chunk = data.subarray(offset, end);
						offset = end;

						if (offset >= data.length) {
							// Last chunk — write and end
							channel.write(chunk, () => {
								channel.end();
							});
							return;
						} else {
							canContinue = channel.write(chunk);
						}
					}
					if (offset < data.length) {
						// Backpressure: wait for drain event
						channel.once('drain', writeNext);
					}
				};

				writeNext();
			});
		});
	}

	/**
	 * Execute a long-running command on the remote host.
	 * Returns the channel for streaming stdout/stderr.
	 * The caller is responsible for handling the channel lifecycle.
	 */
	async execStream(command: string): Promise<ClientChannel> {
		if (!this._client) {
			throw new Error('SSH not connected');
		}

		return new Promise<ClientChannel>((resolve, reject) => {
			this._client!.exec(command, (err, channel) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(channel);
			});
		});
	}

	/**
	 * Forward a local port to a remote port.
	 * Creates a local TCP server that tunnels connections through SSH.
	 *
	 * @returns The actual local port (may differ from requested if 0)
	 */
	async forwardPort(localPort: number, remoteHost: string, remotePort: number): Promise<number> {
		if (!this._client) {
			throw new Error('SSH not connected');
		}

		return new Promise<number>((resolve, reject) => {
			const server = net.createServer((localSocket) => {
				this._client!.forwardOut(
					'127.0.0.1', localPort,
					remoteHost, remotePort,
					(err, remoteSocket) => {
						if (err) {
							this._log(`[SSH] Port forward error: ${err.message}`);
							localSocket.destroy();
							return;
						}
						localSocket.pipe(remoteSocket);
						remoteSocket.pipe(localSocket);
					}
				);
			});

			server.listen(localPort, '127.0.0.1', () => {
				const actualPort = (server.address() as net.AddressInfo).port;
				this._log(`[SSH] Port forward: localhost:${actualPort} → ${remoteHost}:${remotePort}`);
				this._forwardedPorts.set(actualPort, server);
				resolve(actualPort);
			});

			server.on('error', (err) => {
				reject(err);
			});
		});
	}

	/**
	 * Disconnect and clean up all resources.
	 */
	dispose(): void {
		// Close all port forwards
		for (const [port, server] of this._forwardedPorts) {
			this._log(`[SSH] Closing port forward on localhost:${port}`);
			server.close();
		}
		this._forwardedPorts.clear();

		// Close SSH connection
		if (this._client) {
			this._client.end();
			this._client = undefined;
		}
		this._connected = false;
	}
}

/**
 * Parse an SSH target string into connection options.
 *
 * Supported formats:
 * - user@host
 * - user@host:port
 * - host (username defaults to current user)
 */
export function parseSshTarget(target: string): SshConnectionOptions {
	let username = os.userInfo().username;
	let host = target;
	let port = 22;

	// user@host
	const atIdx = target.indexOf('@');
	if (atIdx !== -1) {
		username = target.substring(0, atIdx);
		host = target.substring(atIdx + 1);
	}

	// host:port
	const colonIdx = host.lastIndexOf(':');
	if (colonIdx !== -1) {
		const portStr = host.substring(colonIdx + 1);
		const parsedPort = parseInt(portStr, 10);
		if (!isNaN(parsedPort)) {
			port = parsedPort;
			host = host.substring(0, colonIdx);
		}
	}

	return { host, port, username };
}
