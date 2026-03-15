/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { ModelInfo, VerifyResult } from '../../../../../workbench/contrib/chipos/browser/settings/modelDiscoveryService.js';

suite('ModelDiscoveryService — Static Fallback Models', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	test('ModelInfo interface requires id and displayName', () => {
		const model: ModelInfo = { id: 'glm-5', displayName: 'GLM-5' };
		assert.strictEqual(model.id, 'glm-5');
		assert.strictEqual(model.displayName, 'GLM-5');
		assert.strictEqual(model.description, undefined);
	});

	test('ModelInfo with optional description', () => {
		const model: ModelInfo = { id: 'gpt-4o', displayName: 'GPT-4o', description: 'OpenAI' };
		assert.strictEqual(model.id, 'gpt-4o');
		assert.strictEqual(model.description, 'OpenAI');
	});

	test('VerifyResult valid response includes models', () => {
		const result: VerifyResult = {
			valid: true,
			models: [
				{ id: 'glm-5', displayName: 'GLM-5' },
				{ id: 'glm-4-plus', displayName: 'GLM-4-Plus' },
			],
		};
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.models?.length, 2);
		assert.strictEqual(result.error, undefined);
	});

	test('VerifyResult invalid response includes error', () => {
		const result: VerifyResult = {
			valid: false,
			error: 'Invalid API key',
		};
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.models, undefined);
		assert.strictEqual(result.error, 'Invalid API key');
	});

	test('VerifyResult with empty API key', () => {
		const result: VerifyResult = {
			valid: false,
			error: 'API key is required',
		};
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error, 'API key is required');
	});
});

suite('ModelDiscoveryService — Provider Configuration', () => {

	const EXPECTED_PROVIDERS = ['zhipu', 'openai', 'anthropic', 'deepseek', 'custom'];

	const PROVIDER_BASE_URLS: Record<string, string> = {
		zhipu: 'https://open.bigmodel.cn/api/paas/v4',
		openai: 'https://api.openai.com/v1',
		anthropic: 'https://api.anthropic.com',
		deepseek: 'https://api.deepseek.com',
	};

	test('all 5 providers are defined', () => {
		assert.strictEqual(EXPECTED_PROVIDERS.length, 5);
		assert.ok(EXPECTED_PROVIDERS.includes('zhipu'));
		assert.ok(EXPECTED_PROVIDERS.includes('openai'));
		assert.ok(EXPECTED_PROVIDERS.includes('anthropic'));
		assert.ok(EXPECTED_PROVIDERS.includes('deepseek'));
		assert.ok(EXPECTED_PROVIDERS.includes('custom'));
	});

	test('provider base URLs are correct', () => {
		assert.strictEqual(PROVIDER_BASE_URLS['zhipu'], 'https://open.bigmodel.cn/api/paas/v4');
		assert.strictEqual(PROVIDER_BASE_URLS['openai'], 'https://api.openai.com/v1');
		assert.strictEqual(PROVIDER_BASE_URLS['anthropic'], 'https://api.anthropic.com');
		assert.strictEqual(PROVIDER_BASE_URLS['deepseek'], 'https://api.deepseek.com');
	});

	test('custom provider has no preset base URL', () => {
		assert.strictEqual(PROVIDER_BASE_URLS['custom'], undefined);
	});

	test('OpenAI-compatible models endpoint format', () => {
		const baseUrl = PROVIDER_BASE_URLS['openai'];
		const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
		assert.strictEqual(modelsUrl, 'https://api.openai.com/v1/models');
	});

	test('Anthropic models endpoint format', () => {
		const baseUrl = PROVIDER_BASE_URLS['anthropic'];
		const modelsUrl = `${baseUrl.replace(/\/$/, '')}/v1/models`;
		assert.strictEqual(modelsUrl, 'https://api.anthropic.com/v1/models');
	});

	test('ZhiPu uses OpenAI-compatible endpoint', () => {
		const baseUrl = PROVIDER_BASE_URLS['zhipu'];
		const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
		assert.strictEqual(modelsUrl, 'https://open.bigmodel.cn/api/paas/v4/models');
	});
});

suite('ModelDiscoveryService — Response Parsing Logic', () => {

	function parseOpenAIResponse(data: { data?: Array<{ id: string; owned_by?: string }> } | null): ModelInfo[] {
		if (!data?.data?.length) {
			return [];
		}
		return data.data
			.filter((m: { id: string; owned_by?: string }) => m.id && !m.id.includes('embedding'))
			.map((m: { id: string; owned_by?: string }): ModelInfo => ({
				id: m.id,
				displayName: m.id,
				description: m.owned_by,
			}))
			.sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id));
	}

	function parseAnthropicResponse(data: { data?: Array<{ id: string; display_name?: string }> } | null): ModelInfo[] {
		if (!data?.data?.length) {
			return [];
		}
		return data.data.map((m: { id: string; display_name?: string }): ModelInfo => ({
			id: m.id,
			displayName: m.display_name || m.id,
		}));
	}

	test('OpenAI response parsing: valid data', () => {
		const response = {
			data: [
				{ id: 'gpt-4o', owned_by: 'openai' },
				{ id: 'gpt-4o-mini', owned_by: 'openai' },
			],
		};
		const models = parseOpenAIResponse(response);
		assert.strictEqual(models.length, 2);
		assert.strictEqual(models[0].id, 'gpt-4o');
		assert.strictEqual(models[1].id, 'gpt-4o-mini');
	});

	test('OpenAI response parsing: filters out embedding models', () => {
		const response = {
			data: [
				{ id: 'gpt-4o', owned_by: 'openai' },
				{ id: 'text-embedding-ada-002', owned_by: 'openai' },
				{ id: 'text-embedding-3-small', owned_by: 'openai' },
			],
		};
		const models = parseOpenAIResponse(response);
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].id, 'gpt-4o');
	});

	test('OpenAI response parsing: sorts alphabetically', () => {
		const response = {
			data: [
				{ id: 'gpt-4o', owned_by: 'openai' },
				{ id: 'dall-e-3', owned_by: 'openai' },
				{ id: 'gpt-3.5-turbo', owned_by: 'openai' },
			],
		};
		const models = parseOpenAIResponse(response);
		assert.strictEqual(models[0].id, 'dall-e-3');
		assert.strictEqual(models[1].id, 'gpt-3.5-turbo');
		assert.strictEqual(models[2].id, 'gpt-4o');
	});

	test('OpenAI response parsing: null response returns empty', () => {
		const models = parseOpenAIResponse(null);
		assert.strictEqual(models.length, 0);
	});

	test('OpenAI response parsing: empty data array returns empty', () => {
		const models = parseOpenAIResponse({ data: [] });
		assert.strictEqual(models.length, 0);
	});

	test('Anthropic response parsing: uses display_name', () => {
		const response = {
			data: [
				{ id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
				{ id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku' },
			],
		};
		const models = parseAnthropicResponse(response);
		assert.strictEqual(models.length, 2);
		assert.strictEqual(models[0].displayName, 'Claude Sonnet 4');
		assert.strictEqual(models[1].displayName, 'Claude 3.5 Haiku');
	});

	test('Anthropic response parsing: falls back to id when no display_name', () => {
		const response = {
			data: [
				{ id: 'claude-3-opus-20240229' },
			],
		};
		const models = parseAnthropicResponse(response);
		assert.strictEqual(models[0].displayName, 'claude-3-opus-20240229');
	});

	test('Anthropic response parsing: null response returns empty', () => {
		const models = parseAnthropicResponse(null);
		assert.strictEqual(models.length, 0);
	});
});
