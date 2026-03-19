/*---------------------------------------------------------------------------------------------
 *  FEAT-T09: LocalToolExecutor — 前端工具执行服务
 *
 *  接收推理层 gRPC Action，调用 VSCode API 执行，返回 Observation。
 *  覆盖：文件读写（IFileService）、搜索（ISearchService）、终端（child_process）、Git（ISCMService）
 *---------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';

/**
 * 工具调用 Action
 */
export interface IToolCallAction {
	callId: string;
	name: string;
	argsJson: string;
}

/**
 * 工具执行结果 Observation
 */
export interface IToolResultObservation {
	callId: string;
	content: string;
	isError: boolean;
	toolName: string;
}

/**
 * 工具执行器接口
 */
export interface IToolExecutor {
	readonly name: string;
	canHandle(toolName: string): boolean;
	execute(action: IToolCallAction): Promise<IToolResultObservation>;
}

/**
 * LocalToolExecutor — 本地工具执行路由器
 *
 * 接收推理层下发的 Action，根据工具名称路由到对应的执行器。
 */
export class LocalToolExecutor extends Disposable {

	private readonly _executors: Map<string, IToolExecutor> = new Map();

	constructor() {
		super();
	}

	/**
	 * 注册工具执行器
	 */
	registerExecutor(executor: IToolExecutor): void {
		this._executors.set(executor.name, executor);
	}

	/**
	 * 执行工具调用
	 */
	async execute(action: IToolCallAction): Promise<IToolResultObservation> {
		// 查找能处理该工具的执行器
		for (const executor of this._executors.values()) {
			if (executor.canHandle(action.name)) {
				try {
					return await executor.execute(action);
				} catch (e) {
					return {
						callId: action.callId,
						content: `Error executing ${action.name}: ${e}`,
						isError: true,
						toolName: action.name,
					};
				}
			}
		}

		return {
			callId: action.callId,
			content: `Unknown tool: ${action.name}`,
			isError: true,
			toolName: action.name,
		};
	}
}

/**
 * FileToolExecutor — 文件操作执行器
 *
 * 使用 VSCode IFileService 执行文件读写。
 */
export class FileToolExecutor implements IToolExecutor {
	readonly name = 'file';

	private readonly _fileTools = new Set([
		'read_file', 'write_file', 'edit_file', 'list_dir',
		'create_directory', 'delete_file',
	]);

	canHandle(toolName: string): boolean {
		return this._fileTools.has(toolName);
	}

	async execute(action: IToolCallAction): Promise<IToolResultObservation> {
		const args = JSON.parse(action.argsJson);

		switch (action.name) {
			case 'read_file':
				return this._readFile(action.callId, args.path);
			case 'write_file':
				return this._writeFile(action.callId, args.path, args.content);
			case 'list_dir':
				return this._listDir(action.callId, args.path);
			default:
				return {
					callId: action.callId,
					content: `File tool ${action.name} not yet implemented`,
					isError: true,
					toolName: action.name,
				};
		}
	}

	private async _readFile(callId: string, path: string): Promise<IToolResultObservation> {
		try {
			// 使用 Node.js fs（Electron 环境）
			const fs = await import('fs');
			const content = fs.readFileSync(path, 'utf-8');
			return { callId, content, isError: false, toolName: 'read_file' };
		} catch (e) {
			return { callId, content: `Failed to read ${path}: ${e}`, isError: true, toolName: 'read_file' };
		}
	}

	private async _writeFile(callId: string, path: string, content: string): Promise<IToolResultObservation> {
		try {
			const fs = await import('fs');
			const pathModule = await import('path');
			fs.mkdirSync(pathModule.dirname(path), { recursive: true });
			fs.writeFileSync(path, content, 'utf-8');
			return { callId, content: `Written to ${path}`, isError: false, toolName: 'write_file' };
		} catch (e) {
			return { callId, content: `Failed to write ${path}: ${e}`, isError: true, toolName: 'write_file' };
		}
	}

	private async _listDir(callId: string, path: string): Promise<IToolResultObservation> {
		try {
			const fs = await import('fs');
			const entries = fs.readdirSync(path, { withFileTypes: true });
			const lines = entries.map((e: any) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
			return { callId, content: lines.join('\n'), isError: false, toolName: 'list_dir' };
		} catch (e) {
			return { callId, content: `Failed to list ${path}: ${e}`, isError: true, toolName: 'list_dir' };
		}
	}
}

/**
 * ShellToolExecutor — 命令执行器
 *
 * 使用 child_process 执行 shell 命令。
 */
export class ShellToolExecutor implements IToolExecutor {
	readonly name = 'shell';

	canHandle(toolName: string): boolean {
		return toolName === 'execute' || toolName === 'run_command';
	}

	async execute(action: IToolCallAction): Promise<IToolResultObservation> {
		const args = JSON.parse(action.argsJson);
		const command = args.command || '';
		const cwd = args.cwd || process.cwd();

		try {
			const { execSync } = await import('child_process');
			const output = execSync(command, {
				cwd,
				encoding: 'utf-8',
				timeout: 300000, // 5 分钟
				maxBuffer: 10 * 1024 * 1024, // 10MB
			});
			return { callId: action.callId, content: output, isError: false, toolName: action.name };
		} catch (e: any) {
			const output = e.stdout || e.stderr || e.message || String(e);
			return { callId: action.callId, content: output, isError: true, toolName: action.name };
		}
	}
}

/**
 * SearchToolExecutor — 搜索执行器
 */
export class SearchToolExecutor implements IToolExecutor {
	readonly name = 'search';

	canHandle(toolName: string): boolean {
		return toolName === 'search' || toolName === 'grep';
	}

	async execute(action: IToolCallAction): Promise<IToolResultObservation> {
		const args = JSON.parse(action.argsJson);
		const query = args.query || '';
		const path = args.path || '.';

		try {
			const { execSync } = await import('child_process');
			const output = execSync(
				`grep -rn --include="*.v" --include="*.sv" --include="*.py" --include="*.ts" "${query}" "${path}"`,
				{ encoding: 'utf-8', timeout: 30000, maxBuffer: 5 * 1024 * 1024 }
			);
			return { callId: action.callId, content: output, isError: false, toolName: action.name };
		} catch (e: any) {
			// grep 返回 1 表示没有匹配
			if (e.status === 1) {
				return { callId: action.callId, content: 'No matches found', isError: false, toolName: action.name };
			}
			return { callId: action.callId, content: e.message || String(e), isError: true, toolName: action.name };
		}
	}
}

/**
 * ToolExecutorRouter — 工具执行路由器
 *
 * 组合所有执行器，提供统一的工具执行入口。
 */
export class ToolExecutorRouter extends LocalToolExecutor {
	constructor() {
		super();
		// 注册内置执行器
		this.registerExecutor(new FileToolExecutor());
		this.registerExecutor(new ShellToolExecutor());
		this.registerExecutor(new SearchToolExecutor());
	}
}
