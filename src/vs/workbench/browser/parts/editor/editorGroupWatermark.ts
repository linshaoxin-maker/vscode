/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, h } from '../../../../base/browser/dom.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWeb } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';

interface WatermarkEntry {
	readonly id: string;
	readonly text: string;
	readonly when?: {
		native?: ContextKeyExpression;
		web?: ContextKeyExpression;
	};
}

const showChatContextKey = ContextKeyExpr.and(ContextKeyExpr.equals('chatSetupHidden', false), ContextKeyExpr.equals('chatSetupDisabled', false));

const openChat: WatermarkEntry = { text: localize('watermark.openChat', "Open Chat"), id: 'workbench.action.chat.open', when: { native: showChatContextKey, web: showChatContextKey } };
const showCommands: WatermarkEntry = { text: localize('watermark.showCommands', "Show All Commands"), id: 'workbench.action.showCommands' };
const gotoFile: WatermarkEntry = { text: localize('watermark.quickAccess', "Go to File"), id: 'workbench.action.quickOpen' };
const openFile: WatermarkEntry = { text: localize('watermark.openFile', "Open File"), id: 'workbench.action.files.openFile' };
const openFolder: WatermarkEntry = { text: localize('watermark.openFolder', "Open Folder"), id: 'workbench.action.files.openFolder' };
const openFileOrFolder: WatermarkEntry = { text: localize('watermark.openFileFolder', "Open File or Folder"), id: 'workbench.action.files.openFileFolder' };
const openRecent: WatermarkEntry = { text: localize('watermark.openRecent', "Open Recent"), id: 'workbench.action.openRecent' };
const newUntitledFile: WatermarkEntry = { text: localize('watermark.newUntitledFile', "New Untitled Text File"), id: 'workbench.action.files.newUntitledFile' };
const findInFiles: WatermarkEntry = { text: localize('watermark.findInFiles', "Find in Files"), id: 'workbench.action.findInFiles' };
const toggleTerminal: WatermarkEntry = { text: localize({ key: 'watermark.toggleTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal"), id: 'workbench.action.terminal.toggleTerminal', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
const startDebugging: WatermarkEntry = { text: localize('watermark.startDebugging', "Start Debugging"), id: 'workbench.action.debug.start', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
const openSettings: WatermarkEntry = { text: localize('watermark.openSettings', "Open Settings"), id: 'workbench.action.openSettings' };

const baseEntries: WatermarkEntry[] = [
	openChat,
	showCommands,
];

const emptyWindowEntries: WatermarkEntry[] = coalesce([
	...baseEntries,
	openRecent,
	...(isMacintosh && !isWeb ? [openFileOrFolder] : [openFile, openFolder]),
	isMacintosh && !isWeb ? newUntitledFile : undefined, // fill in one more on macOS to get to 5 entries
]);

const workspaceEntries: WatermarkEntry[] = [
	...baseEntries,
];

const otherEntries: WatermarkEntry[] = [
	gotoFile,
	findInFiles,
	startDebugging,
	toggleTerminal,
	openSettings,
];

export class EditorGroupWatermark extends Disposable {

	private static readonly CACHED_WHEN = 'editorGroupWatermark.whenConditions';
	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';

	private readonly cachedWhen: { [when: string]: boolean };

	private readonly shortcuts: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());

	private enabled = false;
	private workbenchState: WorkbenchState;

	constructor(
		container: HTMLElement,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		// [ChipOS] Onboarding render path additions
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();

		this.cachedWhen = this.storageService.getObject(EditorGroupWatermark.CACHED_WHEN, StorageScope.PROFILE, Object.create(null));
		this.workbenchState = this.contextService.getWorkbenchState();

		const elements = h('.editor-group-watermark', [
			h('.watermark-container', [
				h('.letterpress'),
				h('.shortcuts@shortcuts'),
			])
		]);

		append(container, elements.root);
		this.shortcuts = elements.shortcuts;

		this.registerListeners();

		this.render();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY) &&
				this.enabled !== this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY)
			) {
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState !== workbenchState) {
				this.workbenchState = workbenchState;
				this.render();
			}
		}));

		this._register(this.storageService.onWillSaveState(e => {
			if (e.reason === WillSaveStateReason.SHUTDOWN) {
				const entries = [...emptyWindowEntries, ...workspaceEntries, ...otherEntries];
				for (const entry of entries) {
					const when = isWeb ? entry.when?.web : entry.when?.native;
					if (when) {
						this.cachedWhen[entry.id] = this.contextKeyService.contextMatchesRules(when);
					}
				}

				this.storageService.store(EditorGroupWatermark.CACHED_WHEN, JSON.stringify(this.cachedWhen), StorageScope.PROFILE, StorageTarget.MACHINE);
			}
		}));
	}

	private render(): void {
		this.enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);

		clearNode(this.shortcuts);
		this.transientDisposables.clear();

		if (!this.enabled) {
			return;
		}

		// [ChipOS] Replace the framework's keybinding-list watermark with an
		// onboarding surface: 4 large icon-buttons (Open Folder / Open File /
		// Clone Repository / Open Chat) followed by a Recent Projects list.
		// Matches Cursor's empty-editor/no-workspace UX. The original
		// keybinding entries (workspaceEntries / emptyWindowEntries / etc.)
		// declared at the top of this file are deliberately unused now —
		// kept for upstream merge clarity. The keybinding for each action
		// is still respected via the global command, the user just doesn't
		// see it in this surface.
		this._renderChipOSOnboarding(this.shortcuts);
	}

	private _renderChipOSOnboarding(host: HTMLElement): void {
		const box = append(host, $('.watermark-box.chipos-onboarding'));

		// 4 primary action buttons — icon + label, full-width cards.
		const actions = append(box, $('.chipos-onboarding-actions'));
		const actionDefs: { id: string; label: string; icon: ThemeIcon; description?: string; args?: unknown[] }[] = [
			{
				id: isMacintosh && !isWeb ? 'workbench.action.files.openFileFolder' : 'workbench.action.files.openFolder',
				label: localize('chiposOnboarding.openFolder', "Open Folder"),
				icon: Codicon.folderOpened,
				description: localize('chiposOnboarding.openFolder.desc', "Open a local project folder"),
			},
			{
				id: 'workbench.action.files.openFile',
				label: localize('chiposOnboarding.openFile', "Open File"),
				icon: Codicon.fileSymlinkFile,
				description: localize('chiposOnboarding.openFile.desc', "Open a single file"),
			},
			{
				id: 'git.clone',
				label: localize('chiposOnboarding.cloneRepo', "Clone Repository"),
				icon: Codicon.repoClone,
				description: localize('chiposOnboarding.cloneRepo.desc', "Clone a remote git repository"),
			},
			{
				id: 'workbench.action.chat.open',
				label: localize('chiposOnboarding.openChat', "Open Chat"),
				icon: Codicon.chatSparkle,
				description: localize('chiposOnboarding.openChat.desc', "Talk to the ChipOS AI assistant"),
			},
		];
		for (const def of actionDefs) {
			const btn = append(actions, $('a.chipos-onboarding-action'));
			btn.setAttribute('role', 'button');
			btn.setAttribute('aria-label', def.label);
			btn.title = def.description ?? def.label;

			const iconEl = append(btn, $('span.chipos-onboarding-action-icon.codicon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(def.icon));

			const text = append(btn, $('span.chipos-onboarding-action-text'));
			const label = append(text, $('span.chipos-onboarding-action-label'));
			label.textContent = def.label;
			if (def.description) {
				const desc = append(text, $('span.chipos-onboarding-action-desc'));
				desc.textContent = def.description;
			}

			this.transientDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.commandService.executeCommand(def.id, ...(def.args ?? []))
					.catch(() => { /* noop — command may not exist (e.g. git extension not loaded) */ });
			}));
		}

		// Recent Projects — async fetch, render once resolved. Skipped on
		// failure so a broken IWorkspacesService doesn't blank the surface.
		this.workspacesService.getRecentlyOpened().then(recents => {
			const allRecents = [...recents.workspaces];
			if (allRecents.length === 0) {
				return;
			}

			const header = append(box, $('.chipos-onboarding-recent-header'));
			header.textContent = localize('chiposOnboarding.recentProjects', "Recent Projects");

			const list = append(box, $('.chipos-onboarding-recent'));
			for (const r of allRecents.slice(0, 6)) {
				let uri: URI;
				let name: string;
				if (isRecentFolder(r)) {
					uri = (r as IRecentFolder).folderUri;
					name = (r as IRecentFolder).label ?? this.labelService.getWorkspaceLabel(uri, { verbose: 0 });
				} else if (isRecentWorkspace(r)) {
					uri = (r as IRecentWorkspace).workspace.configPath;
					name = (r as IRecentWorkspace).label ?? this.labelService.getWorkspaceLabel((r as IRecentWorkspace).workspace, { verbose: 0 });
				} else {
					continue;
				}
				const pathLabel = this.labelService.getUriLabel(uri, { relative: false });

				const item = append(list, $('a.chipos-onboarding-recent-item'));
				item.setAttribute('role', 'button');
				item.title = pathLabel;

				const nameEl = append(item, $('span.chipos-onboarding-recent-name'));
				nameEl.textContent = name;

				const pathEl = append(item, $('span.chipos-onboarding-recent-path'));
				pathEl.textContent = pathLabel;

				this.transientDisposables.add(addDisposableListener(item, EventType.CLICK, () => {
					const folderUri = isRecentFolder(r) ? (r as IRecentFolder).folderUri : undefined;
					if (folderUri) {
						this.commandService.executeCommand('vscode.openFolder', folderUri).catch(() => { /* noop */ });
					} else if (isRecentWorkspace(r)) {
						this.commandService.executeCommand('vscode.openFolder', (r as IRecentWorkspace).workspace.configPath).catch(() => { /* noop */ });
					}
				}));
			}
		}).catch(() => { /* noop */ });
	}
}
