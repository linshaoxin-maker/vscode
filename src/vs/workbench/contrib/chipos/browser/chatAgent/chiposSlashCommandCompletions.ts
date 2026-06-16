/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isPatternInWord } from '../../../../../base/common/filters.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionList } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { computeCompletionRanges } from '../../../chat/browser/widget/input/editor/chatInputCompletions.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { chatSubcommandLeader } from '../../../chat/common/requestParser/chatParserTypes.js';
import { ChiposCommandsService } from '../resources/chiposCommandsService.js';
import { ChiposPluginsService } from '../resources/chiposPluginsService.js';
import { RESERVED_COMMANDS, RESERVED_NAMES } from './statelessInvoke/types.js';

/**
 * ChipOS `/`-command completions. Adds a Cursor-style command picker popup when
 * the user types `/` at the start of the chat input.
 *
 * Why this exists: chipos commands live as files under `.chipos/commands/` (and
 * are contributed by installed plugins), not as registered chat slash commands,
 * so the framework's slash-command completion providers surface nothing for
 * them. We register a separate Monaco completion provider on the same trigger
 * character to list the available command names. Selecting one inserts
 * `/<name> ` into the input; the chipos chat agent already resolves the leading
 * `/<name>` token against {@link ChiposCommandsService} when the request is sent.
 *
 * Mirrors {@link ChipOSAtContextCompletions} (the `@`-file provider) — same
 * Monaco plumbing, just scoped to the slash leader and the command catalog.
 */
export class ChipOSSlashCommandCompletions extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chiposSlashCommandCompletions';

	private static readonly slashWordPattern = new RegExp(`${chatSubcommandLeader}[\\w-]*`, 'g');

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this._register(languageFeaturesService.completionProvider.register({ scheme: Schemas.vscodeChatInput, hasAccessToAllModels: true }, {
			_debugDisplayName: 'chiposSlashCommandCompletions',
			triggerCharacters: [chatSubcommandLeader],
			provideCompletionItems: (model: ITextModel, position: Position, _context: CompletionContext, token: CancellationToken) => this.provide(model, position, token),
		}));
	}

	private async provide(model: ITextModel, position: Position, token: CancellationToken): Promise<CompletionList | undefined> {
		const widget = this.chatWidgetService.getWidgetByInputUri(model.uri);
		if (!widget) {
			return;
		}

		if (widget.location !== ChatAgentLocation.Chat) {
			return;
		}

		const range = computeCompletionRanges(model, position, ChipOSSlashCommandCompletions.slashWordPattern, true);
		if (!range) {
			return;
		}

		// Slash commands are start-of-prompt only: bail unless everything before the
		// slash token (from the very beginning of the input) is empty or whitespace.
		const beforeRange = new Range(1, 1, range.replace.startLineNumber, range.replace.startColumn);
		if (!/^\s*$/.test(model.getValueInRange(beforeRange))) {
			return;
		}

		let pattern: string | undefined;
		if (range.varWord?.word && range.varWord.word.startsWith(chatSubcommandLeader)) {
			pattern = range.varWord.word.toLowerCase().slice(1);
		}

		const svc = this.instantiationService.createInstance(ChiposCommandsService);
		const plugins = this.instantiationService.createInstance(ChiposPluginsService);
		const cmds = [...await svc.getCommands(), ...await plugins.getPluginCommands()];
		if (token.isCancellationRequested) {
			return;
		}

		const suggestions: CompletionItem[] = [];
		let order = 0;

		// Reserved built-in commands sort above user/plugin commands and cannot be
		// shadowed by a same-named file command (reserved-wins). Only the primary
		// name is surfaced; aliases still resolve when typed, just aren't listed.
		for (const reserved of RESERVED_COMMANDS) {
			if (pattern && !isPatternInWord(pattern, 0, pattern.length, reserved.name, 0, reserved.name.length)) {
				continue;
			}
			const text = `${chatSubcommandLeader}${reserved.name}`;
			suggestions.push({
				label: { label: text, description: 'built-in' },
				filterText: text,
				insertText: reserved.takesArgs ? `${text} ` : text,
				range,
				kind: CompletionItemKind.Text,
				sortText: String(order++).padStart(4, '0'),
			});
		}

		for (const command of cmds) {
			if (RESERVED_NAMES.has(command.name.toLowerCase())) {
				continue; // reserved-wins: a user/plugin command cannot shadow a reserved name
			}
			if (pattern) {
				const name = command.name.toLowerCase();
				if (!isPatternInWord(pattern, 0, pattern.length, name, 0, name.length)) {
					continue;
				}
			}
			const text = `${chatSubcommandLeader}${command.name}`;
			suggestions.push({
				label: { label: text, description: command.description ?? command.argumentHint ?? '' },
				filterText: text,
				insertText: `${text} `,
				range,
				kind: CompletionItemKind.Text,
				sortText: String(order++).padStart(4, '0'),
			});
		}

		return { suggestions, incomplete: false };
	}
}

registerWorkbenchContribution2(ChipOSSlashCommandCompletions.ID, ChipOSSlashCommandCompletions, WorkbenchPhase.AfterRestored);
