/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R26: WorkerToolManager — UI 工具管理面板（骨架）。
 *
 * 通过 HTTP 调用 Worker HTTP API (R24) 查询/管理工具。
 * Worker HTTP 端口通过端口转发 (R23) 映射到本地。
 */

export interface ToolInfo {
	name: string;
	description: string;
	category: string;
	parameters_json_schema: string;
}

export interface ToolStatus {
	installed: boolean;
	path?: string;
	version?: string;
}

export interface McpServerConfig {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface IWorkerToolManagerService {
	readonly _serviceBrand: undefined;
	getTools(): Promise<ToolInfo[]>;
	getToolStatus(toolName: string): Promise<ToolStatus>;
	addMcpServer(config: McpServerConfig): Promise<void>;
}

export class WorkerToolManager implements IWorkerToolManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _workerHttpUrl: string;

	constructor(workerHttpUrl: string = 'http://localhost:8081') {
		this._workerHttpUrl = workerHttpUrl;
	}

	async getTools(): Promise<ToolInfo[]> {
		const resp = await fetch(`${this._workerHttpUrl}/api/v1/tools`);
		if (!resp.ok) {
			throw new Error(`Failed to fetch tools: ${resp.status}`);
		}
		return resp.json();
	}

	async getToolStatus(toolName: string): Promise<ToolStatus> {
		const resp = await fetch(`${this._workerHttpUrl}/api/v1/tools/${encodeURIComponent(toolName)}/status`);
		if (!resp.ok) {
			throw new Error(`Failed to fetch tool status: ${resp.status}`);
		}
		return resp.json();
	}

	async addMcpServer(config: McpServerConfig): Promise<void> {
		const resp = await fetch(`${this._workerHttpUrl}/api/v1/mcp/servers`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(config),
		});
		if (!resp.ok) {
			throw new Error(`Failed to add MCP server: ${resp.status}`);
		}
	}
}
