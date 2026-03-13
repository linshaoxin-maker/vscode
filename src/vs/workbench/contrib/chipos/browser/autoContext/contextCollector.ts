/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISCMService } from '../../../../../workbench/contrib/scm/common/scm.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import type { IMentionItem } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { IContextProvider, IContextCollectionResult, IContextItem } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextTypes.js';
import { ContextPrioritizer } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextPrioritizer.js';
import { ActiveFileProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/activeFileProvider.js';
import { SelectionProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/selectionProvider.js';
import { GitDiffProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/gitDiffProvider.js';
import { GitLogProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/gitLogProvider.js';
import { TerminalProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/terminalProvider.js';
import { LinterProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/linterProvider.js';
import { ProjectStructureProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/projectStructureProvider.js';
import { RecentEditProvider } from '../../../../../workbench/contrib/chipos/browser/autoContext/contextProviders/recentEditProvider.js';

const DEFAULT_TOKEN_BUDGET = 8000;

export class ContextCollector extends Disposable {

	private readonly _providers: IContextProvider[] = [];
	private readonly _prioritizer = new ContextPrioritizer();

	constructor(
		@IInstantiationService _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IEditorService editorService: IEditorService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContext: IWorkspaceContextService,
		@ISCMService scmService: ISCMService,
		@ITerminalService terminalService: ITerminalService,
		@IMarkerService markerService: IMarkerService,
	) {
		super();

		const recentEditProvider = new RecentEditProvider(editorService);
		this._register(recentEditProvider);

		this._providers = [
			new ActiveFileProvider(editorService),
			new SelectionProvider(editorService),
			new GitDiffProvider(scmService),
			new GitLogProvider(workspaceContext),
			new TerminalProvider(terminalService),
			new LinterProvider(markerService, editorService),
			new ProjectStructureProvider(fileService, workspaceContext),
			recentEditProvider,
		];
	}

	registerProvider(provider: IContextProvider): void {
		this._providers.push(provider);
	}

	async collect(mentionItems?: IMentionItem[], tokenBudget?: number): Promise<IContextCollectionResult> {
		const results = await Promise.allSettled(
			this._providers.map(p => p.collect())
		);

		const items: IContextItem[] = [];

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.status === 'fulfilled') {
				items.push(...result.value);
			} else {
				this._logService.warn(
					`[ContextCollector] Provider "${this._providers[i].source}" failed:`,
					result.reason,
				);
			}
		}

		return this._prioritizer.prioritize(
			items,
			mentionItems ?? [],
			tokenBudget ?? DEFAULT_TOKEN_BUDGET,
		);
	}
}
