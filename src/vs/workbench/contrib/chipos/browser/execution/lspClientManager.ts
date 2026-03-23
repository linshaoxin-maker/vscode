/*---------------------------------------------------------------------------------------------
 *  FEAT-T11: LSP 集成 — 通用 Language Server 管理器
 *
 *  支持用户配置任意 Language Server（如 Verible、Slang、svls）。
 *  LSP Server 位置：本地或远程（通过 SSH 隧道）。
 *---------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';

/**
 * Language Server 配置
 */
export interface ILanguageServerConfig {
	/** 服务器名称 */
	name: string;
	/** 支持的语言 ID 列表 */
	languageIds: string[];
	/** 启动命令 */
	command: string;
	/** 命令参数 */
	args?: string[];
	/** 工作目录 */
	cwd?: string;
	/** 环境变量 */
	env?: Record<string, string>;
	/** 是否启用 */
	enabled?: boolean;
	/** 远程模式：SSH 隧道配置 */
	remote?: {
		host: string;
		port: number;
		user?: string;
		privateKeyPath?: string;
	};
	/** 初始化选项 */
	initializationOptions?: any;
}

/**
 * 诊断信息
 */
export interface IDiagnosticInfo {
	file: string;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'info' | 'hint';
	message: string;
	source: string;
}

/**
 * LSP Client 状态
 */
export const enum LspClientState {
	Stopped = 0,
	Starting = 1,
	Running = 2,
	Error = 3,
}

/**
 * LSPClientManager — 通用 Language Server 管理器
 *
 * 管理多个 Language Server 的生命周期。
 * 内置 Verible Language Server 配置（Verilog/SystemVerilog）。
 */
export class LSPClientManager extends Disposable {

	private readonly _clients: Map<string, ILspClientEntry> = new Map();
	private readonly _disposables = new DisposableStore();

	private readonly _onDiagnostics = new Emitter<IDiagnosticInfo[]>();
	readonly onDiagnostics: Event<IDiagnosticInfo[]> = this._onDiagnostics.event;

	constructor() {
		super();
	}

	/**
	 * 注册 Language Server 配置
	 */
	registerServer(config: ILanguageServerConfig): void {
		if (this._clients.has(config.name)) {
			console.warn(`[LSPClientManager] Server already registered: ${config.name}`);
			return;
		}

		this._clients.set(config.name, {
			config,
			state: LspClientState.Stopped,
			process: null,
		});
	}

	/**
	 * 启动 Language Server
	 */
	async startServer(name: string): Promise<void> {
		const entry = this._clients.get(name);
		if (!entry) {
			throw new Error(`Language Server not found: ${name}`);
		}

		if (entry.state === LspClientState.Running) {
			return;
		}

		entry.state = LspClientState.Starting;

		try {
			if (entry.config.remote) {
				await this._startRemoteServer(entry);
			} else {
				await this._startLocalServer(entry);
			}
			entry.state = LspClientState.Running;
		} catch (e) {
			entry.state = LspClientState.Error;
			throw e;
		}
	}

	/**
	 * 停止 Language Server
	 */
	async stopServer(name: string): Promise<void> {
		const entry = this._clients.get(name);
		if (!entry || entry.state !== LspClientState.Running) {
			return;
		}

		if (entry.process) {
			entry.process.kill();
			entry.process = null;
		}
		entry.state = LspClientState.Stopped;
	}

	/**
	 * 获取所有已注册的 Language Server
	 */
	getServers(): Array<{ name: string; state: LspClientState; languageIds: string[] }> {
		return Array.from(this._clients.entries()).map(([name, entry]) => ({
			name,
			state: entry.state,
			languageIds: entry.config.languageIds,
		}));
	}

	/**
	 * 启动本地 Language Server
	 */
	private async _startLocalServer(entry: ILspClientEntry): Promise<void> {
		// TODO: 使用 VSCode 的 LanguageClient API 启动
		// const client = new LanguageClient(
		//     entry.config.name,
		//     { command: entry.config.command, args: entry.config.args },
		//     { documentSelector: entry.config.languageIds.map(id => ({ language: id })) }
		// );
		// await client.start();
		console.log(`[LSPClientManager] Starting local server: ${entry.config.name}`);
	}

	/**
	 * 启动远程 Language Server（通过 SSH 隧道）
	 */
	private async _startRemoteServer(entry: ILspClientEntry): Promise<void> {
		const remote = entry.config.remote!;
		// TODO: 建立 SSH 隧道，然后通过 TCP 连接 Language Server
		console.log(`[LSPClientManager] Starting remote server: ${entry.config.name} via ${remote.host}:${remote.port}`);
	}

	override dispose(): void {
		for (const [name] of this._clients) {
			this.stopServer(name).catch(() => { });
		}
		this._disposables.dispose();
		super.dispose();
	}
}

interface ILspClientEntry {
	config: ILanguageServerConfig;
	state: LspClientState;
	process: any;
}

/**
 * 内置 Language Server 配置
 */
export const BUILTIN_LANGUAGE_SERVERS: ILanguageServerConfig[] = [
	{
		name: 'verible',
		languageIds: ['verilog', 'systemverilog'],
		command: 'verible-verilog-ls',
		args: ['--rules_config_search'],
		enabled: true,
	},
	{
		name: 'svls',
		languageIds: ['verilog', 'systemverilog'],
		command: 'svls',
		args: [],
		enabled: false, // 预留，默认不启用
	},
	{
		name: 'slang',
		languageIds: ['verilog', 'systemverilog'],
		command: 'slang-lsp',
		args: [],
		enabled: false, // 预留，默认不启用
	},
];
