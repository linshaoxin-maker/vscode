/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IMentionItem, IContextFile } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const MAX_CONTENT_SIZE = 100 * 1024;
const TRUNCATED_SIZE = 50 * 1024;

export class MentionResolver {

	constructor(
		private readonly _fileService: IFileService,
	) {}

	async resolve(items: IMentionItem[]): Promise<IContextFile[]> {
		const results: IContextFile[] = [];

		for (const item of items) {
			switch (item.type) {
				case 'file':
					results.push(await this._resolveFile(item));
					break;
				case 'folder':
					results.push(await this._resolveFolder(item));
					break;
				case 'snippet':
					results.push({
						path: item.path,
						type: 'snippet',
						content: item.content ?? null,
					});
					break;
			}
		}

		return results;
	}

	private async _resolveFile(item: IMentionItem): Promise<IContextFile> {
		try {
			const uri = URI.file(item.path);
			const result = await this._fileService.readFile(uri);
			let content = result.value.toString();

			if (content.length > MAX_CONTENT_SIZE) {
				content = content.slice(0, TRUNCATED_SIZE) + '\n\n... [truncated]';
			}

			return { path: item.path, type: 'file', content };
		} catch {
			return { path: item.path, type: 'file', content: null };
		}
	}

	private async _resolveFolder(item: IMentionItem): Promise<IContextFile> {
		try {
			const uri = URI.file(item.path);
			const stat = await this._fileService.resolve(uri);
			const names = (stat.children ?? []).map(c => c.name);
			const content = names.join('\n');
			return { path: item.path, type: 'folder', content };
		} catch {
			return { path: item.path, type: 'folder', content: null };
		}
	}
}
