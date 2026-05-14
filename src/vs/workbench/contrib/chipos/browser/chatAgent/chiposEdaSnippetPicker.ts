/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { getChipOSEdaSnippets } from './chiposInlineCompletions.js';

/**
 * Command: `chipos.insertEdaSnippet`
 *
 * Surfaces the EDA snippet library (chiposInlineCompletions.ts) as a
 * quickPick so users don't need to remember magic-comment triggers like
 * `// gen axi-lite`. Picking a snippet inserts its body at the current
 * cursor position in the active editor.
 *
 * Registered on:
 *   - MenuId.EditorContext (right-click, group `chipos`, after the AI
 *     prompt items so it sits at the bottom of the chipos group)
 *   - MenuId.CommandPalette (so `cmd+shift+p > ChipOS: Insert EDA
 *     Snippet` finds it)
 */
export const INSERT_EDA_SNIPPET_COMMAND_ID = 'chipos.insertEdaSnippet';

CommandsRegistry.registerCommand(INSERT_EDA_SNIPPET_COMMAND_ID, async accessor => {
	const quickInputService = accessor.get(IQuickInputService);
	const codeEditorService = accessor.get(ICodeEditorService);

	const editor = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const langId = model.getLanguageId();

	const snippets = getChipOSEdaSnippets().filter(s => !s.languages || s.languages.has(langId));
	if (snippets.length === 0) {
		// No snippets for the current language. Open the full list anyway
		// so the user understands what's available — they can switch the
		// editor's language and try again.
		const all = getChipOSEdaSnippets();
		const picked = await quickInputService.pick(
			all.map(s => ({ label: s.label, detail: s.languages ? `[${[...s.languages].join(', ')}]` : 'any language' })),
			{ placeHolder: `No EDA snippets registered for "${langId}" — full library:`, canPickMany: false }
		);
		if (!picked) {
			return;
		}
		const match = all.find(s => s.label === picked.label);
		if (match) {
			insertSnippetAtCursor(editor, match.body);
		}
		return;
	}

	const picked = await quickInputService.pick(
		snippets.map(s => ({ label: s.label })),
		{ placeHolder: 'Insert ChipOS EDA snippet…', canPickMany: false }
	);
	if (!picked) {
		return;
	}
	const match = snippets.find(s => s.label === picked.label);
	if (match) {
		insertSnippetAtCursor(editor, match.body);
	}
});

function insertSnippetAtCursor(editor: ReturnType<ICodeEditorService['getFocusedCodeEditor']>, body: string): void {
	if (!editor) {
		return;
	}
	const sel = editor.getSelection();
	if (!sel) {
		return;
	}
	const insertRange = new Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
	// Snippet bodies in chiposInlineCompletions start with a leading '\n'
	// so they sit on their own line; trim that when inserting at an
	// arbitrary cursor position so we don't always introduce a blank.
	const text = body.startsWith('\n') ? body.slice(1) : body;
	editor.executeEdits(
		'chipos.insertEdaSnippet',
		[{ range: insertRange, text, forceMoveMarkers: true }],
	);
	editor.focus();
}
