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
import { formatReadinessLines } from '../readinessDisplay.js';
import type { ReadinessInput } from '../vendor/workflow/readiness.js';

const NOW = 1_000_000;

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

	test('a BLOCK appends the five-layer breakdown (audit F-6 display) naming the failed layer', () => {
		// logged-out blocks: the concise ask stays first, then the layered panel shows ✗身份.
		const v = evaluateWorkflowGate('/synth', { ...ready, loggedIn: false }, NOW);
		assert.ok(v!.block);
		assert.ok(v!.message.includes('就绪状态（五层'), 'block should carry the five-layer panel');
		assert.ok(v!.message.includes('✓ 连接'), 'L1 connected row');
		assert.ok(v!.message.includes('✗ 身份') && v!.message.includes('未登录'), 'L2 identity row marks the failure');
		assert.ok(v!.message.includes('✗ 就绪'), 'L5 verdict blocked');
	});

	// ── formatReadinessLines — the shared five-layer renderer (audit F-6, IDE leg) ──
	suite('formatReadinessLines (five-layer display)', () => {
		const ideReady: ReadinessInput = { connectionState: 'connected', loggedIn: true, poolCount: 1 };

		test('titled panel: one row per observed layer + the honest L5 verdict', () => {
			const lines = formatReadinessLines(ideReady, NOW);
			assert.ok(lines[0].includes('就绪状态'));
			assert.ok(lines.some(l => l.includes('连接')));
			assert.ok(lines.some(l => l.includes('身份')));
			assert.ok(lines.some(l => l.includes('worker 池')));
			// pool-count alone (no registry capability — the only signal the invoke-chokepoint
			// gate has) is honestly DEGRADED, not ready: a bare /health count doesn't prove a
			// session-usable worker (the L3 caveat). This documents the no-false-green verdict.
			assert.ok(lines.some(l => l.startsWith('! 就绪') && l.includes('能力未验证')), 'pool-only → L5 degraded, not false-green ready');
		});

		test('bound capability → ✓就绪 ready (the registry verdict outranks the bare count)', () => {
			const lines = formatReadinessLines({ ...ideReady, capability: { state: 'bound', bound: { worker_id: 'w1' }, genericCount: 0, total: 1 } }, NOW);
			assert.ok(lines.some(l => l.startsWith('✓ 就绪')));
			assert.ok(lines.some(l => l.startsWith('✓ 工具能力') && l.includes('w1')), 'L4 names the bound worker');
		});

		test('disconnected → ✗连接 + ✗就绪', () => {
			const lines = formatReadinessLines({ ...ideReady, connectionState: 'disconnected' }, NOW);
			assert.ok(lines.some(l => l.startsWith('✗ 连接')));
			assert.ok(lines.some(l => l.startsWith('✗ 就绪')));
		});

		test('0-worker pool → ✗worker 池 row', () => {
			const lines = formatReadinessLines({ ...ideReady, poolCount: 0 }, NOW);
			assert.ok(lines.some(l => l.startsWith('✗ worker 池') && l.includes('0 个在线')));
		});
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
