/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

export const enum ContextSourceType {
	ActiveFile = 'active_file',
	Selection = 'selection',
	GitDiff = 'git_diff',
	GitLog = 'git_log',
	Terminal = 'terminal',
	Linter = 'linter',
	ProjectStructure = 'project_structure',
	RecentEdit = 'recent_edit',
}

export interface IContextItem {
	readonly source: ContextSourceType;
	readonly content: string;
	readonly priority: number;
	readonly tokenEstimate: number;
	readonly metadata?: Record<string, unknown>;
}

export interface IContextProvider {
	readonly source: ContextSourceType;
	collect(): Promise<IContextItem[]>;
}

export interface IContextCollectionResult {
	readonly items: IContextItem[];
	readonly totalTokens: number;
	readonly trimmedSources: ContextSourceType[];
}
