/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	ConfigurationScope,
	Extensions as ConfigurationExtensions,
	IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

configurationRegistry.registerConfiguration({
	id: 'chipos',
	order: 1000,
	title: localize('chipos.configuration.title', 'ChipOS'),
	type: 'object',
	properties: {

		'chipos.backendUrl': {
			type: 'string',
			default: 'ws://127.0.0.1:8000/ws/agent',
			description: localize('chipos.backendUrl.desc', 'WebSocket URL of the ChipOS backend agent server.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.apiKey': {
			type: 'string',
			default: '',
			description: localize('chipos.apiKey.desc', 'LLM API key for the configured provider.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.apiBaseUrl': {
			type: 'string',
			default: 'https://open.bigmodel.cn/api/paas/v4',
			description: localize('chipos.apiBaseUrl.desc', 'LLM API base URL.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.model': {
			type: 'string',
			default: 'glm-5',
			description: localize('chipos.model.desc', 'LLM model name.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.provider': {
			type: 'string',
			enum: ['auto', 'openai', 'anthropic', 'zhipu', 'deepseek', 'custom'],
			enumDescriptions: [
				localize('chipos.provider.auto', 'Auto: detect provider from model name (recommended)'),
				localize('chipos.provider.openai', 'OpenAI: OpenAI-compatible API (GPT, etc.)'),
				localize('chipos.provider.anthropic', 'Anthropic: Anthropic native API (Claude models)'),
				localize('chipos.provider.zhipu', 'ZhiPu: ZhiPu AI GLM models (OpenAI-compatible)'),
				localize('chipos.provider.deepseek', 'DeepSeek: DeepSeek models (OpenAI-compatible)'),
				localize('chipos.provider.custom', 'Custom: user-specified API base URL'),
			],
			default: 'zhipu',
			description: localize('chipos.provider.desc', "LLM provider. Use 'zhipu' for ZhiPu GLM, 'openai' for OpenAI, 'deepseek' for DeepSeek, or 'custom' for any OpenAI-compatible endpoint."),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.enableBuiltinTools': {
			type: 'boolean',
			default: true,
			description: localize('chipos.enableBuiltinTools.desc', 'Enable model-native tools (web search, code execution) for supported models.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.autoApproveMode': {
			type: 'string',
			enum: ['strict', 'standard', 'full_auto'],
			enumDescriptions: [
				localize('chipos.autoApproveMode.strict', 'Strict: pause on every Hook'),
				localize('chipos.autoApproveMode.standard', 'Standard: skip quality gates, pause on others (default)'),
				localize('chipos.autoApproveMode.fullAuto', 'Full Auto: auto-approve all skippable Hooks'),
			],
			default: 'standard',
			description: localize('chipos.autoApproveMode.desc', 'Auto-approve mode for Hook confirmations.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.showThinking': {
			type: 'boolean',
			default: false,
			description: localize('chipos.showThinking.desc', 'Show LLM thinking/reasoning output in chat.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.rejectUnauthorized': {
			type: 'boolean',
			default: true,
			description: localize('chipos.rejectUnauthorized.desc', 'Reject unauthorized TLS certificates for wss:// connections.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.dynamicSkill.enabled': {
			type: 'boolean',
			default: true,
			description: localize('chipos.dynamicSkill.enabled.desc', 'Enable dynamic skills: the system automatically extracts coding rules from debug sessions to assist subsequent tasks. Disabling hides the skill panel and stops injecting skill indices into prompts.'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── v2 architecture: backend deployment is fully internal ──
		//
		// The seven keys below (chipos.backend.{mode,developerMode,reasoningUrl,
		// httpPort,grpcPort,workerHttpPort,workerHttpUrl}) used to live here as
		// user-facing settings. They are now intentionally NOT registered in the
		// schema, because users should never have to know they exist:
		//
		//   - reasoningUrl / reasonerGrpcAddress come from product.json's
		//     chiposDefaults (build-time, baked into the binary).
		//   - chipos-remote-ssh installs per-window in-memory runtime overrides
		//     during SSH sessions (chiposRuntimeOverrides.ts).
		//   - The "developer mode" that exposes URL/port editors in the ChipOS
		//     Settings tab is now gated by product.chiposDefaults.developerBuild
		//     (a build-time flag), NOT by a runtime user toggle.
		//
		// Code that needs these values still reads them via
		// configurationService.getValue(...) — VS Code returns whatever is in
		// settings.json (if anything) or undefined. Removing the schema only
		// affects discoverability (Cmd+, search, settings.json IntelliSense),
		// not read/write semantics. Any chipos-internal-build user that needs to
		// set them can still do so by enabling the Developer section of the
		// ChipOS Settings tab in a developerBuild=true binary.

		'chipos.worker.mcpConfigPath': {
			type: 'string',
			default: '',
			// Default empty → resolveWorkerMcpConfigPath() returns ~/.chipos/mcp_servers.json.
			// Set explicitly to override (e.g. for per-machine custom paths or shared configs).
			description: localize('chipos.worker.mcpConfigPath.desc', 'Absolute path to the worker-side MCP servers JSON config (passed to the Worker via --mcp-config). Leave empty for the default ~/.chipos/mcp_servers.json. For SSH-Remote workers this path is resolved on the remote host (use $HOME, not the IDE-side home).'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.grpcAddress': {
			type: 'string',
			default: '',
			// Real architectural setting — Reasoner and Worker are deployed on
			// SEPARATE machines by default. This is the gRPC dial target the
			// spawned Worker uses to reach Reasoner across the network. Only
			// the dev/single-server case can leave this empty (then loopback
			// fallback kicks in).
			description: localize('chipos.backend.grpcAddress.desc', 'gRPC address the spawned Worker should use to dial Reasoner (e.g. `reasoning.chipos.ai:50051`). Required when Reasoner and Worker are on different machines (the default deployment topology). Leave empty for single-machine dev/testing — falls back to product.json injection or 127.0.0.1:50051 loopback.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.token': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.token.desc', '[Legacy fallback] Manual JWT token for authenticating with the reasoning layer. Prefer OAuth login via ChipOS: Login command.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.tlsEnabled': {
			type: 'boolean',
			default: false,
			description: localize('chipos.backend.tlsEnabled.desc', 'Enable TLS for gRPC connections between Worker and Reasoner.'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── Phase 1 Unified Auth ──

		'chipos.auth.websiteUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.auth.websiteUrl.desc', 'ChipOS website URL for OAuth login and token refresh (e.g. http://121.89.82.122:8001). Must be configured explicitly when using unified auth.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.worker.apiKey': {
			type: 'string',
			default: '',
			description: localize('chipos.worker.apiKey.desc', 'Independent API key for Worker → Reasoner gRPC authentication. Separate from user JWT.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.autoContext': {
			type: 'boolean',
			default: true,
			description: localize('chipos.autoContext.desc', 'Automatically collect IDE context (active file, selection, git diff, linter errors, etc.) and send to the backend with each task.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.autoContextTokenBudget': {
			type: 'number',
			default: 8000,
			minimum: 1000,
			maximum: 32000,
			description: localize('chipos.autoContextTokenBudget.desc', 'Maximum token budget for auto-collected context (approximate).'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.contextWindow.fallback': {
			type: 'number',
			default: 128000,
			minimum: 1000,
			description: localize('chipos.contextWindow.fallback.desc', "Fallback context window size (in tokens) used by the chat input's token meter when the backend doesn't report it. Set this to your model's actual context window for accurate percentage display."),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.chatMode': {
			type: 'string',
			enum: ['agent', 'spec'],
			default: 'agent',
			description: localize('chipos.chatMode.desc', "Chat mode: 'agent' for autonomous coding, 'spec' for specification review."),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── Rules ──
		'chipos.rules.globalFile': {
			type: 'string',
			default: '',
			description: localize('chipos.rules.globalFile.desc', 'Path to a global rules file that applies to all projects.'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── Beta Features ──
		'chipos.beta.terminalAgent': {
			type: 'boolean',
			default: false,
			description: localize('chipos.beta.terminalAgent.desc', 'Allow the AI agent to execute commands in the integrated terminal.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.beta.specMode': {
			type: 'boolean',
			default: false,
			description: localize('chipos.beta.specMode.desc', 'Enable Spec Review mode for hardware specification analysis.'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── v1 Legacy (deprecated, kept for backward compatibility) ──
		'chipos.sidecar.autoStart': {
			type: 'boolean',
			default: false,
			description: localize('chipos.sidecar.autoStart.desc', '[Deprecated] Auto-start the v1 Sidecar backend when the IDE launches.'),
			scope: ConfigurationScope.APPLICATION,
			deprecationMessage: localize('chipos.sidecar.autoStart.deprecated', 'v2 backend auto-starts based on chipos.backend.mode.'),
		},

		'chipos.sidecar.autoRestart': {
			type: 'boolean',
			default: true,
			description: localize('chipos.sidecar.autoRestart.desc', '[Deprecated] Auto-restart the v1 Sidecar backend on crash (up to 3 attempts).'),
			scope: ConfigurationScope.APPLICATION,
			deprecationMessage: localize('chipos.sidecar.autoRestart.deprecated', 'v2 backend handles restarts automatically.'),
		},

		'chipos.sidecar.manualUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.sidecar.manualUrl.desc', '[Deprecated] Manual WebSocket URL for v1 sidecar. Use chipos.backend.reasoningUrl instead.'),
			scope: ConfigurationScope.APPLICATION,
			deprecationMessage: localize('chipos.sidecar.manualUrl.deprecated', 'Use chipos.backend.reasoningUrl instead.'),
		},

		'chipos.sidecar.port': {
			type: 'number',
			default: 8765,
			description: localize('chipos.sidecar.port.desc', '[Deprecated] v1 sidecar WebSocket port. Use chipos.backend.httpPort instead.'),
			scope: ConfigurationScope.APPLICATION,
			deprecationMessage: localize('chipos.sidecar.port.deprecated', 'Use chipos.backend.httpPort instead.'),
		},
	},
});

// ── Native Chat Framework Defaults ─────────────────────────────────────────
// Override defaults for built-in chat settings to provide Cursor-quality UX.
configurationRegistry.registerDefaultConfigurations([{
	overrides: {
		'chat.viewSessions.enabled': true,
		'chat.viewSessions.orientation': 'stacked',
		'chat.viewProgressBadge.enabled': true,
		'chat.agent.thinkingStyle': 'animated',
		'chat.agent.thinking.generateTitles': true,
		'chat.tools.autoExpandFailures': true,
		'chat.notifyWindowOnConfirmation': true,
		'chat.agent.codeBlockProgress': true,
		'chat.agent.enabled': true,
	},
}]);
