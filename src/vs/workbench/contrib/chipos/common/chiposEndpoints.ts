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
const SETTING_GRPC_ADDRESS = 'chipos.backend.grpcAddress';
const SETTING_WEBSITE_URL = 'chipos.auth.websiteUrl';
const SETTING_WORKER_API_KEY = 'chipos.worker.apiKey';
const SETTING_BACKEND_TOKEN = 'chipos.backend.token'; // legacy fallback for worker key
const SETTING_HTTP_PORT = 'chipos.backend.httpPort';
const SETTING_GRPC_PORT = 'chipos.backend.grpcPort';

const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_GRPC_PORT = 50051;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}

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
 * Resolve the gRPC address that a spawned Worker should use to dial Reasoner.
 *
 * **Default architecture is split-machine**: Reasoner is a centralized service
 * (cloud-hosted, shared by many users) and Worker is per-user on their EDA dev
 * box. The Worker dials Reasoner across the network — NOT loopback.
 *
 * `127.0.0.1:50051` only makes sense when both happen to be on the same host
 * (single-server testing, dev). It's the LAST-RESORT fallback here, not the
 * default for production.
 *
 * Resolution order:
 *   1. `chipos.backend.grpcAddress` setting (workspace > user) — explicit override
 *   2. `product.chiposDefaults.reasonerGrpcAddress` — build-time injected default
 *      (this is the production path: deployment ships the centralized
 *      Reasoner gRPC URL)
 *   3. Derive from `chipos.backend.reasoningUrl` IF it's a non-loopback URL.
 *      Useful for cloud-reasoning / manual modes where the user pasted a real
 *      cloud URL into reasoningUrl. NOT useful for chipos-ssh+ flow because
 *      reasoningUrl after SSH forwarding is `127.0.0.1:<random>`.
 *   4. `127.0.0.1:50051` last-resort fallback (single-machine dev/testing).
 *      ⚠️ If your Reasoner is on a different host than your Worker, you MUST
 *      configure step 1 or 2 — loopback won't reach it.
 */
export function resolveReasonerGrpcAddress(
	configurationService: IConfigurationService,
	productService: IProductService,
): string {
	// (1) Explicit setting
	const fromSettings = configurationService.getValue<string>(SETTING_GRPC_ADDRESS);
	if (fromSettings) {
		return fromSettings;
	}
	// (2) Build-time default
	const fromProduct = productService.chiposDefaults?.reasonerGrpcAddress;
	if (fromProduct) {
		return fromProduct;
	}
	// (3) Derive from reasoningUrl when it's clearly a cross-network URL
	const reasoningUrl = configurationService.getValue<string>(SETTING_REASONING_URL);
	const grpcPort = configurationService.getValue<number>(SETTING_GRPC_PORT) ?? DEFAULT_GRPC_PORT;
	if (reasoningUrl) {
		try {
			const url = new URL(reasoningUrl);
			if (!isLoopbackHost(url.hostname)) {
				// HTTPS deployments typically share TLS port for both HTTP and gRPC
				if (url.protocol === 'https:' || url.port === '443') {
					return `${url.hostname}:443`;
				}
				return `${url.hostname}:${grpcPort}`;
			}
		} catch { /* malformed URL — fall through to (4) */ }
	}
	// (4) Last-resort same-machine fallback
	return `127.0.0.1:${grpcPort}`;
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
