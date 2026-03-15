/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRequestService, isSuccess, asJson } from '../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';

export interface ModelInfo {
	readonly id: string;
	readonly displayName: string;
	readonly description?: string;
}

export interface VerifyResult {
	readonly valid: boolean;
	readonly models?: ModelInfo[];
	readonly error?: string;
}

export const IModelDiscoveryService = createDecorator<IModelDiscoveryService>('modelDiscoveryService');

export interface IModelDiscoveryService {
	readonly _serviceBrand: undefined;
	verifyApiKey(provider: string, apiKey: string, baseUrl?: string): Promise<VerifyResult>;
	fetchModels(provider: string, apiKey: string, baseUrl?: string): Promise<ModelInfo[]>;
}

const PROVIDER_BASE_URLS: Record<string, string> = {
	zhipu: 'https://open.bigmodel.cn/api/paas/v4',
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com',
	deepseek: 'https://api.deepseek.com',
};

const STATIC_FALLBACK_MODELS: Record<string, ModelInfo[]> = {
	zhipu: [
		{ id: 'glm-5', displayName: 'GLM-5' },
		{ id: 'glm-4-plus', displayName: 'GLM-4-Plus' },
		{ id: 'glm-4-flash', displayName: 'GLM-4-Flash' },
		{ id: 'glm-4-flashx', displayName: 'GLM-4-FlashX' },
		{ id: 'glm-4-air', displayName: 'GLM-4-Air' },
		{ id: 'glm-4-airx', displayName: 'GLM-4-AirX' },
		{ id: 'glm-4-long', displayName: 'GLM-4-Long' },
	],
	openai: [
		{ id: 'gpt-4o', displayName: 'GPT-4o' },
		{ id: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
		{ id: 'gpt-4-turbo', displayName: 'GPT-4 Turbo' },
		{ id: 'o3', displayName: 'o3' },
		{ id: 'o3-mini', displayName: 'o3-mini' },
		{ id: 'o4-mini', displayName: 'o4-mini' },
	],
	anthropic: [
		{ id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4' },
		{ id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet' },
		{ id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku' },
		{ id: 'claude-3-opus-20240229', displayName: 'Claude 3 Opus' },
	],
	deepseek: [
		{ id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
		{ id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
	],
};

class ModelDiscoveryService implements IModelDiscoveryService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async verifyApiKey(provider: string, apiKey: string, baseUrl?: string): Promise<VerifyResult> {
		if (!apiKey) {
			return { valid: false, error: 'API key is required' };
		}

		try {
			const models = await this.fetchModels(provider, apiKey, baseUrl);
			return { valid: true, models };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._logService.warn('[ChipOS ModelDiscovery] Verify failed:', message);
			return { valid: false, error: message };
		}
	}

	async fetchModels(provider: string, apiKey: string, baseUrl?: string): Promise<ModelInfo[]> {
		const resolvedBaseUrl = baseUrl || PROVIDER_BASE_URLS[provider] || '';
		if (!resolvedBaseUrl) {
			return STATIC_FALLBACK_MODELS[provider] ?? [];
		}

		try {
			if (provider === 'anthropic') {
				return await this._fetchAnthropicModels(resolvedBaseUrl, apiKey);
			}
			return await this._fetchOpenAICompatibleModels(resolvedBaseUrl, apiKey, provider);
		} catch (err) {
			this._logService.warn('[ChipOS ModelDiscovery] Fetch failed, using fallback:', String(err));
			return STATIC_FALLBACK_MODELS[provider] ?? [];
		}
	}

	private async _fetchOpenAICompatibleModels(baseUrl: string, apiKey: string, provider: string): Promise<ModelInfo[]> {
		const url = `${baseUrl.replace(/\/$/, '')}/models`;
		const context = await this._requestService.request({
			type: 'GET',
			url,
			headers: { 'Authorization': `Bearer ${apiKey}` },
			timeout: 10000,
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(`API returned ${context.res.statusCode}`);
		}

		const data = await asJson<{ data?: Array<{ id: string; owned_by?: string }> }>(context);
		if (!data?.data?.length) {
			return STATIC_FALLBACK_MODELS[provider] ?? [];
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

	private async _fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
		const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
		const context = await this._requestService.request({
			type: 'GET',
			url,
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			timeout: 10000,
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			return STATIC_FALLBACK_MODELS['anthropic'] ?? [];
		}

		const data = await asJson<{ data?: Array<{ id: string; display_name?: string }> }>(context);
		if (!data?.data?.length) {
			return STATIC_FALLBACK_MODELS['anthropic'] ?? [];
		}

		return data.data.map((m: { id: string; display_name?: string }): ModelInfo => ({
			id: m.id,
			displayName: m.display_name || m.id,
		}));
	}
}

registerSingleton(IModelDiscoveryService, ModelDiscoveryService, InstantiationType.Delayed);
