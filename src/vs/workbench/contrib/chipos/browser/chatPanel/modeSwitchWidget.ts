/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import type { SessionMode } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatSessionManager';

const $ = dom.$;

export class ModeSwitchWidget extends Disposable {

	private readonly _container: HTMLElement;
	private readonly _indicator: HTMLSpanElement;
	private readonly _select: HTMLSelectElement;

	private readonly _onDidChangeMode = this._register(new Emitter<SessionMode>());
	readonly onDidChangeMode: Event<SessionMode> = this._onDidChangeMode.event;

	constructor(parent: HTMLElement) {
		super();

		this._container = $('div.chipos-chat-mode-switch');

		this._indicator = document.createElement('span');
		this._indicator.className = 'chipos-chat-mode-indicator chipos-mode-agent';

		this._select = document.createElement('select');
		this._select.className = 'chipos-chat-mode-select';
		this._select.appendChild(new Option('Agent', 'agent'));
		this._select.appendChild(new Option('Spec', 'spec'));

		this._container.appendChild(this._indicator);
		this._container.appendChild(this._select);

		this._register(dom.addDisposableListener(this._select, 'change', () => {
			const mode = this._select.value as SessionMode;
			this._updateIndicator(mode);
			this._onDidChangeMode.fire(mode);
		}));

		parent.appendChild(this._container);
	}

	getMode(): SessionMode {
		return this._select.value as SessionMode;
	}

	setMode(mode: SessionMode): void {
		if (this._select.value !== mode) {
			this._select.value = mode;
			this._updateIndicator(mode);
		}
	}

	setEnabled(enabled: boolean): void {
		this._select.disabled = !enabled;
	}

	private _updateIndicator(mode: SessionMode): void {
		this._indicator.classList.remove('chipos-mode-agent', 'chipos-mode-spec');
		this._indicator.classList.add(mode === 'agent' ? 'chipos-mode-agent' : 'chipos-mode-spec');
	}
}
