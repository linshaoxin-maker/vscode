/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatService } from '../common/chatService/chatService.js';
import { LocalChatSessionUri } from '../common/model/chatUri.js';

/**
 * Cleans up orphaned temp files under `.coderust/tmp/{sessionId}/` at startup.
 *
 * Temp files are created by ChatConfirmationContentPart when users click
 * confirmation cards. Normally they are cleaned up when the session is deleted,
 * but if the IDE crashes or exits abnormally, orphaned directories may remain.
 *
 * This contribution scans `.coderust/tmp/` on startup and removes any
 * subdirectory whose name does not match an existing session ID.
 */
export class ChatTempFileCleanupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatTempFileCleanup';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		console.log('[ChatTempFile] Startup cleanup contribution initialized');
		this._cleanupOrphanedTempDirs();
	}

	private async _cleanupOrphanedTempDirs(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			console.log('[ChatTempFile] Startup cleanup: no workspace folders, skipping');
			return;
		}

		const tmpRoot = URI.joinPath(folders[0].uri, '.coderust', 'tmp');

		try {
			const stat = await this.fileService.resolve(tmpRoot);
			if (!stat.children || stat.children.length === 0) {
				console.log('[ChatTempFile] Startup cleanup: tmp dir is empty, nothing to do');
				return;
			}

			// Collect all known session IDs (live + history)
			const knownSessionIds = new Set<string>();

			const liveItems = await this.chatService.getLiveSessionItems();
			for (const item of liveItems) {
				const id = LocalChatSessionUri.parseLocalSessionId(item.sessionResource);
				if (id) {
					knownSessionIds.add(id);
				}
			}

			const historyItems = await this.chatService.getHistorySessionItems();
			for (const item of historyItems) {
				const id = LocalChatSessionUri.parseLocalSessionId(item.sessionResource);
				if (id) {
					knownSessionIds.add(id);
				}
			}

			console.log('[ChatTempFile] Startup cleanup: found', stat.children.length, 'entries in tmp dir,', knownSessionIds.size, 'known sessions');

			// Delete subdirectories that don't match any known session
			for (const child of stat.children) {
				if (!child.isDirectory) {
					// Legacy flat temp files (no sessionId) — clean them up too
					console.log('[ChatTempFile] Startup cleanup: removing legacy flat file:', child.name);
					this.fileService.del(child.resource).catch(() => { });
					continue;
				}

				if (!knownSessionIds.has(child.name)) {
					console.log('[ChatTempFile] Startup cleanup: removing orphaned dir:', child.name);
					this.logService.info(`[ChatTempFileCleanup] Removing orphaned temp dir: ${child.name}`);
					this.fileService.del(child.resource, { recursive: true }).catch(() => { });
				} else {
					console.log('[ChatTempFile] Startup cleanup: keeping dir (session exists):', child.name);
				}
			}
		} catch {
			console.log('[ChatTempFile] Startup cleanup: tmp dir does not exist yet, nothing to clean');
			// tmp dir doesn't exist yet — nothing to clean
		}
	}
}
