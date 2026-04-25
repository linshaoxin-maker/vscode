/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized resolution for ChipOS deployment endpoints.
 *
 * Three-tier fallback (highest priority first):
 *   1. settings.json     (user override or chipos-remote-ssh dynamic write)
 *   2. product.json      (build-time injection — see chiposDefaults in product.ts)
 *   3. hardcoded default (dev-mode safety net, e.g. http://127.0.0.1:8080)
 *
 * All consumers (sidecar managers, chat agent, auth service, settings UI hints)
 * MUST go through this module so dev-vs-production behavior stays consistent.
 *
 * Browser context: do NOT import node-only modules here.
 */

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

const SETTING_REASONING_URL = 'chipos.backend.reasoningUrl';
const SETTING_WEBSITE_URL = 'chipos.auth.websiteUrl';
const SETTING_WORKER_API_KEY = 'chipos.worker.apiKey';
const SETTING_BACKEND_TOKEN = 'chipos.backend.token'; // legacy fallback for worker key
const SETTING_HTTP_PORT = 'chipos.backend.httpPort';

const DEFAULT_HTTP_PORT = 8080;

/**
 * Resolve the Reasoner HTTP/SSE URL.
 *
 * In SSH-Remote sessions this is dynamically rewritten by chipos-remote-ssh
 * to a forwarded `127.0.0.1:<random>` URL — that takes precedence over
 * everything else.
 */
export function resolveReasoningUrl(
	configurationService: IConfigurationService,
	productService: IProductService,
): string {
	const fromSettings = configurationService.getValue<string>(SETTING_REASONING_URL);
	if (fromSettings) {
		return fromSettings;
	}
	const fromProduct = productService.chiposDefaults?.reasoningUrl;
	if (fromProduct) {
		return fromProduct;
	}
	const httpPort = configurationService.getValue<number>(SETTING_HTTP_PORT) ?? DEFAULT_HTTP_PORT;
	return `http://127.0.0.1:${httpPort}`;
}

/**
 * Resolve the ChipOS website URL used for OAuth login + token refresh.
 *
 * No localhost fallback: if neither settings nor product.json provide one,
 * return empty string and let the auth service fail-fast with a useful error.
 */
export function resolveWebsiteUrl(
	configurationService: IConfigurationService,
	productService: IProductService,
): string {
	const fromSettings = configurationService.getValue<string>(SETTING_WEBSITE_URL);
	if (fromSettings) {
		return fromSettings;
	}
	return productService.chiposDefaults?.websiteUrl ?? '';
}

/**
 * Resolve the Worker → Reasoner gRPC API key.
 *
 * Priority:
 *   1. `chipos.worker.apiKey`  (preferred)
 *   2. `chipos.backend.token`  (legacy fallback — older deployments stuffed this in)
 *   3. product.json `chiposDefaults.workerApiKey` (build-time injection)
 *   4. empty string (dev/no-auth mode)
 *
 * Note on long-term plan: this should eventually be vended by OAuth login
 * (server-side issuance, short TTL, stored in secret storage). For now it's
 * either user-pasted or build-time baked — both are debt.
 */
export function resolveWorkerApiKey(
	configurationService: IConfigurationService,
	productService: IProductService,
): string {
	const fromSettings = configurationService.getValue<string>(SETTING_WORKER_API_KEY);
	if (fromSettings) {
		return fromSettings;
	}
	const legacy = configurationService.getValue<string>(SETTING_BACKEND_TOKEN);
	if (legacy) {
		return legacy;
	}
	return productService.chiposDefaults?.workerApiKey ?? '';
}
