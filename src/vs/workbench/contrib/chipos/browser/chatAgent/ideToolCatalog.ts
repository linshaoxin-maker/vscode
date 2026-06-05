/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for the FEAT-007 IDE-side MCP tool path. The real implementation
 * lives inline in chipOSChatAgent.ts using VS Code's native IMcpService (NOT the
 * dead `execution/mcpToolExecutor.ts` skeleton the old spec referenced). These
 * functions hold the MCP catalog-tagging and result-shaping logic so it is
 * unit-testable without the chat agent's DI graph: the caller enumerates
 * `IMcpService` and passes the flattened tool list / raw call result here.
 */

import { ToolDefinition } from './statelessInvoke/types.js';

/** A normalized IDE-side MCP tool (from VS Code IMcpService) for catalog building. */
export interface IdeMcpToolInfo {
	readonly name: string;
	readonly description?: string;
	/** Parsed JSON Schema dict from IMcpService; defaulted to an empty object schema. */
	readonly inputSchema?: unknown;
}

/** The part of an IMcpService `tool.call()` result the reverse channel forwards. */
export interface McpToolCallResult {
	readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
	readonly isError?: boolean;
}

/**
 * Map user-installed MCP server tools (VS Code IMcpService) to the Phase-1
 * `ToolDefinition` shape, tagged `ide_mcp`. Each tool's parsed JSON Schema is
 * passed through (empty object schema when absent) and a missing description
 * becomes the empty string — matching what the reasoner catalog expects.
 */
export function buildIdeMcpTools(mcpTools: ReadonlyArray<IdeMcpToolInfo>): ToolDefinition[] {
	return mcpTools.map(tool => ({
		name: tool.name,
		description: tool.description || '',
		// IMcpService delivers a parsed JSON Schema dict already.
		input_schema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
		chipos_source: 'ide_mcp',
	}));
}

/**
 * Shape an IMcpService `tool.call()` success result into the `{content,isError}`
 * the reverse channel posts back: join the text content parts, falling back to
 * the raw JSON when there is no text part.
 */
export function shapeMcpToolResult(result: McpToolCallResult): { content: string; isError: boolean } {
	const textParts = (result.content || []).filter(c => c.type === 'text').map(c => c.text ?? '');
	return {
		content: textParts.join('\n') || JSON.stringify(result),
		isError: !!result.isError,
	};
}
