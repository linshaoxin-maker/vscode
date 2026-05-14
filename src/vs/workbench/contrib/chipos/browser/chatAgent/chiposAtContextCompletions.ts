/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isPatternInWord } from '../../../../../base/common/filters.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionList } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { isDiffEditorInput } from '../../../../common/editor.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { computeCompletionRanges } from '../../../chat/browser/widget/input/editor/chatInputCompletions.js';
import { ChatAgentLocation, isSupportedChatFileScheme } from '../../../chat/common/constants.js';
import { chatAgentLeader } from '../../../chat/common/requestParser/chatParserTypes.js';
import { searchFilesAndFolders } from '../../../search/browser/searchChatContext.js';

/**
 * ChipOS @-context completions. Adds Cursor-style file picker popup when the user
 * types `@` in the chat input.
 *
 * Why this exists: stock VS Code treats `@` as the agent picker prefix. In chipos
 * we only register one chat agent (the default `chipos.chat`), so the framework's
 * `AgentCompletions` provider returns nothing for `@`. We register a separate
 * Monaco completion provider on the same trigger character to surface recent /
 * workspace files instead. Selected files flow into `widget.attachmentModel` via
 * the `IChatRequestFileEntry` `kind: 'file'` path, which the chipos chat agent
 * already extracts in `_extractMentions()`.
 */
export class ChipOSAtContextCompletions extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chiposAtContextCompletions';

	private static readonly addFileReferenceCommand = 'chipos.addAtFileReference';
	private static readonly atWordPattern = new RegExp(`${chatAgentLeader}[^\\s]*`, 'g');

	private cacheKey?: { key: string; time: number };

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IHistoryService private readonly historyService: IHistoryService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@ILabelService private readonly labelService: ILabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this._register(languageFeaturesService.completionProvider.register({ scheme: Schemas.vscodeChatInput, hasAccessToAllModels: true }, {
			_debugDisplayName: 'chiposAtContextCompletions',
			triggerCharacters: [chatAgentLeader],
			provideCompletionItems: (model: ITextModel, position: Position, _context: CompletionContext, token: CancellationToken) => this.provide(model, position, token),
		}));

		this._register(CommandsRegistry.registerCommand(ChipOSAtContextCompletions.addFileReferenceCommand, (_services, widget: IChatWidget, resourceStr: string) => {
			if (!widget || typeof resourceStr !== 'string') {
				return;
			}
			widget.attachmentModel.addFile(URI.parse(resourceStr));
		}));
	}

	private async provide(model: ITextModel, position: Position, token: CancellationToken): Promise<CompletionList | undefined> {
		const widget = this.chatWidgetService.getWidgetByInputUri(model.uri);
		if (!widget || !widget.supportsFileReferences) {
			return;
		}

		if (widget.location !== ChatAgentLocation.Chat) {
			return;
		}

		const range = computeCompletionRanges(model, position, ChipOSAtContextCompletions.atWordPattern, true);
		if (!range) {
			return;
		}

		const result: CompletionList = { suggestions: [], incomplete: true };
		const seen = new ResourceSet();

		const makeCompletionItem = (resource: URI, kind: FileKind, description?: string, boostPriority?: boolean): CompletionItem => {
			const basename = this.labelService.getUriBasenameLabel(resource);
			const text = `${chatAgentLeader}${basename}`;
			const uriLabel = this.labelService.getUriLabel(resource, { relative: true });
			const labelDescription = description ? localize('chiposAtEntryDescription', '{0} ({1})', uriLabel, description) : uriLabel;
			const sortText = boostPriority ? ' ' : '!';
			return {
				label: { label: basename, description: labelDescription },
				filterText: `${chatAgentLeader}${basename}`,
				insertText: range.varWord?.endColumn === range.replace.endColumn ? `${text} ` : text,
				range,
				kind: kind === FileKind.FILE ? CompletionItemKind.File : CompletionItemKind.Folder,
				sortText,
				command: {
					id: ChipOSAtContextCompletions.addFileReferenceCommand,
					title: '',
					arguments: [widget, resource.toString()],
				},
			};
		};

		let pattern: string | undefined;
		if (range.varWord?.word && range.varWord.word.startsWith(chatAgentLeader)) {
			pattern = range.varWord.word.toLowerCase().slice(1);
		}

		// Recent files from history (top 5)
		let recentAdded = 0;
		for (const [i, item] of this.historyService.getHistory().entries()) {
			const resource = isDiffEditorInput(item) ? item.modified.resource : item.resource;
			if (!resource || seen.has(resource)) {
				continue;
			}
			if (!this.instantiationService.invokeFunction(accessor => isSupportedChatFileScheme(accessor, resource.scheme))) {
				continue;
			}
			if (pattern) {
				const basename = this.labelService.getUriBasenameLabel(resource).toLowerCase();
				if (!isPatternInWord(pattern, 0, pattern.length, basename, 0, basename.length)) {
					continue;
				}
			}
			seen.add(resource);
			result.suggestions.push(makeCompletionItem(resource, FileKind.FILE, i === 0 ? localize('chiposAtActiveFile', 'Active file') : undefined, i === 0));
			recentAdded++;
			if (recentAdded >= 5) {
				break;
			}
		}

		// Workspace search when a pattern is present
		if (pattern) {
			const cacheKey = this.updateCacheKey();
			const workspaces = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
			for (const workspace of workspaces) {
				if (token.isCancellationRequested) {
					break;
				}
				const { folders, files } = await searchFilesAndFolders(workspace, pattern, true, token, cacheKey.key, this.configurationService, this.searchService);
				for (const file of files) {
					if (!seen.has(file)) {
						seen.add(file);
						result.suggestions.push(makeCompletionItem(file, FileKind.FILE));
					}
				}
				for (const folder of folders) {
					if (!seen.has(folder)) {
						seen.add(folder);
						result.suggestions.push(makeCompletionItem(folder, FileKind.FOLDER));
					}
				}
			}
		}

		return result;
	}

	private updateCacheKey() {
		if (this.cacheKey && Date.now() - this.cacheKey.time > 60_000) {
			this.searchService.clearCache(this.cacheKey.key);
			this.cacheKey = undefined;
		}
		if (!this.cacheKey) {
			this.cacheKey = { key: generateUuid(), time: Date.now() };
		}
		this.cacheKey.time = Date.now();
		return this.cacheKey;
	}
}

registerWorkbenchContribution2(ChipOSAtContextCompletions.ID, ChipOSAtContextCompletions, WorkbenchPhase.AfterRestored);
