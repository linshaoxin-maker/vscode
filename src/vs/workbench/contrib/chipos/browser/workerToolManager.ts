/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R26: WorkerToolManager — Worker Tools 面板的数据服务与树视图数据源。
 *
 * 前端通过 Worker HTTP API 直接查询：
 * - 工具列表 / 状态 / 安装
 * - MCP Server 配置列表 / 添加 / 删除
 * - Worker 运行状态摘要
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TreeItemCollapsibleState, type ITreeItem, type ITreeViewDataProvider } from '../../../common/views.js';
import { ISidecarManagerService, SidecarState } from '../common/sidecarService.js';

export interface WorkerHealth {
	status: string;
	tools_count: number;
	revision: number;
	uptime: number;
}

export interface ToolInfo {
	name: string;
	description: string;
	category: string;
	parameters_json_schema: string;
}

export interface ToolStatus {
	installed: boolean;
	registered?: boolean;
	path?: string;
	version?: string;
	category?: string;
	description?: string;
}

export interface InstallResult {
	success: boolean;
	method?: string;
	message?: string;
	error?: string;
}

export interface McpServerConfig {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	transport?: string;
}

export interface McpServerListResult {
	config_path: string;
	servers: McpServerConfig[];
}

export interface McpMutationResult {
	success: boolean;
	server?: string;
	tools_count?: number;
	message?: string;
	error?: string;
}

export interface WorkerRuntimeStatus {
	connected: boolean;
	workspace_root: string;
	running_tasks_count: number;
	pending_observations: number;
	tools_count: number;
	tools_revision: number;
	uptime: number;
}

interface IResolvedToolInfo extends ToolInfo {
	status?: ToolStatus;
}

interface IWorkerSummaryItem extends ITreeItem {
	kind: 'summary';
}

interface IWorkerCategoryItem extends ITreeItem {
	kind: 'category';
	category: string;
	tools: IResolvedToolInfo[];
}

interface IWorkerToolItem extends ITreeItem {
	kind: 'tool';
	tool: IResolvedToolInfo;
}

interface IMcpRootItem extends ITreeItem {
	kind: 'mcp-root';
	servers: McpServerConfig[];
	configPath: string;
}

interface IMcpServerItem extends ITreeItem {
	kind: 'mcp-server';
	server: McpServerConfig;
}

interface IErrorItem extends ITreeItem {
	kind: 'error';
}

const CATEGORY_LABELS: Record<string, string> = {
	builtin: localize('chipos.workerTools.category.builtin', 'Built-in Tools'),
	git: localize('chipos.workerTools.category.git', 'Git Tools'),
	eda: localize('chipos.workerTools.category.eda', 'EDA / MCP Tools'),
};

export const IWorkerToolManagerService = createDecorator<IWorkerToolManagerService>('chiposWorkerToolManagerService');

export interface IWorkerToolManagerService {
	readonly _serviceBrand: undefined;
	readonly workerHttpUrl: string;
	getHealth(): Promise<WorkerHealth>;
	getWorkerStatus(): Promise<WorkerRuntimeStatus>;
	getTools(): Promise<ToolInfo[]>;
	getToolStatus(toolName: string): Promise<ToolStatus>;
	installTool(toolName: string, method?: string): Promise<InstallResult>;
	listMcpServers(): Promise<McpServerListResult>;
	addMcpServer(config: McpServerConfig): Promise<McpMutationResult>;
	removeMcpServer(serverName: string): Promise<McpMutationResult>;
}

export class WorkerToolManagerService extends Disposable implements IWorkerToolManagerService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	get workerHttpUrl(): string {
		return this._sidecarManager.workerHttpUrl.replace(/\/$/, '');
	}

	async getHealth(): Promise<WorkerHealth> {
		return this._requestJson<WorkerHealth>('/health');
	}

	async getWorkerStatus(): Promise<WorkerRuntimeStatus> {
		return this._requestJson<WorkerRuntimeStatus>('/api/v1/worker/status');
	}

	async getTools(): Promise<ToolInfo[]> {
		return this._requestJson<ToolInfo[]>('/api/v1/tools');
	}

	async getToolStatus(toolName: string): Promise<ToolStatus> {
		return this._requestJson<ToolStatus>(`/api/v1/tools/${encodeURIComponent(toolName)}/status`);
	}

	async installTool(toolName: string, method: string = 'auto'): Promise<InstallResult> {
		return this._requestJson<InstallResult>(
			`/api/v1/tools/${encodeURIComponent(toolName)}/install`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ method }),
			},
		);
	}

	async listMcpServers(): Promise<McpServerListResult> {
		return this._requestJson<McpServerListResult>('/api/v1/mcp/servers');
	}

	async addMcpServer(config: McpServerConfig): Promise<McpMutationResult> {
		return this._requestJson<McpMutationResult>('/api/v1/mcp/servers', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(config),
		});
	}

	async removeMcpServer(serverName: string): Promise<McpMutationResult> {
		return this._requestJson<McpMutationResult>(`/api/v1/mcp/servers/${encodeURIComponent(serverName)}`, {
			method: 'DELETE',
		});
	}

	private async _requestJson<T>(path: string, init?: RequestInit): Promise<T> {
		const baseUrl = this.workerHttpUrl;
		if (!baseUrl) {
			throw new Error(localize('chipos.workerTools.urlMissing', 'Worker HTTP URL is not configured.'));
		}

		const response = await fetch(`${baseUrl}${path}`, init);
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			const suffix = body ? ` – ${body}` : '';
			const message = `Worker API ${init?.method ?? 'GET'} ${path} failed (${response.status})${suffix}`;
			this._logService.warn('[ChipOS WorkerTools]', message);
			throw new Error(message);
		}

		return response.json() as Promise<T>;
	}
}

export class WorkerToolsViewDataProvider extends Disposable implements ITreeViewDataProvider {

	private _isEmpty = false;
	private readonly _onDidChangeEmpty = this._register(new Emitter<void>());
	readonly onDidChangeEmpty: Event<void> = this._onDidChangeEmpty.event;

	constructor(
		@IWorkerToolManagerService private readonly _service: IWorkerToolManagerService,
		@ISidecarManagerService private readonly _sidecarManager: ISidecarManagerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	get isTreeEmpty(): boolean {
		return this._isEmpty;
	}

	async getChildren(element?: ITreeItem): Promise<ITreeItem[] | undefined> {
		if (!element) {
			const roots = await this._getRootItems();
			this._setEmpty(roots.length === 0);
			return roots;
		}

		switch ((element as IWorkerSummaryItem | IWorkerCategoryItem | IMcpRootItem | IMcpServerItem | IErrorItem).kind) {
			case 'category':
				return (element as IWorkerCategoryItem).tools.map(tool => this._toToolItem(tool));
			case 'mcp-root':
				return (element as IMcpRootItem).servers.map(server => this._toMcpServerItem(server));
			default:
				return [];
		}
	}

	private async _getRootItems(): Promise<ITreeItem[]> {
		const [healthResult, workerStatusResult, toolsResult, mcpResult] = await Promise.allSettled([
			this._service.getHealth(),
			this._service.getWorkerStatus(),
			this._service.getTools(),
			this._service.listMcpServers(),
		]);

		if (healthResult.status === 'rejected' || toolsResult.status === 'rejected') {
			const reason = healthResult.status === 'rejected' ? healthResult.reason : toolsResult.reason;
			const message = reason instanceof Error ? reason.message : String(reason);
			this._logService.warn('[ChipOS WorkerTools] Failed to build view:', message);
			return [this._toErrorItem(message)];
		}

		const health = healthResult.value;
		const workerStatus = workerStatusResult.status === 'fulfilled' ? workerStatusResult.value : undefined;
		const tools = toolsResult.value;
		const mcp = mcpResult.status === 'fulfilled'
			? mcpResult.value
			: { config_path: '', servers: [] } satisfies McpServerListResult;

		const resolvedTools = await this._resolveToolStatuses(tools);
		const grouped = new Map<string, IResolvedToolInfo[]>();
		for (const tool of resolvedTools) {
			const category = tool.category || 'builtin';
			const bucket = grouped.get(category) ?? [];
			bucket.push(tool);
			grouped.set(category, bucket);
		}

		const roots: ITreeItem[] = [this._toSummaryItem(health, workerStatus)];
		for (const category of ['builtin', 'git', 'eda']) {
			const categoryTools = grouped.get(category);
			if (categoryTools?.length) {
				roots.push(this._toCategoryItem(category, categoryTools));
			}
		}

		if (mcp.servers.length || mcp.config_path) {
			roots.push(this._toMcpRootItem(mcp));
		}

		return roots;
	}

	private async _resolveToolStatuses(tools: ToolInfo[]): Promise<IResolvedToolInfo[]> {
		return Promise.all(tools.map(async tool => {
			if (tool.category !== 'eda') {
				return tool;
			}
			try {
				const status = await this._service.getToolStatus(tool.name);
				return { ...tool, status };
			} catch (error) {
				this._logService.debug('[ChipOS WorkerTools] Tool status fallback:', tool.name, String(error));
				return tool;
			}
		}));
	}

	private _toSummaryItem(health: WorkerHealth, workerStatus: WorkerRuntimeStatus | undefined): IWorkerSummaryItem {
		const connected = workerStatus?.connected ?? this._sidecarManager.state === SidecarState.Connected;
		const connectionText = connected
			? localize('chipos.workerTools.summary.connected', 'connected')
			: localize('chipos.workerTools.summary.disconnected', 'disconnected');
		const description = localize(
			'chipos.workerTools.summary.description',
			'{0} · {1} tools · rev {2}',
			connectionText,
			health.tools_count,
			health.revision,
		);
		const tooltipLines = [
			`${localize('chipos.workerTools.summary.url', 'Worker API')}: ${this._service.workerHttpUrl}`,
			`${localize('chipos.workerTools.summary.tools', 'Tools')}: ${health.tools_count}`,
			`${localize('chipos.workerTools.summary.revision', 'Revision')}: ${health.revision}`,
		];
		if (workerStatus) {
			tooltipLines.push(`${localize('chipos.workerTools.summary.workspace', 'Workspace')}: ${workerStatus.workspace_root || '-'}`);
			tooltipLines.push(`${localize('chipos.workerTools.summary.runningTasks', 'Running tasks')}: ${workerStatus.running_tasks_count}`);
		}
		return {
			kind: 'summary',
			handle: 'worker-status',
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: localize('chipos.workerTools.summary.label', 'Worker Runtime') },
			description,
			tooltip: tooltipLines.join('\n'),
			themeIcon: connected ? Codicon.serverProcess : Codicon.warning,
		};
	}

	private _toCategoryItem(category: string, tools: IResolvedToolInfo[]): IWorkerCategoryItem {
		const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
		return {
			kind: 'category',
			category,
			tools: sorted,
			handle: `worker-category:${category}`,
			collapsibleState: TreeItemCollapsibleState.Collapsed,
			label: { label: CATEGORY_LABELS[category] ?? category },
			description: localize('chipos.workerTools.category.count', '{0} tools', sorted.length),
			themeIcon: category === 'eda' ? Codicon.tools : category === 'git' ? Codicon.sourceControl : Codicon.symbolMethod,
		};
	}

	private _toToolItem(tool: IResolvedToolInfo): IWorkerToolItem {
		const installed = tool.status?.installed;
		const statusText = tool.category === 'eda'
			? installed
				? localize('chipos.workerTools.tool.installed', 'installed')
				: localize('chipos.workerTools.tool.notInstalled', 'not installed')
			: tool.category || 'builtin';
		const tooltipParts = [
			tool.description || tool.name,
			`${localize('chipos.workerTools.tool.category', 'Category')}: ${tool.category}`,
			`${localize('chipos.workerTools.tool.status', 'Status')}: ${statusText}`,
		];
		if (tool.status?.version) {
			tooltipParts.push(`${localize('chipos.workerTools.tool.version', 'Version')}: ${tool.status.version}`);
		}
		if (tool.status?.path) {
			tooltipParts.push(`${localize('chipos.workerTools.tool.path', 'Path')}: ${tool.status.path}`);
		}
		if (tool.parameters_json_schema) {
			tooltipParts.push(`${localize('chipos.workerTools.tool.schema', 'Schema')}: ${tool.parameters_json_schema.slice(0, 200)}`);
		}
		return {
			kind: 'tool',
			tool,
			handle: `worker-tool:${tool.name}`,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: tool.name },
			description: statusText,
			tooltip: tooltipParts.join('\n'),
			themeIcon: installed ? Codicon.check : Codicon.tools,
			contextValue: tool.category === 'eda' && !installed ? 'chiposWorkerToolInstallable' : 'chiposWorkerTool',
		};
	}

	private _toMcpRootItem(result: McpServerListResult): IMcpRootItem {
		const tooltip = result.config_path
			? localize('chipos.workerTools.mcp.tooltip', 'Config file: {0}', result.config_path)
			: localize('chipos.workerTools.mcp.tooltip.empty', 'No MCP config file reported by Worker.');
		return {
			kind: 'mcp-root',
			servers: [...result.servers].sort((a, b) => a.name.localeCompare(b.name)),
			configPath: result.config_path,
			handle: 'worker-mcp-root',
			collapsibleState: result.servers.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
			label: { label: localize('chipos.workerTools.mcp.label', 'MCP Servers') },
			description: localize('chipos.workerTools.mcp.count', '{0} configured', result.servers.length),
			tooltip,
			themeIcon: Codicon.plug,
			command: result.config_path ? {
				id: 'chipos.workerTools.openConfig',
				title: '',
				arguments: [result.config_path],
			} : undefined,
		};
	}

	private _toMcpServerItem(server: McpServerConfig): IMcpServerItem {
		const cmd = [server.command, ...(server.args ?? [])].join(' ').trim();
		return {
			kind: 'mcp-server',
			server,
			handle: `worker-mcp:${server.name}`,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: server.name },
			description: cmd || localize('chipos.workerTools.mcp.emptyCommand', 'stdio'),
			tooltip: [
				`${localize('chipos.workerTools.mcp.command', 'Command')}: ${server.command}`,
				`${localize('chipos.workerTools.mcp.args', 'Args')}: ${(server.args ?? []).join(' ') || '-'}`,
				`${localize('chipos.workerTools.mcp.cwd', 'CWD')}: ${server.cwd || '.'}`,
				`${localize('chipos.workerTools.mcp.env', 'Env')}: ${JSON.stringify(server.env ?? {})}`,
			].join('\n'),
			themeIcon: Codicon.plug,
			contextValue: 'chiposWorkerMcpServer',
		};
	}

	private _toErrorItem(message: string): IErrorItem {
		const target = this._sidecarManager.workerHttpUrl || this._service.workerHttpUrl || 'http://127.0.0.1:8081';
		return {
			kind: 'error',
			handle: 'worker-error',
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: localize('chipos.workerTools.error.label', 'Worker API unavailable') },
			description: target,
			tooltip: `${message}\n${localize('chipos.workerTools.error.hint', 'Open ChipOS Connection Settings to verify backend mode, ports, and manual Worker URL.')}`,
			themeIcon: Codicon.warning,
			command: {
				id: 'chipos.openSettings',
				title: '',
				arguments: ['connection'],
			},
		};
	}

	private _setEmpty(next: boolean): void {
		if (this._isEmpty !== next) {
			this._isEmpty = next;
			this._onDidChangeEmpty.fire();
		}
	}
}

registerSingleton(IWorkerToolManagerService, WorkerToolManagerService, InstantiationType.Delayed);
