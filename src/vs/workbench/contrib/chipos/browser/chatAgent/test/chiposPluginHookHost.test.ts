/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChiposPluginHookHost, HookDecision, HookEvalRequest } from '../chiposPluginHookHost.js';
import { IChiposPluginHookService } from '../../../common/chiposPluginHookService.js';
import { IPluginHookDecision, IPluginHookEvalArgs } from '../../../../../../platform/chipos/common/chiposPluginHook.js';

/**
 * Unit tests for {@link ChiposPluginHookHost}. The host is now a thin consent gate
 * in front of {@link IChiposPluginHookService} (the real fork runs in main); these
 * tests use a fake service to drive consent, delegation, and every fail-closed path.
 */
suite('ChiposPluginHookHost', () => {

	class FakeService implements IChiposPluginHookService {
		declare readonly _serviceBrand: undefined;
		readonly calls: IPluginHookEvalArgs[] = [];
		constructor(private readonly _impl: (args: IPluginHookEvalArgs) => Promise<IPluginHookDecision>) { }
		evaluate(args: IPluginHookEvalArgs): Promise<IPluginHookDecision> {
			this.calls.push(args);
			return this._impl(args);
		}
	}

	function makeReq(overrides?: Partial<HookEvalRequest>): HookEvalRequest {
		return {
			evalId: 'e1',
			pluginId: 'plugin-a',
			modulePath: '/plugins/plugin-a/hook.js',
			exportName: 'beforeTool',
			ctx: { tool: 'edit_file', args: { path: 'a.ts' } },
			timeoutMs: 1000,
			failClosed: true,
			...overrides,
		};
	}

	test('no consent → deny (failClosed) without calling the service', async () => {
		const svc = new FakeService(async () => ({ decision: 'proceed' }));
		const host = new ChiposPluginHookHost(svc);

		const decision = await host.evaluate(makeReq());

		assert.deepStrictEqual(
			{ decision: decision.decision, calls: svc.calls.length },
			{ decision: 'deny', calls: 0 },
		);
	});

	test('consented → delegates to the service; forwarded ctx is a clone of the request ctx', async () => {
		const svc = new FakeService(async () => ({ decision: 'deny', agentMessage: 'no' }));
		const host = new ChiposPluginHookHost(svc);
		host.grantConsent('plugin-a');
		const req = makeReq();

		const decision = await host.evaluate(req);

		// Mutating the original ctx AFTER evaluate must not change what was forwarded.
		(req.ctx as { args: { path: string } }).args.path = 'MUTATED-AFTER-SEND.ts';

		assert.deepStrictEqual(
			{ decision, forwardedCtx: svc.calls[0].ctx, forwardedTimeout: svc.calls[0].timeoutMs },
			{
				decision: { decision: 'deny', agentMessage: 'no' } satisfies HookDecision,
				forwardedCtx: { tool: 'edit_file', args: { path: 'a.ts' } },
				forwardedTimeout: 1000,
			},
		);
	});

	test('no service wired (e.g. web) → fail-closed deny', async () => {
		const host = new ChiposPluginHookHost(undefined);
		host.grantConsent('plugin-a');

		const decision = await host.evaluate(makeReq());

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason },
			{ decision: 'deny', reason: 'no hook service' },
		);
	});

	test('service throws → fail-closed deny', async () => {
		const svc = new FakeService(async () => { throw new Error('boom'); });
		const host = new ChiposPluginHookHost(svc);
		host.grantConsent('plugin-a');

		const decision = await host.evaluate(makeReq());

		assert.deepStrictEqual(
			{ decision: decision.decision, reason: decision.reason },
			{ decision: 'deny', reason: 'hook service error' },
		);
	});
});
