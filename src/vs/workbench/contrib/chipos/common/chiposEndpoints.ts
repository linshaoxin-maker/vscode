/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized resolution for ChipOS deployment endpoints.
 *
 * Four-tier fallback (highest priority first):
 *   1. runtime overrides (P2-14, IChipOSRuntimeOverridesService) — set by
 *      chipos-remote-ssh after port forwarding; per-window in-memory only,
 *      never persisted to disk. Optional 3rd argument; resolvers still work
 *      without it for callers that don't have access to the service.
 *   2. settings.json     (user explicit override; may also be written by
 *      legacy chipos-remote-ssh builds that pre-date the runtime service)
 *   3. product.json      (build-time injection — see chiposDefaults in product.ts)
 *   4. hardcoded default (dev-mode safety net, e.g. http://127.0.0.1:8080)
 *
 * All consumers (sidecar managers, chat agent, auth service, settings UI hints)
 * MUST go through this module so dev-vs-production behavior stays consistent.
 *
 * Browser context: do NOT import node-only modules here.
 */

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import type { IChipOSRuntimeOverridesService } from './chiposRuntimeOverrides.js';

const SETTING_REASONING_URL = 'chipos.backend.reasoningUrl';
const SETTING_GRPC_ADDRESS = 'chipos.backend.grpcAddress';
const SETTING_WEBSITE_URL = 'chipos.auth.websiteUrl';
const SETTING_WORKER_API_KEY = 'chipos.worker.apiKey';
const SETTING_WORKER_MCP_CONFIG_PATH = 'chipos.worker.mcpConfigPath';
const SETTING_BACKEND_TOKEN = 'chipos.backend.token'; // legacy fallback for worker key
const SETTING_HTTP_PORT = 'chipos.backend.httpPort';
const SETTING_GRPC_PORT = 'chipos.backend.grpcPort';

/**
 * Default worker MCP config path. Uses `~` (not `$HOME`) on purpose — both
 * the remote bash that SSH paths exec into AND the worker's own
 * `Path(...).expanduser()` (see `execution.executor.mcp_loader`) handle `~`,
 * so we can pass the literal string everywhere without per-callsite expansion.
 *
 * Lives under the canonical `~/.chipos/` umbrella alongside `~/.chipos/logs/`
 * and `~/.chipos/instances/`.
 */
export const DEFAULT_WORKER_MCP_CONFIG_PATH = '~/.chipos/mcp_servers.json';

const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_GRPC_PORT = 50051;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Resolve the Reasoner HTTP/SSE URL.
 *
 * In SSH-Remote sessions this is dynamically set by chipos-remote-ssh via
 * the runtime overrides service (P2-14) to a forwarded `127.0.0.1:<random>`
 * URL — that takes precedence over everything else and is per-window so it
 * cannot leak into other windows.
 */
export function resolveReasoningUrl(
	configurationService: IConfigurationService,
	productService: IProductService,
	runtimeOverrides?: IChipOSRuntimeOverridesService,
): string {
	const fromRuntime = runtimeOverrides?.getOverride('reasoningUrl');
	if (fromRuntime) {
		return fromRuntime;
	}
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
 * Resolve the Worker HTTP base URL.
 *
 * Used by the Worker Tools panel and any IDE-side HTTP client that talks to
 * the Worker. Like reasoningUrl, this gets a runtime-override priority for
 * SSH-Remote port forwarding.
 *
 * When neither runtime nor settings provide one, falls back to deriving from
 * `reasoningUrl` host + `workerHttpPort`. The caller (`SidecarManagerElectron`)
 * can override the fallback via its own deployment-mode-aware logic.
 */
export function resolveWorkerHttpUrl(
	configurationService: IConfigurationService,
	productService: IProductService,
	runtimeOverrides?: IChipOSRuntimeOverridesService,
): string | undefined {
	const fromRuntime = runtimeOverrides?.getOverride('workerHttpUrl');
	if (fromRuntime) {
		return fromRuntime.replace(/\/$/, '');
	}
	const fromSettings = configurationService.getValue<string>('chipos.backend.workerHttpUrl');
	if (fromSettings) {
		return fromSettings.replace(/\/$/, '');
	}
	// No explicit value — caller derives from reasoningUrl host + workerHttpPort.
	return undefined;
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

/**
 * Resolve the worker-side MCP servers JSON config path passed via `--mcp-config`.
 *
 * Without this flag the worker falls back to `cwd/mcp_servers.json` (see
 * execution.executor.mcp_loader.resolve_mcp_config_path), and `cwd` for a
 * `setsid`-spawned worker is whatever directory the spawn happened from —
 * usually $HOME for SSH paths or workspaceRoot for local spawns. Both are
 * surprising defaults; users expect a single stable per-host config they can
 * curate.
 *
 * Resolution order:
 *   1. `chipos.worker.mcpConfigPath` setting — explicit override
 *   2. `$HOME/.chipos/mcp_servers.json` — canonical default under the .chipos
 *      umbrella, consistent with `~/.chipos/logs/` and `~/.chipos/instances/`
 *
 * The returned string MAY contain `$HOME` (when defaulting). SSH-Remote callers
 * pass the literal through to a remote bash that expands it. Local callers
 * (chiposRemoteWorkerService node spawn, sidecarManagerElectron IPC) must
 * expand it via `os.homedir()` before `cp.spawn` — see local helper below.
 */
export function resolveWorkerMcpConfigPath(
	configurationService: IConfigurationService,
): string {
	const fromSettings = configurationService.getValue<string>(SETTING_WORKER_MCP_CONFIG_PATH);
	if (fromSettings) {
		return fromSettings;
	}
	return DEFAULT_WORKER_MCP_CONFIG_PATH;
}
