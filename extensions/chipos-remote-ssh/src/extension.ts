/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { SshConnection, SshConnectionOptions } from './sshConnection';
import { ServerManager } from './serverManager';
import { WorkerManager } from './workerManager';
import { getWorkerInstallPath } from './download';

let outputChannel: vscode.OutputChannel;

interface RemoteSession {
	ssh: SshConnection;
	server: ServerManager;
	worker: WorkerManager | undefined;
}

const activeSessions = new Map<string, RemoteSession>();
const pendingWorkspacePaths = new Map<string, string>();

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('ChipOS Remote SSH');
	context.subscriptions.push(outputChannel);

	log('ChipOS Remote SSH extension activated');

	// Register the remote authority resolver for 'chipos-ssh' prefix
	// When a URI like vscode-remote://chipos-ssh+user@host/path is opened,
	// this resolver is called to establish the connection.
	const authorityResolver = vscode.workspace.registerRemoteAuthorityResolver(
		'chipos-ssh',
		new ChipOSSSHResolver(context)
	);
	context.subscriptions.push(authorityResolver);

	// ── Commands ──

	context.subscriptions.push(
		vscode.commands.registerCommand('chipos-remote-ssh.connect', () => connectToHost(false)),
		vscode.commands.registerCommand('chipos-remote-ssh.connectInCurrentWindow', () => connectToHost(true)),
		vscode.commands.registerCommand('chipos-remote-ssh.showLog', () => outputChannel.show()),
		vscode.commands.registerCommand('chipos-remote-ssh.disconnect', () => disconnect()),
	);
}

export function deactivate(): Promise<void> {
	return disconnect();
}

// ── Resolver ────────────────────────────────────────────────────────────────

class ChipOSSSHResolver implements vscode.RemoteAuthorityResolver {

	constructor(private readonly _context: vscode.ExtensionContext) { }

	/**
	 * Called by VS Code when it needs to resolve a remote authority.
	 * Authority format: chipos-ssh+user@host
	 *
	 * This method:
	 * 1. Parses the SSH target from the authority
	 * 2. Establishes an SSH connection
	 * 3. Starts ChipOS Server on the remote machine
	 * 4. Returns the resolved authority (host + port + token)
	 */
	async resolve(authority: string, _context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolvedAuthority> {
		log(`Resolving authority: ${authority}`);

		// Parse authority: "chipos-ssh+user@host" → "user@host"
		const sshTarget = parseAuthority(authority);
		if (!sshTarget) {
			throw vscode.RemoteAuthorityResolverError.NotAvailable(
				`Invalid SSH authority: ${authority}. Expected format: chipos-ssh+user@host`,
				true
			);
		}

		log(`SSH target: ${sshTarget}`);

		// Wrap in progress notification so user sees what's happening
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Connecting to ${sshTarget}`,
				cancellable: true,
			},
			async (progress, cancelToken) => {
				let sshConn: SshConnection | undefined;
				let serverMgr: ServerManager | undefined;
				let workerMgr: WorkerManager | undefined;

				try {
				// 1. Establish SSH connection
				progress.report({ message: 'Establishing SSH connection...' });
				const sshOptions = await buildSshOptions(sshTarget);

				// If no key and no agent, ask for password upfront
				if (!sshOptions.privateKeyPath && !process.env.SSH_AUTH_SOCK) {
					const password = await vscode.window.showInputBox({
						prompt: `Enter password for ${sshOptions.username}@${sshOptions.host}`,
						password: true,
					});
					if (!password) {
						throw new Error('Authentication cancelled by user');
					}
					sshOptions.password = password;
					sshOptions.useAgent = false;
				}

				if (cancelToken.isCancellationRequested) {
					throw new Error('Connection cancelled');
				}

				sshConn = new SshConnection(sshOptions, log);
				try {
					await sshConn.connect();
				} catch (firstErr) {
					// Key/agent auth failed — fallback to password
					const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
					if (msg.includes('authentication') || msg.includes('auth')) {
						log(`[SSH] Key/agent auth failed, prompting for password...`);
						sshConn.dispose();
						sshConn = undefined;

						const password = await vscode.window.showInputBox({
							prompt: `Key auth failed. Enter password for ${sshOptions.username}@${sshOptions.host}`,
							password: true,
						});
						if (!password) {
							throw new Error('Authentication cancelled by user');
						}
						sshOptions.password = password;
						sshOptions.privateKeyPath = undefined;
						sshOptions.useAgent = false;

						sshConn = new SshConnection(sshOptions, log);
						await sshConn.connect();
					} else {
						throw firstErr;
					}
				}
				log('SSH connection established');

				// 2. Start ChipOS Server on remote
				progress.report({ message: 'Starting ChipOS Server on remote...' });
				const installPath = vscode.workspace.getConfiguration('chipos.remote.ssh')
					.get<string>('serverInstallPath', '~/.chipos-server');

				if (cancelToken.isCancellationRequested) {
					throw new Error('Connection cancelled');
				}

				serverMgr = new ServerManager(sshConn, installPath, log);
				const { port, connectionToken } = await serverMgr.ensureServerRunning();
				log(`ChipOS Server running on remote port ${port}`);

				// 3. Create a local TCP tunnel to the remote VS Code Server port
				progress.report({ message: 'Setting up port forwarding...' });
				const localPort = await sshConn.forwardPort(0, '127.0.0.1', port);
				log(`Local port forwarding: 127.0.0.1:${localPort} → remote:${port}`);

				// 4. Forward the Reasoning HTTP port so the local renderer's
				//    SSE client (browser fetch/EventSource) can reach the remote backend.
				const reasoningPort = vscode.workspace.getConfiguration('chipos.backend')
					.get<number>('httpPort', 8080);
				let localReasoningPort = reasoningPort;
				try {
					localReasoningPort = await sshConn.forwardPort(0, '127.0.0.1', reasoningPort);
					log(`Reasoning port forwarding: 127.0.0.1:${localReasoningPort} → remote:${reasoningPort}`);
					if (localReasoningPort !== reasoningPort) {
						// TODO(P2-12): Global config may conflict with a concurrent B2/Local window.
						// Migrate to Workspace or memento-scoped config in a future iteration.
						await vscode.workspace.getConfiguration('chipos.backend').update(
							'reasoningUrl', `http://127.0.0.1:${localReasoningPort}`, vscode.ConfigurationTarget.Global);
					}
				} catch (fwdErr) {
					log(`[WARN] Could not forward reasoning port ${reasoningPort}: ${fwdErr}`);
					vscode.window.showWarningMessage(
						`ChipOS: Failed to forward Reasoning port ${reasoningPort}. Chat may not work. Check if the port is already in use locally.`);
				}

				// 4b. Probe Reasoner health through the SSH tunnel
				try {
					const probeUrl = `http://127.0.0.1:${localReasoningPort}`;
					log(`[Probe] Checking Reasoner health at ${probeUrl}/health ...`);
					const controller = new AbortController();
					const probeTimer = setTimeout(() => controller.abort(), 5000);
					const resp = await fetch(`${probeUrl}/health`, { signal: controller.signal });
					clearTimeout(probeTimer);
					if (resp.ok) {
						const body = await resp.json() as { status?: string; workers_connected?: number };
						log(`Reasoner health: ${JSON.stringify(body)}`);
					} else {
						log(`[WARN] Reasoner /health returned ${resp.status}`);
						vscode.window.showWarningMessage(
							`ChipOS: Reasoner on remote returned HTTP ${resp.status}. Make sure the Reasoner is running on the remote server.`);
					}
				} catch {
					log('[WARN] Reasoner /health probe failed — Reasoner may not be running on remote');
					vscode.window.showWarningMessage(
						'ChipOS: Cannot reach Reasoner on remote server. Please start the Reasoner first (see startup guide).');
				}

				// 5. FEAT-R23: Start Worker on remote + forward Worker HTTP port
				progress.report({ message: 'Starting Execution Worker on remote...' });
				log('[Step 5] Starting Worker deployment...');
				const workerInstallPath = getWorkerInstallPath();
				log(`[Step 5] workerInstallPath=${workerInstallPath}`);
				const reasonerGrpcTarget = resolveReasonerGrpcTarget();
				log(`[Step 5] reasonerGrpcTarget=${reasonerGrpcTarget}`);
				workerMgr = new WorkerManager(sshConn, workerInstallPath, log);
				try {
					const folders = vscode.workspace.workspaceFolders;
					const remoteWorkspacePath =
						pendingWorkspacePaths.get(authority)
						|| (folders && folders.length > 0 ? folders[0].uri.path : undefined);
					pendingWorkspacePaths.delete(authority);
					log(`[Step 5] remoteWorkspacePath=${remoteWorkspacePath}`);
					await workerMgr.ensureWorkerRunning(reasonerGrpcTarget, remoteWorkspacePath);
					log('[Step 5] Execution Worker started on remote');

					const workerHttpPort = vscode.workspace.getConfiguration('chipos.backend')
						.get<number>('workerHttpPort', 8081);
					try {
						const localWorkerPort = await sshConn.forwardPort(0, '127.0.0.1', workerHttpPort);
						log(`[Step 5] Worker HTTP port forwarding: 127.0.0.1:${localWorkerPort} → remote:${workerHttpPort}`);
						if (localWorkerPort !== workerHttpPort) {
							// TODO(P2-12): Same Global scope caveat as reasoningUrl above.
							await vscode.workspace.getConfiguration('chipos.backend').update(
								'workerHttpUrl', `http://127.0.0.1:${localWorkerPort}`, vscode.ConfigurationTarget.Global);
						}
					} catch (fwdErr) {
						log(`[Step 5][WARN] Could not forward worker HTTP port: ${fwdErr}`);
						vscode.window.showWarningMessage(
							`ChipOS: Failed to forward Worker HTTP port ${workerHttpPort}. Remote execution UI may not work.`);
					}
				} catch (workerErr) {
					const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
					log(`[Step 5][WARN] Worker start failed (non-fatal): ${workerMsg}`);
					vscode.window.showWarningMessage(
						`ChipOS: Worker deployment failed: ${workerMsg}. Chat still works, but remote execution won't be available.`);
				}

				// P1-7: Store per-authority session — multiple remote servers can coexist
				activeSessions.set(authority, { ssh: sshConn, server: serverMgr, worker: workerMgr });

				return new vscode.ResolvedAuthority('127.0.0.1', localPort, connectionToken);

			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log(`Resolution failed: ${message}`);

				// Clean up on failure — only this authority's resources
				if (sshConn) {
					sshConn.dispose();
				}

				if (message.includes('cancelled')) {
					throw vscode.RemoteAuthorityResolverError.NotAvailable('Connection cancelled', true);
				}
				if (message.includes('ECONNREFUSED') || message.includes('timeout')) {
					throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(
						`Cannot connect to ${sshTarget}: ${message}`
					);
				}

				throw vscode.RemoteAuthorityResolverError.NotAvailable(
					`SSH connection failed: ${message}`,
					true
				);
			}
			}
		);
	}

	/**
	 * Called when the tunnel to the remote is closed.
	 */
	tunnelFactory?: vscode.TunnelFactory;

	/**
	 * Provide information about the remote environment.
	 */
	getCanonicalURI?(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
		return uri;
	}
}

// ── Commands ────────────────────────────────────────────────────────────────

async function connectToHost(reuseWindow: boolean): Promise<void> {
	const hosts = await getSshHosts();
	const defaultHost = vscode.workspace.getConfiguration('chipos.remote.ssh')
		.get<string>('defaultHost', '');

	let sshTarget: string | undefined;

	if (hosts.length > 0) {
		// Show QuickPick with existing hosts + manual entry as the FIRST option
		const manualItem: vscode.QuickPickItem = {
			label: '$(edit) Enter host manually...',
			description: '',
			alwaysShow: true,
		};
		const items: vscode.QuickPickItem[] = [
			manualItem,
			...hosts.map(h => ({ label: h, description: 'SSH Host' })),
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select or type a host (e.g. root@192.168.1.1)',
			title: 'ChipOS: Connect via SSH',
		});

		if (!selected) {
			return;
		}
		if (selected === manualItem) {
			sshTarget = undefined; // fall through to input box
		} else {
			sshTarget = selected.label;
		}
	}

	if (!sshTarget) {
		sshTarget = await vscode.window.showInputBox({
			prompt: 'Enter SSH host (e.g. root@192.168.1.1)',
			placeHolder: 'user@hostname',
			value: defaultHost,
		});
	}

	if (!sshTarget) {
		return;
	}

	log(`Connecting to SSH target: ${sshTarget}`);

	const remoteAuthority = `chipos-ssh+${sshTarget}`;

	const folderPath = await vscode.window.showInputBox({
		prompt: 'Enter the remote folder path to open',
		placeHolder: '/root/workspace',
		value: '/root/workspace',
	});

	const effectivePath = folderPath || '/';
	pendingWorkspacePaths.set(remoteAuthority, effectivePath);

	const folderUri = vscode.Uri.parse(`vscode-remote://${remoteAuthority}${effectivePath}`);
	await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: !reuseWindow });
}

async function disconnect(): Promise<void> {
	// Tear down ALL active remote sessions (fault-tolerant per session)
	for (const [authority, session] of activeSessions) {
		log(`Disconnecting ${authority}...`);
		try {
			if (session.worker) {
				await session.worker.stopWorker();
			}
			await session.server.stopServer();
		} catch (err) {
			log(`[WARN] Cleanup error for ${authority}: ${err}`);
		}
		session.ssh.dispose();
	}
	activeSessions.clear();

	// P1-6: Revert Global config overrides written during resolve(),
	// so B2/Local modes don't inherit stale SSH-tunnel URLs.
	const cfg = vscode.workspace.getConfiguration('chipos.backend');
	await cfg.update('reasoningUrl', undefined, vscode.ConfigurationTarget.Global);
	await cfg.update('workerHttpUrl', undefined, vscode.ConfigurationTarget.Global);

	log('Disconnected from all SSH hosts');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseAuthority(authority: string): string | undefined {
	// authority = "chipos-ssh+user@host" or "chipos-ssh+host"
	const prefix = 'chipos-ssh+';
	if (!authority.startsWith(prefix)) {
		return undefined;
	}
	const target = authority.substring(prefix.length);
	return target || undefined;
}

async function buildSshOptions(sshTarget: string): Promise<SshConnectionOptions> {
	// Parse user@host:port
	let user: string | undefined;
	let host: string;
	let port = 22;

	const atIdx = sshTarget.indexOf('@');
	if (atIdx >= 0) {
		user = sshTarget.substring(0, atIdx);
		host = sshTarget.substring(atIdx + 1);
	} else {
		host = sshTarget;
		user = os.userInfo().username;
	}

	const colonIdx = host.indexOf(':');
	if (colonIdx >= 0) {
		port = parseInt(host.substring(colonIdx + 1), 10) || 22;
		host = host.substring(0, colonIdx);
	}

	// Try to find SSH key
	const sshDir = path.join(os.homedir(), '.ssh');
	const keyFiles = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
	let privateKeyPath: string | undefined;
	for (const keyFile of keyFiles) {
		const keyPath = path.join(sshDir, keyFile);
		try {
			const { stat } = await import('fs/promises');
			await stat(keyPath);
			privateKeyPath = keyPath;
			break;
		} catch {
			// Key file doesn't exist, try next
		}
	}

	return { host, port, username: user || '', privateKeyPath };
}

async function getSshHosts(): Promise<string[]> {
	const hosts: string[] = [];

	// Read from SSH config
	const configFile = vscode.workspace.getConfiguration('chipos.remote.ssh')
		.get<string>('configFile', '');
	const sshConfigPath = configFile || path.join(os.homedir(), '.ssh', 'config');

	try {
		const { readFile } = await import('fs/promises');
		const content = await readFile(sshConfigPath, 'utf-8');
		const hostRegex = /^Host\s+(.+)$/gm;
		let match;
		while ((match = hostRegex.exec(content)) !== null) {
			const hostNames = match[1].trim().split(/\s+/);
			for (const h of hostNames) {
				if (!h.includes('*') && !h.includes('?')) {
					hosts.push(h);
				}
			}
		}
	} catch {
		// SSH config not found, that's fine
	}

	// Add default host if configured
	const defaultHost = vscode.workspace.getConfiguration('chipos.remote.ssh')
		.get<string>('defaultHost', '');
	if (defaultHost && !hosts.includes(defaultHost)) {
		hosts.unshift(defaultHost);
	}

	return hosts;
}

/**
 * Resolve the gRPC target address that the remote Worker should use to connect
 * to the Reasoner.  Priority:
 *   1. Explicit `chipos.backend.grpcAddress` (e.g. "10.0.0.5:50051")
 *   2. Host extracted from `chipos.backend.reasoningUrl` + `grpcPort`
 *   3. Fallback `127.0.0.1:<grpcPort>` (same-machine default)
 */
function resolveReasonerGrpcTarget(): string {
	const cfg = vscode.workspace.getConfiguration('chipos.backend');
	const explicit = cfg.get<string>('grpcAddress', '');
	if (explicit) {
		return explicit;
	}
	const grpcPort = cfg.get<number>('grpcPort', 50051);
	const reasoningUrl = cfg.get<string>('reasoningUrl', '');
	if (reasoningUrl) {
		try {
			const url = new URL(reasoningUrl);
			return `${url.hostname}:${grpcPort}`;
		} catch { /* fall through */ }
	}
	return `127.0.0.1:${grpcPort}`;
}

function log(message: string): void {
	const timestamp = new Date().toISOString().substring(11, 23);
	outputChannel.appendLine(`[${timestamp}] ${message}`);
}
