/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { DocumentSelector, LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

/**
 * ChipOS Verilog/SystemVerilog LSP — spawns two external LSP servers
 * (each independently toggleable via settings):
 *
 * 1. verible-verilog-ls (Google chipsalliance) — format-on-save / lint /
 *    hover. Expects user to install on PATH (brew install verible /
 *    apt install verible / oss-cad-suite extension). Off-by-default
 *    fallback notification if binary missing.
 *
 * 2. svlangserver (imc-trading) — completion / goto-def / rename for
 *    SystemVerilog. Bundled as npm dependency (svlangserver package),
 *    no external install needed.
 *
 * Both run via vscode-languageclient stdio transport. Both are stopped
 * cleanly in deactivate().
 *
 * Configuration:
 *   chipos.verilog.lsp.verible.enabled    (bool, default true)
 *   chipos.verilog.lsp.verible.path       (string, default '' = PATH)
 *   chipos.verilog.lsp.svlangserver.enabled (bool, default true)
 *
 * Architectural notes:
 *  - We don't use a shared LanguageServer process — each LSP runs
 *    independently. VS Code's framework deduplicates capabilities
 *    when both report e.g. hover; first responder wins. In practice
 *    verible owns format/lint/hover and svlangserver owns
 *    completion/goto-def, so collision is minimal.
 *  - documentSelector covers both verilog (.v/.vh) and systemverilog
 *    (.sv/.svh/.svi) language ids registered by the syntax-only
 *    extensions/verilog/ package.
 *  - Untrusted workspaces disable both servers (capabilities.untrusted
 *    in package.json) because external binary execution is implicit.
 */

const SECTION = 'chipos.verilog.lsp';
const VERIBLE_BINARY_NAME = 'verible-verilog-ls';

let veribleClient: LanguageClient | undefined;
let svClient: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;

const DOCUMENT_SELECTOR: DocumentSelector = [
	{ scheme: 'file', language: 'verilog' },
	{ scheme: 'file', language: 'systemverilog' },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('ChipOS Verilog LSP');
	context.subscriptions.push(outputChannel);

	await syncServersFromConfig(context);

	// Live-react to config changes — toggling enabled on/off doesn't
	// require IDE restart.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e.affectsConfiguration(SECTION)) {
				await syncServersFromConfig(context);
			}
		}),
	);
}

export async function deactivate(): Promise<void> {
	await Promise.all([
		veribleClient?.stop().catch((err) => log('verible stop failed:', err)),
		svClient?.stop().catch((err) => log('svlangserver stop failed:', err)),
	]);
	veribleClient = undefined;
	svClient = undefined;
}

async function syncServersFromConfig(context: vscode.ExtensionContext): Promise<void> {
	const cfg = vscode.workspace.getConfiguration(SECTION);
	const veribleEnabled = cfg.get<boolean>('verible.enabled') === true;
	const veriblePathOverride = (cfg.get<string>('verible.path') ?? '').trim();
	const svEnabled = cfg.get<boolean>('svlangserver.enabled') === true;

	// Verible — start or stop based on enabled flag.
	if (veribleEnabled && !veribleClient) {
		await startVeribleClient(context, veriblePathOverride);
	} else if (!veribleEnabled && veribleClient) {
		await veribleClient.stop().catch(() => { });
		veribleClient = undefined;
		log('verible: stopped (disabled via settings)');
	}

	// svlangserver — start or stop based on enabled flag.
	if (svEnabled && !svClient) {
		await startSvLangServerClient(context);
	} else if (!svEnabled && svClient) {
		await svClient.stop().catch(() => { });
		svClient = undefined;
		log('svlangserver: stopped (disabled via settings)');
	}
}

async function startVeribleClient(_context: vscode.ExtensionContext, pathOverride: string): Promise<void> {
	const binary = pathOverride || (await discoverOnPath(VERIBLE_BINARY_NAME));
	if (!binary) {
		log(`verible: binary '${VERIBLE_BINARY_NAME}' not found on PATH and chipos.verilog.lsp.verible.path is empty — running in syntax-only mode. Install with 'brew install verible' (macOS) or 'apt install verible' (Linux) to enable format/lint/hover.`);
		// One-time notification so user knows why their hover isn't working.
		const shown = _context.workspaceState.get<boolean>('chipos.verilog.veribleMissingNotified', false);
		if (!shown) {
			vscode.window.showInformationMessage(
				'ChipOS: verible-verilog-ls not found. Install it to enable Verilog format-on-save and lint. (See ChipOS Verilog LSP output for setup hints.)',
				'Open settings',
				'Dismiss',
			).then((choice) => {
				if (choice === 'Open settings') {
					vscode.commands.executeCommand('workbench.action.openSettings', 'chipos.verilog.lsp.verible');
				}
			});
			_context.workspaceState.update('chipos.verilog.veribleMissingNotified', true);
		}
		return;
	}

	const serverOptions: ServerOptions = {
		command: binary,
		args: [],
		transport: TransportKind.stdio,
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: DOCUMENT_SELECTOR,
		outputChannel,
		synchronize: {
			configurationSection: SECTION,
		},
	};

	veribleClient = new LanguageClient(
		'chipos-verible-verilog-ls',
		'Verible Verilog LSP',
		serverOptions,
		clientOptions,
	);
	try {
		await veribleClient.start();
		log(`verible: started (binary=${binary})`);
	} catch (err) {
		log('verible: start failed:', err);
		veribleClient = undefined;
	}
}

async function startSvLangServerClient(_context: vscode.ExtensionContext): Promise<void> {
	// PHASE 2 (deferred): svlangserver provides better completion +
	// goto-def + rename for SystemVerilog. Bundling it requires either:
	//   a) Custom esbuild step to bundle svlangserver's CLI entry +
	//      all its deps (chokidar, antlr4-c3, ...) into dist/svlangserver-
	//      bundle.js. ChipOS IDE built-in extensions don't ship
	//      node_modules in the .app, so we can't just `require()` it.
	//   b) Runtime download on first .sv open (network required).
	// Phase 1 ships verible-verilog-ls only — user gets format/lint/
	// hover; completion falls back to syntax-only word-based.
	log('svlangserver: Phase 2 feature, not yet shipped — see chipos-product-roadmap.md 2.5 Phase 2');
}

/**
 * Walk $PATH looking for an executable named `name`. Cross-platform
 * enough for macOS/Linux (Windows would need PATHEXT handling, but
 * verible-verilog-ls is currently not shipped for Windows by upstream).
 */
function discoverOnPath(name: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const paths = (process.env.PATH ?? '').split(path.delimiter);
		for (const p of paths) {
			if (!p) { continue; }
			const candidate = path.join(p, name);
			try {
				if (fs.existsSync(candidate)) {
					fs.accessSync(candidate, fs.constants.X_OK);
					return resolve(candidate);
				}
			} catch {
				// not executable — try next
			}
		}
		// As a safety net try `which` directly, which respects shell
		// aliases and additional PATH entries injected by login shells
		// that GUI-launched VS Code doesn't inherit.
		cp.exec(`command -v ${JSON.stringify(name)}`, (err, stdout) => {
			if (err || !stdout.trim()) { return resolve(undefined); }
			resolve(stdout.trim());
		});
	});
}

function log(...args: unknown[]): void {
	if (outputChannel) {
		outputChannel.appendLine(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	}
}
