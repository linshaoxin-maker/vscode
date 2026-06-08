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
			default: '',
			description: localize('chipos.apiBaseUrl.desc', 'LLM API base URL (required — e.g. https://open.bigmodel.cn/api/paas/v4 for ZhiPu, https://api.deepseek.com for DeepSeek).'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.model': {
			type: 'string',
			default: '',
			description: localize('chipos.model.desc', 'LLM model name (required — e.g. glm-4-flash, deepseek-chat).'),
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
			default: true,
			description: localize('chipos.showThinking.desc', 'Show LLM thinking/reasoning output in chat. When enabled, the reasoning chain renders as a collapsible block above the assistant reply (with the framework chain-line CSS at chat/.../chatThinkingContent.css §221+).'),
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

		// chipos.backend.grpcAddress / token / tlsEnabled used to live here as
		// user-facing settings. They join the seven keys removed above for the
		// same reason: end users should never reason about the deployment
		// topology, the worker's gRPC dial target, the auth-token fallback, or
		// TLS toggles. grpcAddress and tlsEnabled come from product.json (the
		// reasonerGrpcAddress field; TLS implied by https:// scheme on
		// reasoningUrl). token is superseded by OAuth login via the unified
		// auth flow. Code that still calls getValue() on these names continues
		// to work — only Cmd+, search and IntelliSense lose them, which is
		// the goal.

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

		'chipos.rules.agentsMdInterop': {
			type: 'boolean',
			default: true,
			description: localize('chipos.rules.agentsMdInterop.desc', 'Also read AGENTS.md / CLAUDE.md files from the active file up to the workspace root as always-on rules.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.promptResources.enabled': {
			type: 'boolean',
			default: true,
			description: localize('chipos.promptResources.enabled.desc', 'Inject prompt resources (rules and slash commands from .chipos/ and ~/.chipos-ide/) into the agent prompt. Turn off to disable all rule/command injection (rollback / privacy). View what is injected via "ChipOS: Show Prompt Inputs".'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.hooks.executablePlugins': {
			type: 'boolean',
			default: false,
			description: localize('chipos.hooks.executablePlugins.desc', 'Allow installed plugins to run executable hook functions in an isolated subprocess. Off by default; each plugin still requires explicit one-time consent and workspace trust.'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── Resource enable/disable (rules / commands / skills / hooks) ──
		// Each holds scope-qualified ids ("workspace:<name>" / "user:<name>") of
		// resources that stay on disk but are filtered out of the agent's per-turn
		// scan. Managed from the matching settings tab. Mirrors chipos.plugins.disabled.
		'chipos.rules.disabled': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('chipos.rules.disabled.desc', 'Scope-qualified ids ("workspace:<name>"/"user:<name>") of rules that are disabled. A disabled rule stays on disk but is not sent to the agent. Managed from the Rules settings tab.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.commands.disabled': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('chipos.commands.disabled.desc', 'Scope-qualified ids ("workspace:<name>"/"user:<name>") of slash commands that are disabled. A disabled command stays on disk but is not offered to the agent. Managed from the Commands settings tab.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.skills.disabled': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('chipos.skills.disabled.desc', 'Scope-qualified ids ("workspace:<name>"/"user:<name>") of skills that are disabled. A disabled skill stays on disk but is not shown to the agent. Managed from the Skills settings tab.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.skills.maxBodySize': {
			type: 'number',
			default: 102400,
			description: localize('chipos.skills.maxBodySize.desc', 'Maximum byte size of a skill body loaded on demand via read_skill_body. Larger bodies are truncated with a marker. (FEAT-003)'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.hooks.disabled': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('chipos.hooks.disabled.desc', 'Scope-qualified ids ("workspace:<file>"/"user:<file>") of hook files that are disabled. A disabled hook file stays on disk but its hooks are not registered. Managed from the Hooks settings tab.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.mcp.disabled': {
			type: 'object',
			default: {},
			description: localize('chipos.mcp.disabled.desc', 'Disabled worker-side MCP servers, stored as { name: serverConfig }. Disabling a server removes it from the worker (so it stops running) but stashes its config here so it can be re-enabled. Managed from the EDA Tools settings tab.'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── Plugins ──
		'chipos.plugins.disabled': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('chipos.plugins.disabled.desc', 'IDs of installed agent plugins that are disabled. A disabled plugin stays installed under ~/.chipos-ide/plugins/ but does not contribute its rules, commands or skills to the agent. Managed from the Plugins settings tab.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.plugins.allowedGitDomains': {
			type: 'array',
			items: { type: 'string' },
			default: ['github.com'],
			description: localize('chipos.plugins.allowedGitDomains.desc', 'Hostnames an agent plugin may be installed from with "Import Plugin from Git URL…". Only https:// URLs whose host exactly matches an entry are allowed. Defaults to github.com.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.plugins.catalogUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.plugins.catalogUrl.desc', 'Override URL of the agent-plugin catalog (catalog.json) shown in the Plugins tab\'s Browse Catalog list. Empty = derive from the chipos-releases repo.'),
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

		// ── FEAT-X.3.2 — auto-open RTL files created externally ──
		'chipos.editor.autoOpenRtlOnCreate': {
			type: 'boolean',
			default: false,
			description: localize(
				'chipos.editor.autoOpenRtlOnCreate.desc',
				'When enabled, automatically opens newly-created Verilog/SystemVerilog files (.v / .sv / .svh / .vh) as preview tabs. Useful for agent-driven flows where the agent shells out to a template generator instead of using write_file (which already auto-opens). Off by default to avoid pane churn in non-EDA workspaces.'
			),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── Trace upload (T6b ADR-009 §4.2 / T11 opt-out tier 2) ──
		'chipos.trace.uploadEnabled': {
			type: 'boolean',
			default: true,
			description: localize(
				'chipos.trace.uploadEnabled.desc',
				'Upload IDE-side trace events (chat bubble renders, tool calls, errors) to the configured Reasoner at task complete. Reasoner stores them under artifacts/ide/<render-id>/events.jsonl and links to the master trace.jsonl for cross-tier replay. Disable to keep IDE events purely local. Equivalent to env var CHIPOS_TRACE_UPLOAD=0 on reasoner side (which controls worker→reasoner upload).'
			),
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

		// ── Backend (v2 remote-all): IDE → Reasoner connection ──────────────
		// 2026-05-08 wiring fix: these were read by chiposEndpoints / sidecar
		// resolvers but never registered in the schema, so settings.json
		// changes triggered "unknown configuration" warnings and the UI
		// (Settings panel) couldn't surface defaults.
		'chipos.backend.mode': {
			type: 'string',
			enum: ['auto', 'cloud', 'local', 'manual'],
			default: 'auto',
			description: localize('chipos.backend.mode.desc', 'Backend connection mode. auto: detect from chiposDefaults; cloud: always use chiposDefaults.reasoningUrl; local: assume local sidecar; manual: use chipos.backend.reasoningUrl override.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.reasoningUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.reasoningUrl.desc', 'HTTP/SSE URL of the Reasoner (e.g. http://121.89.82.122:8080). Empty falls back to chiposDefaults.reasoningUrl baked into product.json.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.grpcAddress': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.grpcAddress.desc', 'gRPC address of the Reasoner (e.g. 121.89.82.122:50051). Empty falls back to chiposDefaults.reasonerGrpcAddress.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.tlsEnabled': {
			type: 'boolean',
			default: false,
			description: localize('chipos.backend.tlsEnabled.desc', 'Use TLS for the Reasoner gRPC connection.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.token': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.token.desc', 'JWT bearer token for IDE → Reasoner HTTP/SSE auth (issued by chiops). Usually populated automatically after login.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.workerHttpPort': {
			type: 'number',
			default: 8081,
			description: localize('chipos.backend.workerHttpPort.desc', 'DEPRECATED (2026-05-23): worker now uses a kernel-assigned random port written to ~/.chipos/instances/*/instance.json. Setting kept only as fallback during the brief startup window before the first health probe lands. To see the real port: `cat ~/.chipos/instances/*/instance.json | jq .http_port`.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.workerHttpPortRange': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.workerHttpPortRange.desc', 'Bind worker HTTP server in a specific port range "LOW-HIGH" (e.g. "50000-50099"). Use this when your environment requires worker port to be in a firewall whitelist or audited range. Worker tries each port in order; fails loudly if all taken. Empty (default) → kernel-assigned ephemeral port (recommended). Mutually exclusive with chipos.backend.workerHttpPort.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.backend.workerHttpUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.workerHttpUrl.desc', 'Override Worker HTTP URL (e.g. http://127.0.0.1:51234). Empty derives from instance.json (preferred — worker port is kernel-assigned).'),
			scope: ConfigurationScope.APPLICATION,
		},
		'chipos.logLevel': {
			type: 'string',
			enum: ['debug', 'info', 'warn', 'error'],
			default: 'info',
			description: localize('chipos.logLevel.desc', 'IDE-side ChipOS log verbosity (renderer + sidecar manager).'),
			scope: ConfigurationScope.APPLICATION,
		},

		// ── EDA Tool Strategy + Per-Tool Source Overrides ────────────────────
		// Read by worker via /api/v1/eda/resolutions?strategy=... and by IDE
		// "EDA Tools" settings tab. See tool_resolver.py for resolution
		// semantics — 4 strategies × {managed, local-binary, mcp, missing}
		// implementations × user-path overrides per tool.

		'chipos.eda.defaultStrategy': {
			type: 'string',
			enum: ['auto', 'managed-only', 'local-only', 'mcp-first'],
			enumDescriptions: [
				localize('chipos.eda.strategy.auto.desc', 'managed → local-binary → mcp → missing (recommended for ToC personal developers)'),
				localize('chipos.eda.strategy.managedOnly.desc', 'Only ChipOS-managed installs; refuse local + mcp (CI / test environments where deterministic versions matter)'),
				localize('chipos.eda.strategy.localOnly.desc', 'Only system-installed binaries on PATH; ignore managed + mcp (B-2: EDA pre-installed, no auto-download)'),
				localize('chipos.eda.strategy.mcpFirst.desc', 'mcp → managed → local-binary → missing (B-1 company deployment with MCP cluster as primary source)'),
			],
			default: 'auto',
			description: localize('chipos.eda.defaultStrategy.desc', 'Default resolution strategy for EDA tools. Per-tool overrides in chipos.eda.tools.<name>.source take precedence.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.eda.requiredTools': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('chipos.eda.requiredTools.desc',
				'Tools that MUST be resolvable for the worker to start. Used in B2B private deployments — if any listed tool resolves to missing, worker exits with non-zero code instead of starting a half-broken session. Empty array (default) = no requirement.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.eda.tools': {
			type: 'object',
			default: {},
			description: localize('chipos.eda.tools.desc', 'Per-tool implementation source overrides. Each entry is `<tool-name>: { source, path?, mcpServer? }`. source ∈ auto | managed | local | mcp | manual | disabled.'),
			scope: ConfigurationScope.APPLICATION,
			additionalProperties: {
				type: 'object',
				properties: {
					source: {
						type: 'string',
						enum: ['auto', 'managed', 'local', 'mcp', 'manual', 'disabled'],
						description: localize('chipos.eda.tools.source.desc', 'How to obtain this tool. `disabled` = exclude from agent tool registry.'),
					},
					path: {
						type: 'string',
						description: localize('chipos.eda.tools.path.desc', 'Absolute path to the binary (only used when source=local).'),
					},
					mcpServer: {
						type: 'string',
						description: localize('chipos.eda.tools.mcpServer.desc', 'Pin to a specific MCP server name (only used when source=mcp and multiple servers advertise this tool).'),
					},
				},
			},
		},
		// ── Experiments (gated, opt-in only) ──────────────────────────────
		// Phase 0 #8e (ADR-017, PHASE-0-PROTOCOL-SPEC §1.3): when enabled,
		// chat requests bypass the legacy stateful `/api/v1/task` reasoner
		// path and use the new stateless `/api/v1/invoke` endpoint that
		// requires CHIPOS_STATELESS=1 on the reasoner side. Per request:
		// IDE assembles the full conversation from the chat session model,
		// optionally compacts via `/api/v1/compact`, and posts the
		// resulting Anthropic-Messages-shaped payload as a self-contained
		// invoke. The reasoner holds no per-session state.
		//
		// Default off — Phase 1 灰度 will flip per-user / per-org. Old
		// chat path remains the production code path until Phase 4 cleanup.
		'chipos.experiments.statelessReasoner': {
			type: 'boolean',
			default: false,
			description: localize('chipos.experiments.statelessReasoner.desc', 'Experimental: use Phase 0 stateless reasoner code path (ADR-017 C 档). Requires the reasoner deployment to have CHIPOS_STATELESS=1 set. Default off — leaving the legacy stateful path active.'),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});

// ── Native Chat Framework Defaults ─────────────────────────────────────────
// Override defaults for built-in chat settings to provide Cursor-quality UX.
configurationRegistry.registerDefaultConfigurations([{
	overrides: {
		// chat.viewSessions.enabled: in narrow auxiliary-bar layouts (the
		// ChipOS default) `true` forces the sessions sidebar into a stacked
		// layout that occupies the upper half of the chat panel, hiding the
		// welcome banner and the active conversation. The user is then left
		// with a "Search Agents..." list and an isolated chat input at the
		// bottom of the pane. Default to `false` so opening Chat lands on the
		// welcome / active conversation directly; users who want the sessions
		// browser can re-enable it via Settings or the "Toggle Agent Sessions
		// View" command.
		'chat.viewSessions.enabled': false,
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
