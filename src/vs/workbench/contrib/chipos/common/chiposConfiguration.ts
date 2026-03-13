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
			description: localize('chipos.apiKey.desc', 'LLM API key (e.g. DeepSeek, OpenAI).'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.apiBaseUrl': {
			type: 'string',
			default: 'https://api.deepseek.com',
			description: localize('chipos.apiBaseUrl.desc', 'LLM API base URL.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.model': {
			type: 'string',
			default: 'deepseek-chat',
			description: localize('chipos.model.desc', 'LLM model name.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.provider': {
			type: 'string',
			enum: ['auto', 'openai', 'anthropic'],
			enumDescriptions: [
				localize('chipos.provider.auto', 'Auto: detect provider from model name (recommended)'),
				localize('chipos.provider.openai', 'OpenAI: OpenAI-compatible API (DeepSeek, GPT, etc.)'),
				localize('chipos.provider.anthropic', 'Anthropic: Anthropic native API (Claude models, enables web_search/code_execution)'),
			],
			default: 'auto',
			description: localize('chipos.provider.desc', "LLM provider. 'auto' detects from model name."),
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

		'chipos.sidecar.autoStart': {
			type: 'boolean',
			default: false,
			description: localize('chipos.sidecar.autoStart.desc', 'Automatically start the Sidecar backend on IDE launch. When disabled, connect to a manually started backend using backendUrl.'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.sidecar.port': {
			type: 'number',
			default: 8765,
			description: localize('chipos.sidecar.port.desc', 'Starting port for the Sidecar backend (auto-increments if occupied).'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.sidecar.manualUrl': {
			type: 'string',
			default: '',
			description: localize('chipos.sidecar.manualUrl.desc', 'Manual WebSocket URL for development mode. When set, Sidecar auto-start is bypassed and the IDE connects directly to this URL. Example: ws://127.0.0.1:8000/ws/agent'),
			scope: ConfigurationScope.APPLICATION,
		},

		'chipos.sidecar.autoRestart': {
			type: 'boolean',
			default: true,
			description: localize('chipos.sidecar.autoRestart.desc', 'Automatically restart the Sidecar backend if it crashes (up to 3 attempts).'),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});
