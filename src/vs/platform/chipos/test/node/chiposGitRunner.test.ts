/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChiposGitRunner, ExecFileFn } from '../../node/chiposGitRunner.js';

/**
 * Unit tests for {@link ChiposGitRunner} using an INJECTED fake `execFile` — no
 * real git is ever spawned. The fake records the (file, args, options) it was
 * called with and invokes the callback with a canned (error, stdout, stderr), so
 * every result-normalization path (success, ENOENT, timeout/kill, non-zero exit,
 * synchronous throw) is driven deterministically.
 */
suite('ChiposGitRunner', () => {

	interface ICall {
		readonly file: string;
		readonly args: readonly string[];
		readonly options: { cwd?: string; timeout?: number; windowsHide?: boolean; maxBuffer?: number };
	}

	type ExecFileError = Error & { code?: string | number; killed?: boolean };

	/** Build a fake execFile that records calls and replies with the given (error, stdout, stderr). */
	function fakeExecFile(reply: { error?: ExecFileError | null; stdout?: string; stderr?: string }): { fn: ExecFileFn; calls: ICall[] } {
		const calls: ICall[] = [];
		const fn: ExecFileFn = (file, args, options, callback) => {
			calls.push({ file, args, options });
			// Deliver async to model child_process; the runner has already wired the callback.
			queueMicrotask(() => callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? ''));
		};
		return { fn, calls };
	}

	test('runs the git binary with the given argv / cwd / timeout and reports ok on success', async () => {
		const { fn, calls } = fakeExecFile({ stdout: 'abc123 init\n' });
		const runner = new ChiposGitRunner(fn);

		const res = await runner.exec({ args: ['log', '--oneline', '-n', '5'], cwd: '/repo', timeoutMs: 5000 });

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].file, 'git');
		assert.deepStrictEqual(calls[0].args, ['log', '--oneline', '-n', '5']);
		assert.strictEqual(calls[0].options.cwd, '/repo');
		assert.strictEqual(calls[0].options.timeout, 5000);
		assert.strictEqual(calls[0].options.windowsHide, true);
		assert.deepStrictEqual(
			{ ok: res.ok, stdout: res.stdout, code: res.code, killed: res.killed },
			{ ok: true, stdout: 'abc123 init\n', code: 0, killed: false },
		);
	});

	test('maps a missing-git ENOENT into ok:false with code ENOENT', async () => {
		const err: ExecFileError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
		const runner = new ChiposGitRunner(fakeExecFile({ error: err }).fn);

		const res = await runner.exec({ args: ['clone', '--', 'https://x/y.git', '/d'] });

		assert.deepStrictEqual(
			{ ok: res.ok, code: res.code, killed: res.killed },
			{ ok: false, code: 'ENOENT', killed: false },
		);
	});

	test('surfaces a killed/timed-out invocation as killed:true', async () => {
		const err: ExecFileError = Object.assign(new Error('timed out'), { killed: true, code: null as unknown as number });
		const runner = new ChiposGitRunner(fakeExecFile({ error: err }).fn);

		const res = await runner.exec({ args: ['clone', '--', 'https://x/y.git', '/d'], timeoutMs: 1 });

		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.killed, true);
	});

	test('surfaces a non-zero git exit with its exit code and stderr', async () => {
		const err: ExecFileError = Object.assign(new Error('exit 128'), { code: 128 });
		const runner = new ChiposGitRunner(fakeExecFile({ error: err, stderr: 'fatal: not a git repository' }).fn);

		const res = await runner.exec({ args: ['diff', '--numstat', 'HEAD'], cwd: '/not-a-repo' });

		assert.deepStrictEqual(
			{ ok: res.ok, code: res.code, stderr: res.stderr },
			{ ok: false, code: 128, stderr: 'fatal: not a git repository' },
		);
	});

	test('never rejects when execFile throws synchronously — resolves ok:false', async () => {
		const throwing: ExecFileFn = () => { throw new Error('bad options'); };
		const runner = new ChiposGitRunner(throwing);

		const res = await runner.exec({ args: ['status'] });

		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.killed, false);
		assert.match(res.stderr, /bad options/);
	});
});
