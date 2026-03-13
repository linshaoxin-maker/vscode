/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { ContextSourceType, IContextItem, IContextProvider } from '../../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';

const MAX_LINES = 50;

export class TerminalProvider implements IContextProvider {

	readonly source = ContextSourceType.Terminal;

	constructor(
		private readonly _terminalService: ITerminalService,
	) {}

	async collect(): Promise<IContextItem[]> {
		try {
			const instance = this._terminalService.activeInstance;
			if (!instance) {
				return [];
			}

			const xterm = instance.xterm;
			if (!xterm) {
				return [];
			}

			const buffer = xterm.raw.buffer.active;
			const lineCount = buffer.length;
			const startLine = Math.max(0, lineCount - MAX_LINES);
			const lines: string[] = [];

			for (let i = startLine; i < lineCount; i++) {
				const line = buffer.getLine(i);
				if (line) {
					lines.push(line.translateToString(true));
				}
			}

			const text = lines.join('\n').trim();
			if (!text) {
				return [];
			}

			const content = `Terminal output (last ${MAX_LINES} lines):\n${text}`;
			return [{
				source: ContextSourceType.Terminal,
				content,
				priority: 6,
				tokenEstimate: Math.ceil(content.length / 4),
			}];
		} catch {
			return [];
		}
	}
}
