/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../../common/views.js';
import { localize } from '../../../../../nls.js';

// ── Data types ─────────────────────────────────────────────────────────────

export interface ISkillDomain {
	readonly id: string;
	readonly label: string;
	readonly skills: ISkillItem[];
}

export interface ISkillItem {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly triggerMode: 'auto' | 'manual' | 'keyword' | 'always';
	readonly enabled: boolean;
}

export type ISkillTreeNode = ISkillDomain | ISkillItem;

export interface ISkillTreeData {
	readonly domains: ISkillDomain[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isSkillDomain(node: ISkillTreeNode): node is ISkillDomain {
	return 'skills' in node && Array.isArray((node as ISkillDomain).skills);
}

const TRIGGER_MODE_ICONS: Record<string, string> = {
	auto: '⚡',
	manual: '🔧',
	keyword: '🔑',
	always: '♾️',
};

// ── Handler ────────────────────────────────────────────────────────────────

export class SkillTreeHandler extends Disposable {

	private _skills: ISkillDomain[] = [];
	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	updateSkillTree(data: ISkillTreeData): void {
		this._skills = data.domains.map(d => ({ ...d }));
		this._logService.trace('[SkillTreeHandler] Full update:', this._skills.length, 'domains');
		this._onDidChangeTreeData.fire();
	}

	updateSkill(skillId: string, data: Partial<ISkillItem>): void {
		for (let i = 0; i < this._skills.length; i++) {
			const domain = this._skills[i];
			const idx = domain.skills.findIndex(s => s.id === skillId);
			if (idx >= 0) {
				const existing = domain.skills[idx];
				const updated: ISkillItem = {
					id: existing.id,
					name: data.name ?? existing.name,
					description: data.description ?? existing.description,
					triggerMode: data.triggerMode ?? existing.triggerMode,
					enabled: data.enabled ?? existing.enabled,
				};
				const newSkills = [...domain.skills];
				newSkills[idx] = updated;
				this._skills[i] = { ...domain, skills: newSkills };
				this._logService.trace('[SkillTreeHandler] Updated skill:', skillId);
				this._onDidChangeTreeData.fire();
				return;
			}
		}
		this._logService.warn('[SkillTreeHandler] Skill not found for update:', skillId);
	}

	getTreeDataProvider(): ISkillTreeDataProvider {
		return {
			onDidChangeTreeData: this.onDidChangeTreeData,
			getChildren: (element?: ISkillTreeNode) => this._getChildren(element),
			getTreeItem: (element: ISkillTreeNode) => this._getTreeItem(element),
		};
	}

	get domains(): readonly ISkillDomain[] {
		return this._skills;
	}

	// ── Tree data provider ────────────────────────────────────────────────

	private _getChildren(element?: ISkillTreeNode): ISkillTreeNode[] {
		if (!element) {
			return this._skills;
		}
		if (isSkillDomain(element)) {
			return element.skills;
		}
		return [];
	}

	private _getTreeItem(element: ISkillTreeNode): ISkillTreeItem {
		if (isSkillDomain(element)) {
			return {
				id: element.id,
				label: element.label,
				description: `${element.skills.length} skills`,
				collapsibleState: element.skills.length > 0 ? 1 : 0,
			};
		}

		const skill = element as ISkillItem;
		const modeIcon = TRIGGER_MODE_ICONS[skill.triggerMode] ?? '';
		return {
			id: skill.id,
			label: `${skill.enabled ? '✓' : '○'} ${skill.name}`,
			description: `${modeIcon} ${skill.triggerMode} — ${skill.description}`,
			collapsibleState: 0,
		};
	}
}

// ── Tree provider interface ────────────────────────────────────────────────

export interface ISkillTreeItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly collapsibleState: number; // 0 = None, 1 = Collapsed, 2 = Expanded
}

export interface ISkillTreeDataProvider {
	readonly onDidChangeTreeData: Event<void>;
	getChildren(element?: ISkillTreeNode): ISkillTreeNode[];
	getTreeItem(element: ISkillTreeNode): ISkillTreeItem;
}

// ── VS Code ITreeViewDataProvider adapter ──────────────────────────────────

export class SkillTreeViewDataProvider implements ITreeViewDataProvider {

	private readonly _handler: SkillTreeHandler;
	private readonly _isEnabled: () => boolean;
	private _isEmpty = true;
	private readonly _onDidChangeEmpty = new Emitter<void>();
	readonly onDidChangeEmpty: Event<void> = this._onDidChangeEmpty.event;

	constructor(handler: SkillTreeHandler, isEnabled?: () => boolean) {
		this._handler = handler;
		this._isEnabled = isEnabled ?? (() => true);
		handler.onDidChangeTreeData(() => {
			const wasEmpty = this._isEmpty;
			this._isEmpty = handler.domains.length === 0;
			if (wasEmpty !== this._isEmpty) {
				this._onDidChangeEmpty.fire();
			}
		});
	}

	get isTreeEmpty(): boolean {
		return this._isEmpty;
	}

	async getChildren(element?: ITreeItem): Promise<ITreeItem[] | undefined> {
		if (!element) {
			if (!this._isEnabled()) {
				return [{
					handle: 'chipos.skillTree.disabled',
					collapsibleState: TreeItemCollapsibleState.None,
					label: { label: localize('chipos.skillTree.off', 'Dynamic skills are off — turn it back on from the title bar.') },
					themeIcon: Codicon.circleSlash,
				}];
			}
			return this._handler.domains.map(d => this._domainToTreeItem(d));
		}

		const domain = this._handler.domains.find(d => d.id === element.handle);
		if (domain) {
			return domain.skills.map(s => this._skillToTreeItem(s, domain.id));
		}

		return [];
	}

	private _domainToTreeItem(domain: ISkillDomain): ITreeItem {
		return {
			handle: domain.id,
			collapsibleState: domain.skills.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
			label: { label: domain.label },
			description: `${domain.skills.length} skills`,
			themeIcon: Codicon.symbolNamespace,
		};
	}

	private _skillToTreeItem(skill: ISkillItem, parentHandle: string): ITreeItem {
		const modeIcon = TRIGGER_MODE_ICONS[skill.triggerMode] ?? '';
		return {
			handle: skill.id,
			parentHandle,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: `${skill.enabled ? '✓' : '○'} ${skill.name}` },
			description: `${modeIcon} ${skill.triggerMode}`,
			tooltip: skill.description,
			themeIcon: skill.enabled ? Codicon.check : (Codicon.circle as ThemeIcon),
		};
	}
}
