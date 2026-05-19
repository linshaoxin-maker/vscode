/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

// Two bundles:
//   1. `main` — the extension itself (client-side, runs in extension host).
//      External: `vscode`, because the host injects it.
//   2. `svlangserver-server` — the bundled @imc-trading/svlangserver LSP server.
//      We bundle bin/main.js (and all its transitive deps:
//      vscode-languageserver, vscode-jsonrpc, glob, tmp, etc.) into
//      a single CJS file so the .app can ship it without node_modules.
//      Spawned by main.ts via `node <bundle>` when the user opens a
//      SystemVerilog file with chipos.verilog.lsp.svlangserver.enabled=true.
//      Note: bin/main.js auto-appends --stdio if no transport mode is given,
//      so we don't have to pass it from the client side.
run({
	platform: 'node',
	entryPoints: {
		'main': path.join(srcDir, 'main.ts'),
		'svlangserver-server': path.join(
			import.meta.dirname,
			'node_modules',
			'@imc-trading',
			'svlangserver',
			'bin',
			'main.js',
		),
	},
	srcDir,
	outdir: outDir,
	external: ['vscode'],
}, process.argv);
