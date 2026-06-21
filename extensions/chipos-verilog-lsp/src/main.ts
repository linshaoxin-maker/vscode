/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { DocumentSelector, LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { registerCrossProbe } from './crossProbe';

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

	// Cross-probe: click a signal in the Vaporview waveform → jump to its RTL
	// declaration (resolved via the LSP symbol index, with a text-search
	// fallback). Best-effort; no-ops if Vaporview isn't installed.
	registerCrossProbe(context, log);
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
	log(`verible: lookup start (override=${pathOverride || '(empty)'}, managed dirs=${chiposManagedBinDirs().join(',')})`);
	const binary = pathOverride || (await discoverOnPath(VERIBLE_BINARY_NAME));
	log(`verible: lookup result = ${binary ?? '(none)'}`);
	if (!binary) {
		log(`verible: binary '${VERIBLE_BINARY_NAME}' not found on PATH (and not in ~/.coderust/eda/verible/bin) and chipos.verilog.lsp.verible.path is empty — running in syntax-only mode. Install with 'brew install verible' (macOS) or 'apt install verible' (Linux), or let the ChipOS worker auto-fetch it (~/.coderust/eda/verible/), to enable format/lint/hover.`);
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

	// IMPORTANT: do NOT set `transport: TransportKind.stdio` — vscode-languageclient
	// would then auto-append `--stdio` to args, but verible-verilog-ls doesn't
	// recognise that flag and exits with code 1 ("ERROR: Unknown command line
	// flag 'stdio'"). When `transport` is undefined the framework just talks to
	// the child process's stdin/stdout directly, which is exactly what verible
	// expects (and how `vscode-languageclient` v9 documents `Executable` for
	// servers that don't take a transport-mode flag).
	const serverOptions: ServerOptions = {
		command: binary,
		args: [],
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

async function startSvLangServerClient(context: vscode.ExtensionContext): Promise<void> {
	// PHASE 2 (shipped 2026-05-19): svlangserver is bundled via esbuild
	// into dist/svlangserver-server.js (see esbuild.mts). We spawn it with
	// `node <bundle>` and let the bundled bin/main.js auto-append --stdio.
	//
	// What it gives us over verible:
	//   - Hover (signal width, port direction, module signature)
	//   - Completion (identifier, port name, signal name)
	//   - Goto-def with cross-file index (vs verible's lexical-only)
	//   - Rename refactor with all-files awareness
	// What it does NOT give us:
	//   - Verilog (pure .v) — svlangserver is SV-focused; verible covers .v
	//   - Formatting — verible owns format
	// So in practice both servers run side-by-side: verible for format/lint,
	// svlangserver for hover/completion/goto-def. VS Code's LSP framework
	// de-dupes overlapping capabilities (first responder wins).
	const bundlePath = path.join(context.extensionPath, 'dist', 'svlangserver-server.js');
	if (!fs.existsSync(bundlePath)) {
		log(`svlangserver: bundle not found at ${bundlePath} — build artefact missing. The extension ships dist/svlangserver-server.js by default; if you're hacking on the extension source, run \`npx tsx esbuild.mts\` in extensions/chipos-verilog-lsp/.`);
		return;
	}

	// `process.execPath` is the Electron binary in extension host context.
	// We can't use it as a Node interpreter (Electron rejects unrelated JS).
	// Instead use the user's `node` from PATH or whatever process.versions.node
	// is bound to via `process.argv0` when ELECTRON_RUN_AS_NODE is set.
	// Simplest: rely on system `node`. If absent we tell the user.
	const nodeBin = await discoverOnPath('node');
	if (!nodeBin) {
		log('svlangserver: system `node` not found on PATH — cannot spawn bundled server. Install Node.js (https://nodejs.org) or set chipos.verilog.lsp.svlangserver.enabled=false to silence.');
		return;
	}

	const serverOptions: ServerOptions = {
		command: nodeBin,
		args: [bundlePath],
		// No `transport` field — see verible client above for why.
		// bin/main.js auto-pushes --stdio when no --node-ipc/--socket/--stdio
		// is provided, which is exactly what the LSP framework expects.
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: DOCUMENT_SELECTOR,
		outputChannel,
		synchronize: {
			configurationSection: SECTION,
		},
	};

	svClient = new LanguageClient(
		'chipos-svlangserver',
		'svlangserver',
		serverOptions,
		clientOptions,
	);
	try {
		await svClient.start();
		log(`svlangserver: started (node=${nodeBin}, bundle=${bundlePath})`);
	} catch (err) {
		log('svlangserver: start failed:', err);
		svClient = undefined;
	}
}

/**
 * Standard install locations the worker (VeriblePackManager + EdaPackManager)
 * uses for auto-fetched EDA binaries. We check these BEFORE walking $PATH so
 * the LSP extension and the worker agree on which verible binary to use,
 * even when GUI-launched VS Code doesn't inherit the user's shell PATH.
 *
 * Order matters:
 *  1. verible/bin — VeriblePackManager install path (Phase 1.5 standard)
 *  2. oss-cad-suite/bin — EdaPackManager install path (verible isn't in it
 *     today but reserved if upstream adds it)
 */
function chiposManagedBinDirs(): string[] {
	const home = os.homedir();
	return [
		path.join(home, '.coderust', 'eda', 'verible', 'bin'),
		path.join(home, '.coderust', 'eda', 'oss-cad-suite', 'bin'),
	];
}

/**
 * Walk $PATH looking for an executable named `name`. Cross-platform
 * enough for macOS/Linux (Windows would need PATHEXT handling, but
 * verible-verilog-ls is currently not shipped for Windows by upstream).
 *
 * Also checks ChipOS-managed install directories (~/.coderust/eda/...)
 * first — those are populated by the worker's auto-fetch step and won't
 * be in the IDE process's PATH when launched from Finder/Dock.
 */
function discoverOnPath(name: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		// 1. ChipOS-managed install dirs (covers Phase 1.5 auto-fetch).
		for (const p of chiposManagedBinDirs()) {
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
		// 2. $PATH walk.
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
		// 3. As a safety net try `which` directly, which respects shell
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
