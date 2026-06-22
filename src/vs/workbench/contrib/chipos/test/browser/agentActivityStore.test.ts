/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentActivityStore, IAgentRun } from '../../../../../workbench/contrib/chipos/browser/agents/agentActivityStore.js';

/** Project a run to a timestamp-free shape so snapshots stay deterministic. */
function project(runs: readonly IAgentRun[]) {
	return runs.map(run => ({
		role: run.role,
		status: run.status,
		activities: run.activities.map(activity => ({
			toolName: activity.toolName,
			done: activity.done,
			result: activity.result,
		})),
	}));
}

suite('AgentActivityStore — Phase 6 Agents view feed', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('tool_start opens a running run; tool_end resolves the activity with its result', () => {
		const store = ds.add(new AgentActivityStore());
		store.recordEvent({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file' });
		store.recordEvent({ taskId: 'rtl-coder', kind: 'tool_end', toolName: 'edit_file', result: '改 1 处' });

		assert.deepStrictEqual(project(store.getRuns()), [
			{ role: 'rtl-coder', status: 'running', activities: [{ toolName: 'edit_file', done: true, result: '改 1 处' }] },
		]);
	});

	test('two roles produce two independent runs in first-seen order', () => {
		const store = ds.add(new AgentActivityStore());
		store.recordEvent({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file' });
		store.recordEvent({ taskId: 'verifier', kind: 'tool_start', toolName: 'verilog_lint' });
		store.recordEvent({ taskId: 'verifier', kind: 'tool_end', toolName: 'verilog_lint', result: '✓ 通过' });

		assert.deepStrictEqual(project(store.getRuns()), [
			{ role: 'rtl-coder', status: 'running', activities: [{ toolName: 'edit_file', done: false, result: undefined }] },
			{ role: 'verifier', status: 'running', activities: [{ toolName: 'verilog_lint', done: true, result: '✓ 通过' }] },
		]);
	});

	test('a tool_end with no matching tool_start is dropped', () => {
		const store = ds.add(new AgentActivityStore());
		store.recordEvent({ taskId: 'ghost', kind: 'tool_end', toolName: 'edit_file' });
		assert.deepStrictEqual(store.getRuns(), []);
	});

	test('markAllDone closes every run and every still-open activity', () => {
		const store = ds.add(new AgentActivityStore());
		store.recordEvent({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file' });
		store.recordEvent({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'verilog_lint' });
		store.markAllDone();

		assert.deepStrictEqual(project(store.getRuns()), [
			{
				role: 'rtl-coder', status: 'done', activities: [
					{ toolName: 'edit_file', done: true, result: undefined },
					{ toolName: 'verilog_lint', done: true, result: undefined },
				],
			},
		]);
	});

	test('clear drops all runs; malformed frames (no taskId) are guarded', () => {
		const store = ds.add(new AgentActivityStore());
		store.recordEvent({ taskId: 'rtl-coder', kind: 'tool_start', toolName: 'edit_file' });
		store.clear();
		store.recordEvent({ taskId: '', kind: 'tool_start', toolName: 'edit_file' });
		assert.deepStrictEqual(store.getRuns(), []);
	});
});
