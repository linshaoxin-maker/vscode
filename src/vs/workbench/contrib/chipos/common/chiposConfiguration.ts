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

		// ── v2: 推理-执行分离架构配置 ──

		'chipos.backend.mode': {
			type: 'string',
			enum: ['local', 'cloud-reasoning', 'manual'],
			enumDescriptions: [
				localize('chipos.backend.mode.local', 'Local: reasoning + execution in one process (dev/debug, or via Remote-SSH)'),
				localize('chipos.backend.mode.cloudReasoning', 'Cloud Reasoning: local execution + cloud reasoning layer'),
				localize('chipos.backend.mode.manual', 'Manual: connect to pre-deployed reasoning/worker URLs'),
			],
			default: 'local',
			description: localize('chipos.backend.mode.desc', 'Backend deployment mode. Remote-SSH is orthogonal — when connected via SSH, "local" mode runs on the remote server.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.reasoningUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.reasoningUrl.desc', 'Reasoning layer URL for remote modes (e.g. https://reasoning.chipos.ai). Leave empty for local mode.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.httpPort': {
			type: 'number',
			default: 8080,
			description: localize('chipos.backend.httpPort.desc', 'HTTP/SSE port for reasoning layer (v2 protocol).'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.grpcAddress': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.grpcAddress.desc', 'gRPC address for Worker to connect to the Reasoning server (e.g. reasoning.chipos.ai:50051). If empty, derived from reasoningUrl host + default port 50051. Only used in cloud-reasoning mode.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.backend.token': {
			type: 'string',
			default: '',
			description: localize('chipos.backend.token.desc', 'JWT token for authenticating with the reasoning layer (cloud-reasoning and manual modes).'),
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
