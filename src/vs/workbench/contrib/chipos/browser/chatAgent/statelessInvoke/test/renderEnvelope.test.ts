/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * F-1-ide — RenderEnvelope unwrap + three-layer degrade (/invoke v1.1 S5, §8 + D10).
 *
 * Locks two things:
 *   1. the pure `resolveRenderEnvelope` / `isRenderEnvelope` state machine
 *      (layer 1 passthrough / layer 2 unwrap / layer 3 degrade), and
 *   2. the dispatcher wiring invariant — an S5 ENVELOPED render card must dispatch
 *      to EXACTLY the same `DispatchResult` as the legacy BARE frame (the unwrap is
 *      transparent), while a degraded envelope renders its fallback, never dropped.
 */

import assert from 'assert';
import { dispatchStatelessEvent } from '../eventDispatcher.js';
import { isRenderEnvelope, resolveRenderEnvelope } from '../renderEnvelope.js';
import type { InvokeEvent } from '../types.js';

function ev(type: InvokeEvent['type'], data: Record<string, unknown> = {}, sequence_id = 1): InvokeEvent {
	return { type, sequence_id, data };
}

/** Build a wire RenderEnvelope `{ kind, schema_version?, payload, fallback }`. */
function envelope(kind: string, payload: unknown, fallback: unknown, schema_version?: number): Record<string, unknown> {
	const e: Record<string, unknown> = { kind, payload, fallback };
	if (schema_version !== undefined) {
		e.schema_version = schema_version;
	}
	return e;
}

suite('renderEnvelope — isRenderEnvelope (structural)', () => {

	test('kind + payload + fallback keys → true (presence, not value)', () => {
		assert.strictEqual(isRenderEnvelope({ kind: 'sim_report', payload: {}, fallback: {} }), true);
		assert.strictEqual(isRenderEnvelope({ kind: 'x', payload: null, fallback: null }), true);
	});

	test('legacy bare card (no envelope keys) → false (backward-compat red line)', () => {
		assert.strictEqual(isRenderEnvelope({ tests: [], summary: { total: 0 } }), false);
		assert.strictEqual(isRenderEnvelope({ kind: 'x' }), false);            // missing payload + fallback
		assert.strictEqual(isRenderEnvelope({ payload: {}, fallback: {} }), false); // missing kind
	});

	test('non-object / non-string kind → false', () => {
		assert.strictEqual(isRenderEnvelope(null), false);
		assert.strictEqual(isRenderEnvelope([]), false);
		assert.strictEqual(isRenderEnvelope('sim_report'), false);
		assert.strictEqual(isRenderEnvelope({ kind: 1, payload: {}, fallback: {} }), false);
	});
});

suite('renderEnvelope — resolveRenderEnvelope (three layers)', () => {

	test('layer 1: legacy bare frame → identity passthrough, not degraded', () => {
		const bare = { tests: [{ name: 't', status: 'pass' }], summary: { total: 1 } };
		const r = resolveRenderEnvelope(bare);
		assert.strictEqual(r.degraded, false);
		assert.strictEqual(r.data, bare); // same reference — never copied
		assert.strictEqual(r.kind, undefined);
	});

	test('layer 2: known kind, no schema_version → unwrap to payload', () => {
		const payload = { tests: [{ name: 't', status: 'pass' }] };
		const r = resolveRenderEnvelope(envelope('sim_report', payload, { text: 'fb' }));
		assert.strictEqual(r.degraded, false);
		assert.deepStrictEqual(r.data, payload);
		assert.strictEqual(r.kind, 'sim_report');
	});

	test('layer 2: known kind, schema_version 1 ≤ ceiling → unwrap', () => {
		const payload = { errors: [] };
		const r = resolveRenderEnvelope(envelope('lint_report', payload, {}, 1));
		assert.strictEqual(r.degraded, false);
		assert.deepStrictEqual(r.data, payload);
	});

	test('layer 2: non-object payload → {} (never crash the card)', () => {
		const r = resolveRenderEnvelope(envelope('sim_report', 'oops', { text: 'fb' }));
		assert.strictEqual(r.degraded, false);
		assert.deepStrictEqual(r.data, {});
	});

	test('layer 3a: unknown kind (no IDE card) → degrade to fallback', () => {
		const r = resolveRenderEnvelope(envelope('loop_progress', { round: 2 }, { text: 'round 2' }));
		assert.strictEqual(r.degraded, true);
		assert.strictEqual(r.kind, 'loop_progress');
		assert.deepStrictEqual(r.data, { text: 'round 2' });
	});

	test('layer 3b: schema_version too new → degrade even for a known kind', () => {
		const r = resolveRenderEnvelope(envelope('sim_report', { tests: [] }, { text: 'newer' }, 99));
		assert.strictEqual(r.degraded, true);
		assert.deepStrictEqual(r.data, { text: 'newer' });
	});

	test('ui_spec (D-1 generative UI) → always degrade in Beta-1', () => {
		const r = resolveRenderEnvelope(envelope('ui_spec', { spec: {} }, { text: 'generic' }));
		assert.strictEqual(r.degraded, true);
		assert.strictEqual(r.kind, 'ui_spec');
		assert.deepStrictEqual(r.data, { text: 'generic' });
	});

	test('malformed fallback: string → coerced to { text }', () => {
		const r = resolveRenderEnvelope(envelope('loop_progress', {}, 'plain string'));
		assert.deepStrictEqual(r.data, { text: 'plain string' });
	});

	test('malformed fallback: missing/null → synthesize from kind (never empty, D10)', () => {
		const r = resolveRenderEnvelope({ kind: 'loop_progress', payload: {}, fallback: null });
		assert.strictEqual(r.degraded, true);
		assert.deepStrictEqual(r.data, { text: 'loop_progress' });
	});
});

suite('dispatchStatelessEvent — RenderEnvelope wiring (F-1-ide)', () => {

	test('⭐ enveloped card dispatches IDENTICALLY to the bare card (transparent unwrap)', () => {
		const payload = {
			tests: [{ name: 't', status: 'pass', message: '' }],
			summary: { total: 1, passed: 1, failed: 0 },
		};
		const bare = dispatchStatelessEvent(ev('sim_report', payload));
		const enveloped = dispatchStatelessEvent(ev('sim_report', envelope('sim_report', payload, { text: 'fb' })));
		assert.deepStrictEqual(enveloped, bare);
		// sanity: the bare path actually produced a real card (not a no-op)
		assert.strictEqual(bare.flushText, true);
		assert.ok(Array.isArray(bare.edaParts) && bare.edaParts.length >= 1);
	});

	test('⭐ enveloped todo dispatches IDENTICALLY to the bare todo (regression — was degrading to raw JSON)', () => {
		// `todo` is backend render-family (so the SSEEmitSink WRAPS it), and the IDE has a
		// dedicated `case 'todo'`. It was missing from IDE_RENDER_KINDS → a wrapped todo
		// degraded to a raw-JSON markdown dump on every write_todos turn. Lock it.
		const payload = { todos: [{ id: '1', content: 'do x', status: 'pending' }, { id: '2', content: 'do y', status: 'completed' }] };
		const bare = dispatchStatelessEvent(ev('todo', payload));
		const enveloped = dispatchStatelessEvent(ev('todo', envelope('todo', payload, { text: '{"todos":[…]}' })));
		assert.deepStrictEqual(enveloped, bare);
		assert.ok(bare.progressMessage, 'bare todo should render a progressMessage');
		assert.ok(!enveloped.markdownContents, 'enveloped todo must NOT fall through to a raw-JSON markdown block');
	});

	test('degraded fallback with artifact_ref → renders a markdown link (untrusted, so href is inert)', () => {
		// `plan` is render-family (wrapped) but the IDE has no case → degrades to fallback.
		const r = dispatchStatelessEvent(ev('plan', envelope('plan', { steps: [] }, { summary: 'Plan ready', artifact_ref: { uri: 'file:///tmp/plan.md', label: 'plan.md' } })));
		assert.strictEqual(r.flushText, true);
		assert.deepStrictEqual(r.markdownContents, ['Plan ready\n\n[plan.md](file:///tmp/plan.md)']);
	});

	test('degraded envelope (unknown kind) → markdown fallback, never dropped (D10)', () => {
		const r = dispatchStatelessEvent(ev('loop_progress', envelope('loop_progress', { round: 3 }, { summary: 'Loop round 3/5' })));
		assert.strictEqual(r.flushText, true);
		assert.deepStrictEqual(r.markdownContents, ['Loop round 3/5']);
	});

	test('degraded envelope (known kind, schema too new) → fallback', () => {
		const r = dispatchStatelessEvent(ev('sim_report', envelope('sim_report', { tests: [] }, { text: 'too new' }, 99)));
		assert.deepStrictEqual(r.markdownContents, ['too new']);
	});

	test('non-render event whose data is NOT an envelope → untouched (passthrough)', () => {
		const r = dispatchStatelessEvent(ev('content_block_delta', { delta: { type: 'text_delta', text: 'hi' } }));
		assert.deepStrictEqual(r, { appendText: 'hi' });
	});

	test('⭐ waveform RenderEnvelope unwraps (degraded:false) → edaWaveform card, identical to bare', () => {
		const payload = {
			path: '/w/counter.vcd', title: 'counter.vcd', timescale: '1ns',
			summary: '1 signal(s) from counter.vcd',
			signals: [{ name: 'tb.clk', wave: '0101.', data: [] }],
		};
		// layer-2: envelope kind 'waveform' is now in IDE_RENDER_KINDS → not degraded.
		assert.strictEqual(resolveRenderEnvelope(envelope('waveform', payload, { text: 'fb' })).degraded, false);
		const bare = dispatchStatelessEvent(ev('waveform', payload));
		const enveloped = dispatchStatelessEvent(ev('waveform', envelope('waveform', payload, { text: 'fb' })));
		assert.deepStrictEqual(enveloped, bare);
		assert.strictEqual(bare.flushText, true);
		assert.ok(Array.isArray(bare.edaParts) && bare.edaParts[0].kind === 'edaWaveform');
	});

	test('vcd_waveform alias RenderEnvelope unwraps identically (not degraded)', () => {
		const payload = { title: 'a.vcd', signals: [{ name: 's', wave: '01', data: [] }] };
		assert.strictEqual(resolveRenderEnvelope(envelope('vcd_waveform', payload, {})).degraded, false);
		const bare = dispatchStatelessEvent(ev('vcd_waveform', payload));
		const enveloped = dispatchStatelessEvent(ev('vcd_waveform', envelope('vcd_waveform', payload, {})));
		assert.deepStrictEqual(enveloped, bare);
	});

	test('legacy bare waveform frame (no envelope) still renders the card (backward-compat D-2)', () => {
		const r = dispatchStatelessEvent(ev('waveform', { title: 'b.vcd', signals: [{ name: 's', wave: '0', data: [] }] }));
		assert.strictEqual(r.flushText, true);
		assert.ok(Array.isArray(r.edaParts) && r.edaParts[0].kind === 'edaWaveform');
	});

	test('viewer_action stays a SEPARATE control event (returns viewerAction, never edaWaveform)', () => {
		// Prove the render `waveform` path and the control `viewer_action` path are distinct.
		const r = dispatchStatelessEvent(ev('viewer_action', { path: '/w/counter.vcd', signals: ['tb.clk'], cycle: 3 }));
		// The exact shape (viewerAction only, no edaParts) proves the control path is distinct.
		assert.deepStrictEqual(r, { viewerAction: { path: '/w/counter.vcd', signals: ['tb.clk'], cycle: 3 } });
	});
});
