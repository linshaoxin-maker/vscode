/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { SshConnection, SshConnectionOptions } from './sshConnection';
import { ServerManager } from './serverManager';

let outputChannel: vscode.OutputChannel;
let activeSshConnection: SshConnection | undefined;
let activeServerManager: ServerManager | undefined;

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

export function deactivate() {
	disconnect();
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
				try {
					// 1. Establish SSH connection
					progress.report({ message: 'Establishing SSH connection...' });
					const sshOptions = await buildSshOptions(sshTarget);

					// If no key and no agent, ask for password
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

					activeSshConnection = new SshConnection(sshOptions, log);
					await activeSshConnection.connect();
					log('SSH connection established');

					// 2. Start ChipOS Server on remote
					progress.report({ message: 'Starting ChipOS Server on remote...' });
					const installPath = vscode.workspace.getConfiguration('chipos.remote.ssh')
						.get<string>('serverInstallPath', '~/.chipos-server');

					if (cancelToken.isCancellationRequested) {
						throw new Error('Connection cancelled');
					}

					activeServerManager = new ServerManager(activeSshConnection, installPath, log);
					const { port, connectionToken } = await activeServerManager.ensureServerRunning();
					log(`ChipOS Server running on remote port ${port}`);

					// 3. Create a local TCP tunnel to the remote port
					progress.report({ message: 'Setting up port forwarding...' });
					const localPort = await activeSshConnection.forwardPort(0, '127.0.0.1', port);
					log(`Local port forwarding: 127.0.0.1:${localPort} → remote:${port}`);

					return new vscode.ResolvedAuthority('127.0.0.1', localPort, connectionToken);

				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					log(`Resolution failed: ${message}`);

					// Clean up on failure
					if (activeSshConnection) {
						activeSshConnection.dispose();
						activeSshConnection = undefined;
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

	if (folderPath) {
		const folderUri = vscode.Uri.parse(`vscode-remote://${remoteAuthority}${folderPath}`);
		await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: !reuseWindow });
	} else {
		const uri = vscode.Uri.parse(`vscode-remote://${remoteAuthority}/`);
		await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !reuseWindow });
	}
}

async function disconnect(): Promise<void> {
	if (activeServerManager) {
		await activeServerManager.stopServer();
		activeServerManager = undefined;
	}
	if (activeSshConnection) {
		activeSshConnection.dispose();
		activeSshConnection = undefined;
	}
	log('Disconnected from SSH host');
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

function log(message: string): void {
	const timestamp = new Date().toISOString().substring(11, 23);
	outputChannel.appendLine(`[${timestamp}] ${message}`);
}
