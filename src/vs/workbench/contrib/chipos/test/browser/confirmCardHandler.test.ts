/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ConfirmCardHandler, type IConfirmResponse } from '../../../../../workbench/contrib/chipos/browser/migration/confirmCardHandler.js';
import { AgentEventType, type IConfirmEvent } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';

// ── Lightweight stubs ──────────────────────────────────────────────────────

class StubLogService {
	debug(..._args: unknown[]): void { /* noop */ }
	trace(..._args: unknown[]): void { /* noop */ }
	info(..._args: unknown[]): void { /* noop */ }
	warn(..._args: unknown[]): void { /* noop */ }
	error(..._args: unknown[]): void { /* noop */ }
}

class StubConfigurationService {
	private _values = new Map<string, unknown>();

	setValue(key: string, value: unknown): void {
		this._values.set(key, value);
	}

	getValue<T>(key: string): T {
		return this._values.get(key) as T;
	}

	onDidChangeConfiguration = () => ({ dispose() { /* noop */ } });
}

class StubInstantiationService {
	createInstance<T>(_ctor: any, ..._args: any[]): T {
		return {} as T;
	}
}

function makeConfirmEvent(
	hookId: string,
	cardType: 'simple' | 'diff_preview' | 'sim_report' | 'custom' = 'simple',
	skippable = true,
	cardData: Record<string, unknown> = {},
): IConfirmEvent {
	return {
		event_id: `evt_${hookId}`,
		event_type: AgentEventType.Confirm,
		timestamp: Date.now(),
		payload: {
			hook_id: hookId,
			card_type: cardType,
			card_data: cardData,
			skippable,
		},
	};
}

suite('ConfirmCardHandler', () => {

	let container: HTMLElement;
	let handler: ConfirmCardHandler;
	let configService: StubConfigurationService;
	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
		container = document.createElement('div');
		configService = new StubConfigurationService();

		handler = new ConfirmCardHandler(
			container,
			new StubInstantiationService() as any,
			new StubLogService() as any,
			configService as any,
		);
		disposables.add(handler);
	});

	teardown(() => {
		disposables.dispose();
	});

	// ── Simple card rendering ─────────────────────────────────────────────

	test('renders simple confirm card with buttons', () => {
		const event = makeConfirmEvent('hook1', 'simple', true, { description: 'Apply edits?' });
		handler.handleConfirmEvent(event);

		const card = container.querySelector('.chipos-confirm-card-simple');
		assert.ok(card, 'Card element should exist');
		assert.strictEqual(card!.getAttribute('data-hook-id'), 'hook1');

		const buttons = card!.querySelectorAll('.chipos-confirm-btn');
		assert.strictEqual(buttons.length, 3); // Confirm, Reject, Skip
	});

	// ── Response emission ─────────────────────────────────────────────────

	test('emits confirm response when confirm button clicked', () => {
		const responses: IConfirmResponse[] = [];
		handler.onDidRespond(r => responses.push(r));

		handler.handleConfirmEvent(makeConfirmEvent('hook_a'));

		const confirmBtn = container.querySelector('.chipos-confirm-btn-confirm') as HTMLButtonElement;
		assert.ok(confirmBtn);
		confirmBtn.click();

		assert.strictEqual(responses.length, 1);
		assert.strictEqual(responses[0].hook_id, 'hook_a');
		assert.strictEqual(responses[0].action, 'confirm');
	});

	test('emits reject response when reject button clicked', () => {
		const responses: IConfirmResponse[] = [];
		handler.onDidRespond(r => responses.push(r));

		handler.handleConfirmEvent(makeConfirmEvent('hook_b'));

		const rejectBtn = container.querySelector('.chipos-confirm-btn-reject') as HTMLButtonElement;
		assert.ok(rejectBtn);
		rejectBtn.click();

		assert.strictEqual(responses.length, 1);
		assert.strictEqual(responses[0].action, 'reject');
	});

	test('emits skip response when skip button clicked', () => {
		const responses: IConfirmResponse[] = [];
		handler.onDidRespond(r => responses.push(r));

		handler.handleConfirmEvent(makeConfirmEvent('hook_c', 'simple', true));

		const skipBtn = container.querySelector('.chipos-confirm-btn-skip') as HTMLButtonElement;
		assert.ok(skipBtn);
		skipBtn.click();

		assert.strictEqual(responses.length, 1);
		assert.strictEqual(responses[0].action, 'skip');
	});

	// ── Auto-approve mode ─────────────────────────────────────────────────

	test('auto-approve mode bypasses card rendering', async () => {
		configService.setValue('chipos.agent.autoApprove', true);

		const responses: IConfirmResponse[] = [];
		handler.onDidRespond(r => responses.push(r));

		handler.handleConfirmEvent(makeConfirmEvent('hook_auto'));

		assert.strictEqual(container.children.length, 0, 'No card should be rendered');

		// Wait for the auto-approve timeout (300ms + buffer)
		await new Promise(resolve => setTimeout(resolve, 400));

		assert.strictEqual(responses.length, 1);
		assert.strictEqual(responses[0].hook_id, 'hook_auto');
		assert.strictEqual(responses[0].action, 'confirm');
	});

	// ── Non-skippable card ────────────────────────────────────────────────

	test('non-skippable card hides skip button', () => {
		handler.handleConfirmEvent(makeConfirmEvent('hook_noskip', 'simple', false));

		const skipBtn = container.querySelector('.chipos-confirm-btn-skip');
		assert.strictEqual(skipBtn, null, 'Skip button should not exist');

		const buttons = container.querySelectorAll('.chipos-confirm-btn');
		assert.strictEqual(buttons.length, 2); // Confirm, Reject only
	});

	// ── Card displays description ─────────────────────────────────────────

	test('simple card renders description text', () => {
		handler.handleConfirmEvent(makeConfirmEvent('hook_desc', 'simple', true, {
			description: 'Overwrite counter.v?',
		}));

		const desc = container.querySelector('.chipos-confirm-description');
		assert.ok(desc);
		assert.strictEqual(desc!.textContent, 'Overwrite counter.v?');
	});

	// ── Response badge ────────────────────────────────────────────────────

	test('card gets responded class after action', () => {
		handler.handleConfirmEvent(makeConfirmEvent('hook_badge'));

		const confirmBtn = container.querySelector('.chipos-confirm-btn-confirm') as HTMLButtonElement;
		confirmBtn.click();

		const card = container.querySelector('.chipos-confirm-card');
		assert.ok(card!.classList.contains('chipos-confirm-card-responded'));
	});
});
