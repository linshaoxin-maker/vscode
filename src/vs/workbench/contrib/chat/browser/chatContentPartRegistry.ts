/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  Registry for custom chat content part renderers.
 *  Allows ChipOS (and future extensions) to register content part renderers
 *  without modifying the core chatListRenderer.ts switch-case.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatContentPart, IChatContentPartRenderContext } from './widget/chatContentParts/chatContentParts.js';
import { IChatRendererContent } from '../common/model/chatViewModel.js';

export const IChatContentPartRegistry = createDecorator<IChatContentPartRegistry>('chatContentPartRegistry');

/**
 * Factory function that creates a content part for a given content kind.
 * Returns undefined if the factory cannot handle the content.
 *
 * `context` (the render context for this row) is optional so existing factories
 * can ignore it; parts that need the owning chat session / response element
 * (e.g. the Spec Review card's Build button, which re-enters the agent) read it.
 */
export type ChatContentPartFactory = (content: IChatRendererContent, instantiationService: IInstantiationService, context?: IChatContentPartRenderContext) => IChatContentPart | undefined;

export interface IChatContentPartRegistry {
	readonly _serviceBrand: undefined;

	/**
	 * Register a content part factory for a specific kind.
	 * @param kind The content kind string (e.g. 'edaSimReport')
	 * @param factory Factory function to create the content part
	 */
	registerContentPart(kind: string, factory: ChatContentPartFactory): void;

	/**
	 * Try to create a content part for the given content.
	 * Returns undefined if no factory is registered for the content's kind.
	 */
	tryCreateContentPart(content: IChatRendererContent, instantiationService: IInstantiationService, context?: IChatContentPartRenderContext): IChatContentPart | undefined;

	/**
	 * Check if a factory is registered for the given kind.
	 */
	hasContentPart(kind: string): boolean;
}

export class ChatContentPartRegistry implements IChatContentPartRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _factories = new Map<string, ChatContentPartFactory>();

	registerContentPart(kind: string, factory: ChatContentPartFactory): void {
		this._factories.set(kind, factory);
	}

	tryCreateContentPart(content: IChatRendererContent, instantiationService: IInstantiationService, context?: IChatContentPartRenderContext): IChatContentPart | undefined {
		const factory = this._factories.get(content.kind);
		if (factory) {
			return factory(content, instantiationService, context);
		}
		return undefined;
	}

	hasContentPart(kind: string): boolean {
		return this._factories.has(kind);
	}
}
