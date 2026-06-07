/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/*
 * Tier-2 executable-hook subprocess child (FEAT, H-3).
 *
 * This file is PLAIN CommonJS and is copied verbatim into out/ to be run via
 * `fork()` in node mode (ELECTRON_RUN_AS_NODE=1). It MUST NOT import any VS Code
 * module: it is the untrusted sandbox in which a consented plugin's hook export
 * runs, isolated from the IDE renderer by a process boundary and an IPC channel.
 *
 * Protocol: the parent sends { evalId, modulePath, exportName, ctx }; we load the
 * module (cached by path), resolve the named export, invoke it with a frozen ctx,
 * and reply { evalId, decision, ... }. Every failure path replies with a "deny"
 * decision so the host fails closed if the plugin throws or the export is bad.
 */

const _cache = new Map();

/**
 * Coerce a plugin hook's return value into the wire decision shape. The decision
 * is clamped to one of deny|ask|amend|proceed (anything else, including undefined,
 * becomes "proceed"); optional fields are forwarded only when well-typed.
 */
function normalize(d) {
	const raw = d && d.decision;
	const decision = (raw === 'deny' || raw === 'ask' || raw === 'amend') ? raw : 'proceed';
	const result = { decision: decision };
	if (d && typeof d.amendedArgs === 'object' && d.amendedArgs !== null) {
		result.amended_args = d.amendedArgs;
	}
	if (d && typeof d.agentMessage === 'string') {
		result.agent_message = d.agentMessage;
	}
	if (d && typeof d.userMessage === 'string') {
		result.user_message = d.userMessage;
	}
	return result;
}

process.on('message', async (msg) => {
	const { evalId, modulePath, exportName, ctx } = msg;
	try {
		let mod = _cache.get(modulePath);
		if (!mod) {
			mod = require(modulePath);
			_cache.set(modulePath, mod);
		}
		const fn = mod && (mod[exportName] || (mod.default && mod.default[exportName]));
		if (typeof fn !== 'function') {
			process.send({ evalId: evalId, decision: 'deny', error: 'export ' + exportName + ' is not a function' });
			return;
		}
		const out = await fn(Object.freeze(ctx));
		process.send(Object.assign({ evalId: evalId }, normalize(out)));
	} catch (e) {
		process.send({ evalId: evalId, decision: 'deny', error: String((e && e.message) || e) });
	}
});
