/*---------------------------------------------------------------------------------------------
 *  FEAT-T10: MCP Client 支持
 *
 *  接入 VSCode 原生 MCP 基础设施，让 ChipOS Agent 可以调用用户配置的外部 MCP Server。
 *  工具调用通过 ToolExecutorRouter 分发。
 *---------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IToolExecutor, IToolCallAction, IToolResultObservation } from './localToolExecutor.js';

/**
 * MCP Server 配置
 */
export interface IMcpServerConfig {
	/** 服务器名称 */
	name: string;
	/** 传输方式: stdio | sse | streamable-http */
	transport: 'stdio' | 'sse' | 'streamable-http';
	/** 命令（stdio 模式） */
	command?: string;
	/** 参数（stdio 模式） */
	args?: string[];
	/** URL（sse / streamable-http 模式） */
	url?: string;
	/** 环境变量 */
	env?: Record<string, string>;
	/** 是否启用 */
	enabled?: boolean;
}

/**
 * MCP 工具信息
 */
export interface IMcpToolInfo {
	name: string;
	description: string;
	inputSchema: any;
	serverName: string;
}

/**
 * MCPToolExecutor — MCP 工具执行器
 *
 * 通过 VSCode 原生 MCP 基础设施调用外部 MCP Server 的工具。
 *
 * 接入方式：
 * 1. 读取用户配置的 MCP Server 列表（settings.json / .vscode/mcp.json）
 * 2. 通过 VSCode 的 IMcpService 连接 MCP Server
 * 3. 发现可用工具并注册到 ToolExecutorRouter
 * 4. 工具调用时通过 MCP 协议转发到对应 Server
 */
export class MCPToolExecutor extends Disposable implements IToolExecutor {
	readonly name = 'mcp';

	private _availableTools: Map<string, IMcpToolInfo> = new Map();
	private _serverConfigs: IMcpServerConfig[] = [];

	constructor() {
		super();
	}

	/**
	 * 初始化：加载 MCP Server 配置并发现工具
	 */
	async initialize(configs: IMcpServerConfig[]): Promise<void> {
		this._serverConfigs = configs.filter(c => c.enabled !== false);

		for (const config of this._serverConfigs) {
			try {
				await this._connectServer(config);
			} catch (e) {
				console.error(`[MCPToolExecutor] Failed to connect to ${config.name}:`, e);
			}
		}
	}

	canHandle(toolName: string): boolean {
		return this._availableTools.has(toolName);
	}

	async execute(action: IToolCallAction): Promise<IToolResultObservation> {
		const toolInfo = this._availableTools.get(action.name);
		if (!toolInfo) {
			return {
				callId: action.callId,
				content: `MCP tool not found: ${action.name}`,
				isError: true,
				toolName: action.name,
			};
		}

		try {
			const args = JSON.parse(action.argsJson);
			const result = await this._callTool(toolInfo.serverName, action.name, args);
			return {
				callId: action.callId,
				content: typeof result === 'string' ? result : JSON.stringify(result),
				isError: false,
				toolName: action.name,
			};
		} catch (e) {
			return {
				callId: action.callId,
				content: `MCP tool error: ${e}`,
				isError: true,
				toolName: action.name,
			};
		}
	}

	/**
	 * 获取所有可用的 MCP 工具
	 */
	getAvailableTools(): IMcpToolInfo[] {
		return Array.from(this._availableTools.values());
	}

	/**
	 * 连接 MCP Server 并发现工具
	 *
	 * 实际实现会通过 VSCode 的 IMcpService 接口。
	 * 当前为骨架实现，FEAT-T13 集成时会接入真实的 MCP 基础设施。
	 */
	private async _connectServer(config: IMcpServerConfig): Promise<void> {
		console.log(`[MCPToolExecutor] Connecting to MCP Server: ${config.name} (${config.transport})`);

		// TODO: 通过 VSCode IMcpService 连接
		// const mcpService = accessor.get(IMcpService);
		// const session = await mcpService.connect(config);
		// const tools = await session.listTools();
		// for (const tool of tools) {
		//     this._availableTools.set(tool.name, { ...tool, serverName: config.name });
		// }
	}

	/**
	 * 调用 MCP 工具
	 */
	private async _callTool(serverName: string, toolName: string, args: any): Promise<any> {
		// TODO: 通过 VSCode IMcpService 调用
		// const mcpService = accessor.get(IMcpService);
		// return await mcpService.callTool(serverName, toolName, args);
		throw new Error(`MCP tool call not yet implemented: ${serverName}/${toolName}`);
	}
}
