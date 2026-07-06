/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import {
	matchWorkflowCommand,
	evaluateWorkflowGate,
	parseWorkersConnected,
	probeWorkersConnected,
	AI4EDA_WORKFLOW_COMMANDS,
} from '../workflowGate.js';
import type { PreflightSignals } from '../vendor/workflow/preflight.js';

/**
 * IDE-side workflow-preflight gate (audit F-6, IDE leg). The class-free helper wires the
 * IDE into the shared canonical decision (vendor/workflow/preflight), so the gate verdict
 * never drifts from the CLI / extension. Mocha-style globals (VS Code convention); the
 * helper has no platform deps, so this is hermetic (an injected fetch stub — no network).
 */
suite('ChipOS · workflowGate (audit F-6, IDE leg)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ready: PreflightSignals = { connectionState: 'connected', loggedIn: true, approveMode: 'standard', remoteWorkers: 1 };

	test('exposes the 7 canonical AI4EDA workflow commands', () => {
		assert.deepStrictEqual([...AI4EDA_WORKFLOW_COMMANDS], ['/lint', '/sim', '/synth', '/ppa', '/cov', '/tb', '/review']);
	});

	test('matchWorkflowCommand recognises workflows (with/without args), ignores chat', () => {
		assert.strictEqual(matchWorkflowCommand('/lint alu.v'), '/lint');
		assert.strictEqual(matchWorkflowCommand('  /ppa  '), '/ppa');
		assert.strictEqual(matchWorkflowCommand('explain this module'), null);
		assert.strictEqual(matchWorkflowCommand('/lintfoo'), null);
		assert.strictEqual(matchWorkflowCommand('please /lint'), null);
	});

	test('ordinary chat is never gated (null)', () => {
		assert.strictEqual(evaluateWorkflowGate('hello there', ready), null);
	});

	test('connected + logged-in + pool>0 → proceed silently', () => {
		const v = evaluateWorkflowGate('/lint alu.v', ready);
		assert.ok(v);
		assert.strictEqual(v!.block, false);
		assert.strictEqual(v!.ask, false);
	});

	test('0 workers online → ASK (not block)', () => {
		const v = evaluateWorkflowGate('/sim', { ...ready, remoteWorkers: 0 });
		assert.ok(v);
		assert.strictEqual(v!.block, false);
		assert.strictEqual(v!.ask, true);
		assert.ok(v!.message.includes('worker'));
	});

	test('logged-out → block with a login message', () => {
		const v = evaluateWorkflowGate('/synth', { ...ready, loggedIn: false });
		assert.ok(v);
		assert.strictEqual(v!.block, true);
		assert.strictEqual(v!.ask, false);
		assert.ok(v!.message.includes('未登录'));
	});

	test('parseWorkersConnected reads a valid count, rejects junk', () => {
		assert.strictEqual(parseWorkersConnected({ workers_connected: 3 }), 3);
		assert.strictEqual(parseWorkersConnected({ workers_connected: 0 }), 0);
		assert.strictEqual(parseWorkersConnected({ workers_connected: '2' }), undefined);
		assert.strictEqual(parseWorkersConnected(null), undefined);
	});

	test('probeWorkersConnected is best-effort (count on ok; undefined on failure)', async () => {
		const ok = (async () => ({ ok: true, json: async () => ({ workers_connected: 1 }) })) as unknown as typeof fetch;
		assert.strictEqual(await probeWorkersConnected('http://x:8080', undefined, ok), 1);
		assert.strictEqual(await probeWorkersConnected(undefined, undefined, ok), undefined);
		const throws = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
		assert.strictEqual(await probeWorkersConnected('http://x', undefined, throws), undefined);
	});
});
