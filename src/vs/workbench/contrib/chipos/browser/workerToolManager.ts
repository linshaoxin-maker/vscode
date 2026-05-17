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
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
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
	method?: 'eda_pack' | 'elan' | 'docker' | 'verible_brew' | 'manual_vendor' | 'pip' | 'apt' | 'conda' | string;
	message?: string;
	error?: string;
	// 2026-05-15: backend install_binary 路由返的扩展字段, IDE 用来显示更精准引导.
	/** install_mcp_tool 聚合: 成功安装的 binary 列表. */
	installed?: string[];
	/** install_mcp_tool 聚合: 失败的 binary 详情 (含 method / vendor_url). */
	failed?: Array<{ binary: string; method?: string; error?: string; vendor_url?: string; instructions?: string; manual_required?: boolean }>;
	/** install_binary manual_vendor 路由 (vivado/quartus) 标记 — IDE 应弹引导. */
	manual_required?: boolean;
	/** Vendor 厂商下载页面 URL (Xilinx / Intel). */
	vendor_url?: string;
	/** 多步操作指引 (manual_vendor / Linux elan 等). */
	instructions?: string;
}

/**
 * P0 UX #11: 4 distinct MCP server health states the IDE can render with
 * different icon + color, populated by the worker's background health probe
 * (lifecycle.py `_health_probe_loop`).
 */
export type McpServerHealthStatus = 'connected' | 'no_tools' | 'handshake_failed' | 'unreachable' | 'unknown';

export interface McpServerHealth {
	status: McpServerHealthStatus;
	last_check?: number;
	latency_ms?: number;
	error?: string;
	provides_count?: number;
}

export interface McpServerConfig {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	transport?: string;
	/**
	 * Auto-discovered EDA tool names this server advertises via the MCP
	 * `tools/list` RPC. Populated by lifecycle.list_mcp_servers using
	 * mcp_loader.group_tools_by_server on the live ManagedMcpTool list.
	 * Empty array = no discovery data yet (server not loaded or runtime
	 * getter not wired). UI uses this to render
	 *   "company-eda-cluster · provides 3 tools: vivado, quartus_sh, fpga_program"
	 */
	provides?: string[];
	/**
	 * Cached health probe result — last 60s. `status` distinguishes:
	 *   connected       — handshake OK + ≥1 tool advertised (green ✓)
	 *   no_tools        — handshake OK but tools/list empty (yellow ⚠)
	 *   handshake_failed — process spawned but MCP handshake failed (red ✗)
	 *   unreachable     — couldn't spawn / network refused (red ✗)
	 *   unknown         — probe hasn't run yet / probe disabled (gray ?)
	 */
	health?: McpServerHealth;
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

/** Result of a live ping (test) against an MCP server. */
export interface McpTestResult {
	success: boolean;
	provides?: string[];
	latency_ms?: number;
	error?: string;
	code?: 'missing_dep' | 'unknown_server' | 'invalid_config' | 'handshake_failed' | string;
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

/**
 * Per-tool implementation resolution — the 4-impl abstraction returned by
 * `/api/v1/eda/resolutions`. Each EDA tool is resolved to exactly one
 * implementation (managed / local-binary / mcp / missing), with optional
 * `alternatives` listing fallback impls the user could switch to (rendered
 * as "Connect MCP instead" / "Switch to managed" buttons in the panel).
 */
export type EdaImplKind = 'managed' | 'local-binary' | 'mcp' | 'missing';

export interface EdaToolResolution {
	tool_name: string;
	impl: EdaImplKind;
	ready: boolean;
	/** impl-specific shape:
	 *   managed     → { path, source: 'managed' }
	 *   local-binary → { path, source: 'PATH' | 'known_location' | 'user_override' }
	 *   mcp         → { server_name, all_servers: string[] }
	 *   missing     → { hint?: string, source?: string }
	 */
	detail: {
		path?: string;
		source?: string;
		server_name?: string;
		all_servers?: string[];
		hint?: string;
		version?: string;
	};
	alternatives: EdaImplKind[];
}

export interface EdaResolutionsResponse {
	strategy: string;
	by_tool: Record<string, EdaToolResolution>;
	summary: { ready: number; missing: number; total: number };
}

/** Aggregate EDA tool installation status — for IDE status bar. */
export interface EdaStatusSummary {
	total_mcp_tools: number;
	installed_mcp_tools: number;
	missing_mcp_tools: number;
	missing_binaries: string[];
	by_binary: Record<string, {
		installed: boolean;
		path: string;
		version: string;
		source: 'PATH' | 'known_location' | 'not_found';
		affects: string[];
		install_method: 'eda_pack' | 'elan' | 'docker' | 'verible_brew' | 'manual_vendor' | 'unknown';
	}>;
	summary_line: string;
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

/**
 * One root node per implementation kind (managed / mcp / local-binary / missing).
 * Children = the tools resolved to that impl. Replaces the old
 * "EDA / MCP Tools" single category that lumped everything together and made
 * 24 red rows when nothing was installed.
 */
interface IImplGroupItem extends ITreeItem {
	kind: 'impl-group';
	impl: EdaImplKind;
	/** Tools resolved to this impl; for `mcp` impl this is across all servers. */
	resolutions: EdaToolResolution[];
}

interface IImplToolItem extends ITreeItem {
	kind: 'impl-tool';
	resolution: EdaToolResolution;
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
	getEdaStatusSummary(): Promise<EdaStatusSummary>;
	getEdaToolResolutions(strategy?: string, userPathOverrides?: Record<string, string>): Promise<EdaResolutionsResponse>;
	installTool(toolName: string, method?: string): Promise<InstallResult>;
	listMcpServers(): Promise<McpServerListResult>;
	addMcpServer(config: McpServerConfig): Promise<McpMutationResult>;
	removeMcpServer(serverName: string): Promise<McpMutationResult>;
	testMcpServer(serverName: string): Promise<McpTestResult>;
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

	async getEdaStatusSummary(): Promise<EdaStatusSummary> {
		return this._requestJson<EdaStatusSummary>('/api/v1/eda/status');
	}

	async getEdaToolResolutions(strategy: string = 'auto', userPathOverrides?: Record<string, string>): Promise<EdaResolutionsResponse> {
		// Two transports:
		//   - GET (no overrides): cheap, idempotent, cacheable. Used for
		//     panel refresh + status bar polling.
		//   - POST (with overrides): when EdaToolsTab needs to honor
		//     `chipos.eda.tools.<name>.path` user settings, body carries the
		//     overrides dict so resolver picks them as highest-priority impl.
		// Both routes return the same JSON shape (EdaResolutionsResponse).
		if (userPathOverrides && Object.keys(userPathOverrides).length > 0) {
			return this._requestJson<EdaResolutionsResponse>('/api/v1/eda/resolutions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ strategy, user_path_overrides: userPathOverrides }),
			});
		}
		const q = encodeURIComponent(strategy);
		return this._requestJson<EdaResolutionsResponse>(`/api/v1/eda/resolutions?strategy=${q}`);
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

	async testMcpServer(serverName: string): Promise<McpTestResult> {
		return this._requestJson<McpTestResult>(`/api/v1/mcp/servers/${encodeURIComponent(serverName)}/test`, {
			method: 'POST',
		});
	}

	private async _requestJson<T>(path: string, init?: RequestInit): Promise<T> {
		const baseUrl = this.workerHttpUrl;
		if (!baseUrl) {
			throw new Error(localize('chipos.workerTools.urlMissing', 'Worker HTTP URL is not configured.'));
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8000);
		try {
			const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
			clearTimeout(timeout);
			if (!response.ok) {
				const body = await response.text().catch(() => '');
				const suffix = body ? ` – ${body}` : '';
				const message = `Worker API ${init?.method ?? 'GET'} ${path} failed (${response.status})${suffix}`;
				this._logService.warn('[ChipOS WorkerTools]', message);
				throw new Error(message);
			}

			return response.json() as Promise<T>;
		} catch (err) {
			clearTimeout(timeout);
			throw err;
		}
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

		switch ((element as IWorkerSummaryItem | IWorkerCategoryItem | IImplGroupItem | IMcpRootItem | IMcpServerItem | IErrorItem).kind) {
			case 'category':
				return (element as IWorkerCategoryItem).tools.map(tool => this._toToolItem(tool));
			case 'impl-group':
				return (element as IImplGroupItem).resolutions.map(r => this._toImplToolItem(r));
			case 'mcp-root':
				return (element as IMcpRootItem).servers.map(server => this._toMcpServerItem(server));
			default:
				return [];
		}
	}

	private async _getRootItems(): Promise<ITreeItem[]> {
		const [healthResult, workerStatusResult, toolsResult, mcpResult, resolutionsResult] = await Promise.allSettled([
			this._service.getHealth(),
			this._service.getWorkerStatus(),
			this._service.getTools(),
			this._service.listMcpServers(),
			// 新: 4-impl 解析视图. 失败时降级 (没有 impl 分组就只显示 non-EDA categories)
			this._service.getEdaToolResolutions('auto'),
		]);

		if (healthResult.status === 'rejected' || toolsResult.status === 'rejected') {
			const reason = healthResult.status === 'rejected'
				? healthResult.reason
				: (toolsResult as PromiseRejectedResult).reason;
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
		const resolutions = resolutionsResult.status === 'fulfilled' ? resolutionsResult.value : undefined;
		if (resolutionsResult.status === 'rejected') {
			this._logService.warn('[ChipOS WorkerTools] EDA resolutions failed (legacy view kept):', String((resolutionsResult as PromiseRejectedResult).reason));
		}

		// Non-EDA tools (builtin / git) keep the old category grouping — they
		// don't have an "implementation source" abstraction (a builtin tool is
		// just a builtin tool, no managed/mcp alternative).
		const nonEdaResolved = await this._resolveToolStatuses(tools.filter(t => t.category !== 'eda'));
		const groupedNonEda = new Map<string, IResolvedToolInfo[]>();
		for (const tool of nonEdaResolved) {
			const category = tool.category || 'builtin';
			const bucket = groupedNonEda.get(category) ?? [];
			bucket.push(tool);
			groupedNonEda.set(category, bucket);
		}

		const roots: ITreeItem[] = [this._toSummaryItem(health, workerStatus, resolutions)];

		// EDA tools: replace single "EDA" category with 4 impl-groups.
		// Order: managed → mcp → local → builtin/git → MCP Servers → missing
		// (P0 UX #3: missing moved AFTER builtin/git so 28 yellow ⚠ rows
		// aren't the first thing the user sees on launch).
		if (resolutions) {
			const groups = this._groupByImpl(resolutions);
			for (const impl of ['managed', 'mcp', 'local-binary'] as EdaImplKind[]) {
				const bucket = groups.get(impl) ?? [];
				if (bucket.length > 0) {
					roots.push(this._toImplGroupItem(impl, bucket));
				}
			}
		} else {
			// Fallback: resolutions API failed (old worker without endpoint).
			// Render EDA as a single legacy category so panel isn't blank.
			const edaTools = tools.filter(t => t.category === 'eda');
			if (edaTools.length) {
				const resolved = await this._resolveToolStatuses(edaTools);
				roots.push(this._toCategoryItem('eda', resolved));
			}
		}

		// builtin / git groups
		for (const category of ['builtin', 'git']) {
			const categoryTools = groupedNonEda.get(category);
			if (categoryTools?.length) {
				roots.push(this._toCategoryItem(category, categoryTools));
			}
		}

		if (mcp.servers.length || mcp.config_path) {
			roots.push(this._toMcpRootItem(mcp));
		}

		// P0 UX #3: missing tools group rendered LAST (after MCP Servers).
		// 28 yellow ⚠ rows shouldn't dominate the user's first impression —
		// they're informational, not blocking, and the user often only needs
		// 3-5 of them.
		if (resolutions) {
			const missingBucket = this._groupByImpl(resolutions).get('missing') ?? [];
			if (missingBucket.length > 0) {
				roots.push(this._toImplGroupItem('missing', missingBucket));
			}
		}

		return roots;
	}

	private _groupByImpl(resolutions: EdaResolutionsResponse): Map<EdaImplKind, EdaToolResolution[]> {
		const out = new Map<EdaImplKind, EdaToolResolution[]>();
		for (const r of Object.values(resolutions.by_tool)) {
			const bucket = out.get(r.impl) ?? [];
			bucket.push(r);
			out.set(r.impl, bucket);
		}
		for (const list of out.values()) {
			list.sort((a, b) => a.tool_name.localeCompare(b.tool_name));
		}
		return out;
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

	private _toSummaryItem(health: WorkerHealth, workerStatus: WorkerRuntimeStatus | undefined, resolutions: EdaResolutionsResponse | undefined): IWorkerSummaryItem {
		const connected = workerStatus?.connected ?? this._sidecarManager.state === SidecarState.Connected;
		const connectionText = connected
			? localize('chipos.workerTools.summary.connected', 'connected')
			: localize('chipos.workerTools.summary.disconnected', 'disconnected');
		// Prefer the resolutions API "ready/total" if available (more meaningful
		// than raw tools_count — tells the user 18/24 EDA things actually work).
		// UX #5: shortest possible label so it doesn't truncate in narrow aux bars.
		const readyText = resolutions
			? localize('chipos.workerTools.summary.readyShort', '{0}/{1}', resolutions.summary.ready, resolutions.summary.total)
			: localize('chipos.workerTools.summary.toolsCount', '{0} tools', health.tools_count);
		const description = localize(
			'chipos.workerTools.summary.description.v3',
			'{0} · {1}',
			connectionText,
			readyText,
		);
		const tooltipLines = [
			`${localize('chipos.workerTools.summary.url', 'Worker API')}: ${this._service.workerHttpUrl}`,
			`${localize('chipos.workerTools.summary.tools', 'Tools')}: ${health.tools_count}`,
			`${localize('chipos.workerTools.summary.revision', 'Revision')}: ${health.revision}`,
		];
		if (resolutions) {
			tooltipLines.push(`${localize('chipos.workerTools.summary.strategy', 'EDA strategy')}: ${resolutions.strategy}`);
			tooltipLines.push(`${localize('chipos.workerTools.summary.edaReady', 'EDA ready')}: ${resolutions.summary.ready}/${resolutions.summary.total}`);
		}
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

	private _toImplGroupItem(impl: EdaImplKind, resolutions: EdaToolResolution[]): IImplGroupItem {
		// Group labels chosen to match the 4-impl product story.
		// User-facing copy refers to "ChipOS Managed", "Connected via MCP",
		// "Local installed", "Missing" — the same wording as the install guides
		// + chiposContribution.ts notifications.
		const labels: Record<EdaImplKind, string> = {
			'managed':      localize('chipos.workerTools.impl.managed', 'ChipOS Managed'),
			'mcp':          localize('chipos.workerTools.impl.mcp', 'Connected via MCP'),
			'local-binary': localize('chipos.workerTools.impl.local', 'Local installed'),
			'missing':      localize('chipos.workerTools.impl.missing', 'Not configured'),
		};
		const icons: Record<EdaImplKind, ThemeIcon> = {
			'managed':      Codicon.cloudDownload,   // ChipOS-managed = we downloaded it
			'mcp':          Codicon.plug,            // remote MCP server
			'local-binary': Codicon.deviceDesktop,   // local install on this machine
			// P0 UX #3: demoted from Codicon.warning (yellow ⚠) to circle
			// slash (neutral gray). 28 missing tools shouldn't read as
			// errors — they're "tools the user could install if they want".
			'missing':      Codicon.circleSlash,
		};
		const readyCount = resolutions.filter(r => r.ready).length;
		const description = localize(
			'chipos.workerTools.impl.count',
			'{0}/{1}',
			readyCount,
			resolutions.length,
		);
		return {
			kind: 'impl-group',
			impl,
			resolutions,
			handle: `impl-group:${impl}`,
			collapsibleState: TreeItemCollapsibleState.Collapsed,
			label: { label: labels[impl] },
			description,
			themeIcon: icons[impl],
			contextValue: `chiposImplGroup:${impl}`,
		};
	}

	private _toImplToolItem(r: EdaToolResolution): IImplToolItem {
		// Per-tool action affordances vary by impl — encoded in contextValue
		// so menus contributed in package.json can show "Auto install" for
		// missing, "Test" for local-binary, "Reconnect" for mcp, etc.
		const ctxValue = r.ready ? `chiposImplTool:${r.impl}:ready` : `chiposImplTool:${r.impl}:missing`;
		const description = r.impl === 'mcp' && r.detail.server_name
			? localize('chipos.workerTools.implTool.viaServer', 'via {0}', r.detail.server_name)
			: r.detail.path
				? this._middleTruncate(r.detail.path, 50)  // UX #6: keep prefix+suffix
				: r.ready
					? localize('chipos.workerTools.implTool.ready', 'ready')
					: localize('chipos.workerTools.implTool.notReady', 'missing');

		const tooltipLines = [`${r.tool_name}`];
		if (r.detail.path) {
			tooltipLines.push(`${localize('chipos.workerTools.tool.path', 'Path')}: ${r.detail.path}`);
		}
		if (r.detail.server_name) {
			tooltipLines.push(`${localize('chipos.workerTools.tool.mcpServer', 'MCP server')}: ${r.detail.server_name}`);
			if (r.detail.all_servers && r.detail.all_servers.length > 1) {
				tooltipLines.push(`${localize('chipos.workerTools.tool.mcpAlt', 'Also available on')}: ${r.detail.all_servers.slice(1).join(', ')}`);
			}
		}
		if (r.detail.version) {
			tooltipLines.push(`${localize('chipos.workerTools.tool.version', 'Version')}: ${r.detail.version}`);
		}
		if (r.detail.hint) {
			tooltipLines.push(`${localize('chipos.workerTools.tool.hint', 'Hint')}: ${r.detail.hint.slice(0, 200)}`);
		}
		if (r.alternatives.length > 0) {
			tooltipLines.push(`${localize('chipos.workerTools.tool.altImpls', 'Alternatives')}: ${r.alternatives.join(', ')}`);
		}

		return {
			kind: 'impl-tool',
			resolution: r,
			handle: `impl-tool:${r.tool_name}`,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: r.tool_name },
			description,
			tooltip: tooltipLines.join('\n'),
			// P0 UX #3: ready=✓green, missing=○gray-circle (NOT ⚠yellow).
			// Yellow ⚠ on every missing row reads as 28 errors at first glance;
			// most are tools the user simply doesn't need.
			themeIcon: r.ready ? Codicon.check : Codicon.circleSlash,
			contextValue: ctxValue,
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
			label: { label: localize('chipos.workerTools.mcp.label', 'Worker-side MCP Servers') },
			description: localize('chipos.workerTools.mcp.count', '{0} configured', result.servers.length),
			tooltip,
			themeIcon: Codicon.plug,
			contextValue: 'chiposWorkerMcpRoot',
			command: result.config_path ? {
				id: 'chipos.workerTools.openConfig',
				title: '',
				arguments: [result.config_path],
			} : undefined,
		};
	}

	private _toMcpServerItem(server: McpServerConfig): IMcpServerItem {
		const cmd = [server.command, ...(server.args ?? [])].join(' ').trim();
		// P0 UX #11: health-aware status icon/description
		const healthStatus = server.health?.status ?? 'unknown';
		const healthBadge = this._formatHealthBadge(healthStatus, server);
		const description = healthBadge + (cmd ? ` · ${cmd.slice(0, 40)}${cmd.length > 40 ? '…' : ''}` : '');
		const icon = this._iconForHealth(healthStatus);
		const tooltipLines = [
			`${localize('chipos.workerTools.mcp.healthStatus', 'Status')}: ${healthStatus}`,
		];
		if (server.health?.last_check) {
			const age = Math.round((Date.now() / 1000 - server.health.last_check));
			tooltipLines.push(`${localize('chipos.workerTools.mcp.healthAge', 'Last checked')}: ${age}s ago`);
		}
		if (server.health?.latency_ms != null) {
			tooltipLines.push(`${localize('chipos.workerTools.mcp.healthLatency', 'Latency')}: ${server.health.latency_ms}ms`);
		}
		if (server.health?.error) {
			tooltipLines.push(`${localize('chipos.workerTools.mcp.healthError', 'Error')}: ${server.health.error}`);
		}
		tooltipLines.push(
			`${localize('chipos.workerTools.mcp.command', 'Command')}: ${server.command}`,
			`${localize('chipos.workerTools.mcp.args', 'Args')}: ${(server.args ?? []).join(' ') || '-'}`,
			`${localize('chipos.workerTools.mcp.cwd', 'CWD')}: ${server.cwd || '.'}`,
			`${localize('chipos.workerTools.mcp.env', 'Env')}: ${JSON.stringify(server.env ?? {})}`,
		);
		return {
			kind: 'mcp-server',
			server,
			handle: `worker-mcp:${server.name}`,
			collapsibleState: TreeItemCollapsibleState.None,
			label: { label: server.name },
			description,
			tooltip: tooltipLines.join('\n'),
			themeIcon: icon,
			contextValue: 'chiposWorkerMcpServer',
		};
	}

	private _formatHealthBadge(status: McpServerHealthStatus, server: McpServerConfig): string {
		const provides = server.provides?.length ?? 0;
		switch (status) {
			case 'connected':
				return localize('chipos.workerTools.mcp.badgeConnected', '✓ {0} tool(s)', provides);
			case 'no_tools':
				return localize('chipos.workerTools.mcp.badgeNoTools', '⚠ no tools');
			case 'handshake_failed':
				return localize('chipos.workerTools.mcp.badgeHandshake', '✗ handshake failed');
			case 'unreachable':
				return localize('chipos.workerTools.mcp.badgeUnreachable', '✗ unreachable');
			case 'unknown':
			default:
				return localize('chipos.workerTools.mcp.badgeUnknown', '? probing…');
		}
	}

	/**
	 * UX #6: middle-truncate a long path so user sees both the workspace
	 * prefix and the binary name. Naïve right-truncation hides the
	 * actually-distinguishing filename suffix (yosys vs verilator vs ...).
	 *
	 * Example: `/Users/linshaoxin/.coderust/eda/oss-cad-suite/bin/yosys` →
	 * `/Users/linsha…/oss-cad-suite/bin/yosys` (50 chars).
	 */
	private _middleTruncate(s: string, maxLen: number): string {
		if (s.length <= maxLen) { return s; }
		const keepEach = Math.floor((maxLen - 1) / 2);  // 1 char for ellipsis
		return s.slice(0, keepEach) + '…' + s.slice(s.length - keepEach);
	}

	private _iconForHealth(status: McpServerHealthStatus): ThemeIcon {
		switch (status) {
			case 'connected':         return Codicon.plug;
			case 'no_tools':          return Codicon.warning;
			case 'handshake_failed':  return Codicon.error;
			case 'unreachable':       return Codicon.debugDisconnect;
			default:                  return Codicon.question;
		}
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
