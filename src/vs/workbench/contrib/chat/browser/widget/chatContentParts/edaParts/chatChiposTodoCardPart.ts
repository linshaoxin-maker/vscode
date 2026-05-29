/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatContentPart } from '../chatContentParts.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import * as dom from '../../../../../../../base/browser/dom.js';
import { IChatChiposTodoCard } from '../../../../common/chatEdaTypes.js';
import { localize } from '../../../../../../../nls.js';

/**
 * [ChipOS] Renders a permanent, read-only snapshot of a turn's todo list inline
 * in the chat history. The live list lives in the sticky widget above the input
 * while the turn runs; when the turn ends, the chat agent emits one of these so
 * the checklist survives in the scroll-back instead of being cleared.
 */
export class ChatChiposTodoCardContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly _data: IChatChiposTodoCard,
	) {
		super();
		this.domNode = dom.$('.chipos-todo-card');
		this._render();
	}

	private _render(): void {
		dom.clearNode(this.domNode);

		const todos = this._data.todos ?? [];
		const completed = todos.filter(t => t.status === 'completed').length;

		const header = dom.append(this.domNode, dom.$('.chipos-todo-card-header'));
		dom.append(header, dom.$('.codicon.codicon-checklist'));
		const titleEl = dom.append(header, dom.$('.chipos-todo-card-title'));
		titleEl.textContent = localize('chipos.todoCard.title', "Tasks");
		const countEl = dom.append(header, dom.$('.chipos-todo-card-count'));
		countEl.textContent = `${completed}/${todos.length}`;

		const list = dom.append(this.domNode, dom.$('.chipos-todo-card-list'));
		for (const todo of todos) {
			const item = dom.append(list, dom.$(`.chipos-todo-card-item.${todo.status}`));
			const iconClass = todo.status === 'completed'
				? 'codicon-pass-filled'
				: todo.status === 'in-progress'
					? 'codicon-arrow-right'
					: 'codicon-circle-large-outline';
			dom.append(item, dom.$(`.codicon.${iconClass}`));
			const text = dom.append(item, dom.$('.chipos-todo-card-item-title'));
			text.textContent = todo.title;
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: unknown): boolean {
		const o = other as unknown as IChatChiposTodoCard;
		if (o.kind !== 'chiposTodoCard' || o.todos.length !== this._data.todos.length) {
			return false;
		}
		// Re-render only when a title or status actually changed.
		return this._data.todos.every((t, i) =>
			t.title === o.todos[i].title && t.status === o.todos[i].status);
	}
}
