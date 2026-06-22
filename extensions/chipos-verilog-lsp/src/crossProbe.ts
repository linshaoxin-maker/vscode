/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Glob + extension test for Verilog/SystemVerilog RTL sources. */
const RTL_GLOB = '**/*.{v,sv,svh,vh}';
const RTL_EXT_RE = /\.(?:v|sv|svh|vh)$/i;

/** Net/variable/port declaration keywords we anchor the text-search fallback on. */
const DECL_KEYWORDS = ['input', 'output', 'inout', 'reg', 'wire', 'logic', 'bit', 'integer', 'genvar', 'parameter', 'localparam'];

/** Shape of Vaporview's `onDidSelectSignal` event (per its API_DOCS). */
interface SelectSignalEvent {
	readonly uri?: unknown;
	/** Full instance path(s) of the selected signal(s), e.g. `['tb.dut.count']`. */
	readonly instancePath?: string[] | string;
	/** Where the selection happened — we only cross-probe `'viewer'` clicks. */
	readonly source?: string;
}

/**
 * Cross-probe (waveform → RTL): when a user selects a signal in the Vaporview
 * waveform viewer, jump the editor to that signal's declaration in the RTL.
 *
 * Resolution: the signal's leaf name (last `.`-segment of the instance path) is
 * looked up via the running LSP's workspace-symbol index (svlangserver), with a
 * workspace text-search fallback so it still works when no LSP is up. Best-effort
 * and fully guarded — a missing Vaporview / LSP / declaration just no-ops (at
 * most a transient status-bar note), never throws.
 */
export function registerCrossProbe(context: vscode.ExtensionContext, log: (...args: unknown[]) => void): void {
	// A first-class command so the jump is reachable from the palette / a keybinding
	// (and unit/CDP-verifiable) — not only via the waveform click below. Accepts an
	// instance path / leaf name; when invoked with no argument it prompts.
	context.subscriptions.push(
		vscode.commands.registerCommand('chipos.verilog.revealSignalInRtl', async (arg?: unknown) => {
			// `arg` is a string (programmatic), a Vaporview netlist tree item (the
			// right-click menu — has name/label/instancePath), or undefined (palette
			// → prompt).
			let path = signalFromArg(arg);
			if (!path) {
				path = (await vscode.window.showInputBox({
					title: 'Reveal Signal in RTL',
					prompt: 'Signal name or instance path (e.g. tb.dut.count)',
					value: currentWord(),
				})) ?? '';
			}
			await revealSignalInRtl(path, log);
		}),
	);
	void wireWaveformToRtl(context, log);
}

/**
 * Extract a signal name / instance path from a command argument — a plain string,
 * or a Vaporview netlist tree item (the right-click menu passes one; it carries
 * `name` / `instancePath` / a `label` that may be a string or `{ label }`).
 */
function signalFromArg(arg: unknown): string {
	if (typeof arg === 'string') {
		return arg;
	}
	if (!arg || typeof arg !== 'object') {
		return '';
	}
	const o = arg as { instancePath?: unknown; name?: unknown; label?: unknown };
	if (typeof o.instancePath === 'string') {
		return o.instancePath;
	}
	if (typeof o.name === 'string') {
		return o.name;
	}
	if (typeof o.label === 'string') {
		return o.label;
	}
	if (o.label && typeof o.label === 'object' && typeof (o.label as { label?: unknown }).label === 'string') {
		return (o.label as { label: string }).label;
	}
	return '';
}

/** The identifier under the cursor in the active editor (seed for the prompt). */
function currentWord(): string {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return '';
	}
	const range = editor.document.getWordRangeAtPosition(editor.selection.active);
	return range ? editor.document.getText(range) : '';
}

/**
 * Jump the editor to the RTL declaration of `signalPathOrName` (a leaf name or a
 * dotted instance path — only the leaf is resolved). Shared by the command and
 * the waveform-click handler. Best-effort; never throws.
 */
export async function revealSignalInRtl(signalPathOrName: string, log: (...args: unknown[]) => void): Promise<void> {
	try {
		const leaf = (signalPathOrName ?? '').split('.').pop()?.trim();
		if (!leaf) {
			return;
		}
		const loc = await resolveDeclaration(leaf);
		if (!loc) {
			vscode.window.setStatusBarMessage(`ChipOS: no RTL declaration found for '${leaf}'`, 3000);
			return;
		}
		const doc = await vscode.workspace.openTextDocument(loc.uri);
		const editor = await vscode.window.showTextDocument(doc, { preview: true, selection: loc.range });
		editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
	} catch (err) {
		log('cross-probe: reveal failed:', err);
	}
}

async function wireWaveformToRtl(context: vscode.ExtensionContext, log: (...args: unknown[]) => void): Promise<void> {
	const vaporview = vscode.extensions.getExtension('lramseyer.vaporview');
	if (!vaporview) {
		log('cross-probe: vaporview not installed — waveform→RTL disabled');
		return;
	}
	if (!vaporview.isActive) {
		try {
			await vaporview.activate();
		} catch (err) {
			log('cross-probe: vaporview activate failed:', err);
			return;
		}
	}
	const api = vaporview.exports as { onDidSelectSignal?: (cb: (e: SelectSignalEvent) => void) => vscode.Disposable } | undefined;
	if (typeof api?.onDidSelectSignal !== 'function') {
		log('cross-probe: vaporview onDidSelectSignal API unavailable — waveform→RTL disabled');
		return;
	}
	context.subscriptions.push(api.onDidSelectSignal((e) => { void onSignalSelected(e, log); }));
	log('cross-probe: wired onDidSelectSignal → RTL');
}

async function onSignalSelected(e: SelectSignalEvent, log: (...args: unknown[]) => void): Promise<void> {
	// Only a click inside the waveform itself is the deliberate "cross-probe this"
	// gesture; a netlist-tree selection (building the view) should not yank the editor.
	if (e?.source !== 'viewer') {
		return;
	}
	const path = Array.isArray(e.instancePath) ? e.instancePath[0] : e.instancePath;
	if (typeof path !== 'string' || path.length === 0) {
		return;
	}
	await revealSignalInRtl(path, log);
}

/** LSP workspace-symbol index first (precise), then a text-search fallback. */
async function resolveDeclaration(name: string): Promise<vscode.Location | undefined> {
	try {
		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name);
		const inRtl = (symbols ?? []).filter(s => s.name === name && RTL_EXT_RE.test(s.location.uri.path));
		const pick = inRtl[0] ?? (symbols ?? []).find(s => s.name === name);
		if (pick) {
			return pick.location;
		}
	} catch {
		// No LSP / no symbol provider — fall through to the text-search fallback.
	}
	return findDeclarationByText(name);
}

/**
 * Fallback when the LSP is down: scan workspace RTL files for a declaration line
 * (`reg/wire/logic/input… <name>`) and point at the first hit. Bounded file count
 * so a huge tree can't stall the click.
 */
async function findDeclarationByText(name: string): Promise<vscode.Location | undefined> {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const decl = new RegExp(`^\\s*(?:${DECL_KEYWORDS.join('|')})\\b[^;]*?\\b${escaped}\\b`);
	const files = await vscode.workspace.findFiles(RTL_GLOB, '**/node_modules/**', 300);
	for (const file of files) {
		let text: string;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
		} catch {
			continue;
		}
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			if (decl.test(lines[i])) {
				const col = Math.max(0, lines[i].indexOf(name));
				return new vscode.Location(file, new vscode.Range(i, col, i, col + name.length));
			}
		}
	}
	return undefined;
}
