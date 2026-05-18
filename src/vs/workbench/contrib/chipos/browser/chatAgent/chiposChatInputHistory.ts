/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Context as SuggestContext } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';

/**
 * ChipOS Chat Input History — bind ↑/↓ in the chat input to recall
 * previously-sent prompts, matching what users expect from terminals,
 * REPLs, and Cursor's chat composer.
 *
 * The plumbing already exists in upstream VS Code:
 *   - `ChatInputPart.showPreviousValue()` / `showNextValue()` walk the
 *     `ChatHistoryNavigator` (saved + persisted prompts).
 *   - `ChatContextKeys.inChatInput` tracks focus.
 *   - `ChatContextKeys.inputCursorAtTop` tracks cursor on line 1.
 *
 * Upstream just never wired ↑/↓ to these methods (Copilot Chat exposes
 * Cmd+Alt+↑ via NextUserPromptAction but that *scrolls the message
 * list*, it doesn't load into the input). We wire the missing key.
 *
 * Trade-off on the gate: we use `inputCursorAtTop` for both ↑ and ↓.
 *   - ↑ at line 1 of a multi-line draft → navigate back through history
 *     (matches REPL semantics from `interactive.contribution.ts:619`).
 *   - ↓ at line 1 of a multi-line draft → navigate forward / restore
 *     draft. Caveat: this means ↓ on line 1 won't move the cursor down
 *     within the draft. Users can click line 2 or End/Down repeatedly
 *     until cursor leaves line 1. Symmetric `inputCursorAtBottom` does
 *     not exist upstream; adding it is a follow-up (TODO X.1.1b).
 *   - SuggestContext.Visible suppression keeps autocomplete arrow keys
 *     working.
 */
const HISTORY_NAV_WHEN = ContextKeyExpr.and(
	ChatContextKeys.inChatInput,
	ChatContextKeys.inputCursorAtTop,
	SuggestContext.Visible.toNegated(),
);

class ChipOSChatHistoryPreviousAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.chat.history.previous',
			title: localize2('chipos.chat.history.previous', 'Show Previous Chat Prompt'),
			category: { value: 'ChipOS', original: 'ChipOS' },
			f1: true,
			keybinding: {
				primary: KeyCode.UpArrow,
				when: HISTORY_NAV_WHEN,
				// Above WorkbenchContrib so we beat any generic UpArrow handler
				// the chat input editor or its contribs may register.
				weight: KeybindingWeight.WorkbenchContrib + 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget) {
			await widget.input.showPreviousValue();
		}
	}
}

class ChipOSChatHistoryNextAction extends Action2 {
	constructor() {
		super({
			id: 'chipos.chat.history.next',
			title: localize2('chipos.chat.history.next', 'Show Next Chat Prompt'),
			category: { value: 'ChipOS', original: 'ChipOS' },
			f1: true,
			keybinding: {
				primary: KeyCode.DownArrow,
				when: HISTORY_NAV_WHEN,
				weight: KeybindingWeight.WorkbenchContrib + 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget) {
			// `showNextValue()` no-ops via `history.isAtEnd()` when not
			// currently browsing history, so this is safe to bind
			// unconditionally for ↓-at-top — it won't clobber a draft.
			await widget.input.showNextValue();
		}
	}
}

registerAction2(ChipOSChatHistoryPreviousAction);
registerAction2(ChipOSChatHistoryNextAction);
