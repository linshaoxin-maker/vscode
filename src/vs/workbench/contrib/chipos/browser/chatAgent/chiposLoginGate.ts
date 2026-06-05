/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  ChipOS login gate (ADDITIVE — touches no auth/token logic).
 *
 *  When signed OUT, overlays a branded "Sign in to ChipOS" card (design B) on top
 *  of the chat panel so the logged-out experience is a polished page instead of a
 *  raw welcome. The card's button runs the existing `chipos.auth.login` command;
 *  on sign-in the gate is removed and the normal chat UI shows through.
 *
 *  Mirrors ConnectionBannerHandler's DOM-injection approach and is driven purely
 *  by IChipOSAuthService.onDidChangeLoginState — no existing logic is modified.
 *--------------------------------------------------------------------------------------------*/

import './chiposLoginGate.css';

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../../contrib/chat/browser/chat.js';
import { IChipOSAuthService } from '../auth/chiposAuthService.js';

// Mirrors the (const-enum, non-exported) ChipOSCommandId.Login in common/chiposContribution.ts.
const CHIPOS_LOGIN_COMMAND_ID = 'chipos.auth.login';

interface IMountedGate {
	readonly el: HTMLElement;
	readonly store: DisposableStore;
	readonly host: HTMLElement;
	readonly prevHostPosition: string;
}

/**
 * Shows a branded sign-in card over each chat widget while signed out.
 */
class ChipOSLoginGate extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chiposLoginGate';

	private readonly _gates = new Map<IChatWidget, IMountedGate>();

	constructor(
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IChipOSAuthService private readonly _authService: IChipOSAuthService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._register(this._chatWidgetService.onDidAddWidget(() => this._sync()));
		this._register(this._authService.onDidChangeLoginState(() => this._sync()));
		this._sync();
		this._register(toDisposable(() => {
			for (const widget of [...this._gates.keys()]) {
				this._unmount(widget);
			}
		}));
	}

	private _sync(): void {
		const loggedIn = this._authService.isLoggedIn();
		const widgets = this._chatWidgetService.getAllWidgets();
		for (const widget of widgets) {
			if (loggedIn) {
				this._unmount(widget);
			} else {
				this._mount(widget);
			}
		}
		// Drop gates whose widget no longer exists.
		for (const widget of [...this._gates.keys()]) {
			if (!widgets.includes(widget)) {
				this._unmount(widget);
			}
		}
	}

	private _mount(widget: IChatWidget): void {
		if (this._gates.has(widget)) {
			return;
		}
		const host = widget.domNode;
		if (!host) {
			return;
		}
		const store = new DisposableStore();
		const el = this._buildCard(store);
		// The overlay is position:absolute; ensure the host establishes a
		// containing block. We restore the original inline value on unmount.
		const prevHostPosition = host.style.position;
		host.style.position = 'relative';
		host.appendChild(el);
		this._gates.set(widget, { el, store, host, prevHostPosition });
	}

	private _unmount(widget: IChatWidget): void {
		const gate = this._gates.get(widget);
		if (!gate) {
			return;
		}
		gate.el.remove();
		gate.store.dispose();
		gate.host.style.position = gate.prevHostPosition;
		this._gates.delete(widget);
	}

	private _buildCard(store: DisposableStore): HTMLElement {
		const gate = dom.$('.chipos-login-gate');
		const card = dom.append(gate, dom.$('.chipos-login-gate-card'));

		// Hero
		const hero = dom.append(card, dom.$('.chipos-login-gate-hero'));
		dom.append(hero, dom.$('.chipos-login-gate-hero-grid'));
		const heroTitle = dom.append(hero, dom.$('.chipos-login-gate-hero-title'));
		heroTitle.textContent = 'Build with ChipOS';
		const heroSub = dom.append(hero, dom.$('.chipos-login-gate-hero-sub'));
		heroSub.textContent = localize('chipos.loginGate.heroSub', "从 Spec 到 RTL,再到综合 —— 全程 AI 协作");

		// Body
		const body = dom.append(card, dom.$('.chipos-login-gate-body'));
		const head = dom.append(body, dom.$('.chipos-login-gate-head'));
		dom.append(head, dom.$('.chipos-login-gate-logo.codicon.codicon-circuit-board'));
		const title = dom.append(head, dom.$('.chipos-login-gate-title'));
		title.textContent = localize('chipos.loginGate.title', "登录以开始");

		const feats = dom.append(body, dom.$('ul.chipos-login-gate-feats'));
		const featTexts = [
			localize('chipos.loginGate.feat1', "自然语言生成 / 重构 Verilog"),
			localize('chipos.loginGate.feat2', "一键仿真、波形与 lint"),
			localize('chipos.loginGate.feat3', "综合时序分析与优化建议"),
		];
		for (const text of featTexts) {
			const li = dom.append(feats, dom.$('li.chipos-login-gate-feat'));
			dom.append(li, dom.$('span.chipos-login-gate-ck.codicon.codicon-check'));
			const label = dom.append(li, dom.$('span'));
			label.textContent = text;
		}

		const btn = dom.append(body, dom.$<HTMLButtonElement>('button.chipos-login-gate-btn'));
		btn.textContent = localize('chipos.loginGate.button', "使用浏览器登录");
		store.add(dom.addDisposableListener(btn, dom.EventType.CLICK, () => {
			this._commandService.executeCommand(CHIPOS_LOGIN_COMMAND_ID);
		}));

		const foot = dom.append(body, dom.$('.chipos-login-gate-foot'));
		foot.textContent = localize('chipos.loginGate.foot', "登录即同意 ChipOS 服务条款");

		return gate;
	}
}

registerWorkbenchContribution2(ChipOSLoginGate.ID, ChipOSLoginGate, WorkbenchPhase.AfterRestored);
