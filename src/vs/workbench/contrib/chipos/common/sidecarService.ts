/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * 后端连接状态
 *
 * 统一描述推理层的连接状态，不再区分 v1/v2。
 * 保留 SidecarState 名称以减少重命名范围（内部使用，不影响用户）。
 */
export const enum SidecarState {
	NotStarted = 'NotStarted',
	Spawning = 'Spawning',
	HealthChecking = 'HealthChecking',
	Connected = 'Connected',
	Disconnected = 'Disconnected',
	Error = 'Error',
}

/**
 * 后端部署模式
 *
 * 默认值是 `Auto` —— SidecarManager 根据 workspace 是否是 SSH-Remote、
 * product.json 是否注入了 reasoningUrl 等信号自动决定具体行为。
 *
 * 设计原则（修订 2026-04-30）：
 *   - **Reasoner 永远由部署方运维**（云端 / Docker / chipos-server REH），IDE
 *     通过 `chipos.backend.reasoningUrl` 连过去；IDE 不 spawn Reasoner.
 *   - **Worker 的 spawn 取决于 workspace 类型**：
 *       · SSH-Remote workspace → chipos-remote-ssh 扩展在远端 spawn (path A)
 *       · chipos-server REH → REH 自己 spawn (path B)
 *       · 本地 workspace → IDE 在本机 spawn binary（cache → download fallback)
 *         IPC 由 `vs/platform/chipos/electron-main/sidecarManagerMain.ts` 提供
 *
 * 历史注：2026-04-27 的 refactor (aca4974224a) 把本地 spawn 路径整体删掉了
 * （理由是 "IDE never spawns backends"），但这条理由只对 Reasoner 成立 ——
 * 对纯本地 workspace 用户来说，没有 SSH 也没有 REH，谁来 spawn Worker？
 * 答案是 IDE 自己。本次（2026-04-30）把这条路径接回来。
 */
export enum BackendMode {
	/** 自适应：根据 workspace 类型 + reasoningUrl 自动选模式（默认） */
	Auto = 'auto',
	/**
	 * 本地 workspace + 远端 Reasoner —— IDE 在本机 spawn worker 二进制
	 * (扫 ~/.chipos/workers/ 缓存，没有则从 chiposReleases.repo 下载)，
	 * worker 通过 gRPC 连 reasoningUrl 配置的远端 Reasoner.
	 */
	Local = 'local',
	/** SSH-Remote / REH workspace —— 远端 spawn worker, IDE 连云端 reasoner */
	CloudReasoning = 'cloud-reasoning',
	/** 手动指定 reasoner / worker URL（pre-deployed backend）*/
	Manual = 'manual',
}

/**
 * Worker 连接状态（独立于推理层连接状态）
 */
export const enum WorkerState {
	NotStarted = 'NotStarted',
	Starting = 'Starting',
	Connected = 'Connected',
	Disconnected = 'Disconnected',
	Error = 'Error',
}

/**
 * Subset of the worker instance.json the renderer cares about. Mirrors the
 * fields written by `_write_pid_file` in `backend_v2/packages/execution/src/
 * execution/server/cli.py`.
 */
export interface IWorkerInstanceMeta {
	readonly alive: boolean;
	readonly pid?: number;
	readonly ref_count?: number;
	readonly http_port?: number;
	readonly permission_token?: string;
}

export const ISidecarManagerService = createDecorator<ISidecarManagerService>('chiposSidecarManagerService');

export interface ISidecarManagerService {
	readonly _serviceBrand: undefined;

	// ── 推理层连接状态 ──────────────────────────────────────────────────

	readonly onDidChangeState: Event<SidecarState>;
	readonly state: SidecarState;

	// ── 部署模式 ────────────────────────────────────────────────────────

	/**
	 * 当前已解析的部署模式。Auto 模式在 startBackend() 期间被解析为具体模式后，
	 * 这里返回的就是解析后的具体模式（Local / CloudReasoning / Manual），不会
	 * 再返回 Auto。
	 */
	readonly mode: BackendMode;

	// ── Worker 连接状态（cloud-reasoning 模式下有意义）────────────────────

	readonly onDidChangeWorkerState: Event<WorkerState>;
	readonly workerState: WorkerState;

	// ── 推理层 URL（SSE 连接地址）────────────────────────────────────────

	readonly reasoningUrl: string;

	// ── Worker HTTP URL（工具管理面板直连地址）─────────────────────────────

	readonly workerHttpUrl: string;

	/**
	 * Read instance.json metadata for the current workspace (electron-sandbox
	 * only — talks to the main process via IPC). Returns undefined in web
	 * builds or older sidecar implementations that don't expose this.
	 *
	 * Used by the WorkerPermissionService to obtain the per-worker Bearer
	 * token (WORKER-PERMISSION-ASK-TRANSPORT §5.7) without each consumer
	 * having to know about the underlying IPC channel.
	 */
	readonly readInstanceMeta?: (workspaceRoot: string) => Promise<IWorkerInstanceMeta | undefined>;

	// ── 生命周期 ────────────────────────────────────────────────────────

	/**
	 * 根据 chipos.backend.mode 配置 + workspace 远程性 决定如何连后端。
	 * IDE 不 spawn reasoning / worker — 它们都由开发者/运维独立部署.
	 *
	 * - cloud-reasoning: workspace 是 SSH-Remote, chipos-remote-ssh 已经
	 *                    forward worker HTTP, IDE 连云端 reasoner +
	 *                    forwarded worker
	 * - manual:         不做任何探测, 直接连 settings 里写的 reasoningUrl
	 *                   / workerHttpUrl
	 */
	startBackend(): Promise<void>;

	/**
	 * 停止后端连接（清理 SSE 流 / worker_token refresh timer 等）。
	 * 不会去 kill 任何 backend 进程 — 那是部署方的事.
	 */
	stopBackend(): Promise<void>;

	/**
	 * 重启 Worker（不影响推理层连接，仅 cloud-reasoning 模式有效）
	 */
	restartWorker(): Promise<void>;

	// ── v1 兼容（委托到 v2 方法，将来删除）────────────────────────────────

	/** @deprecated 使用 startBackend() */
	spawn(): Promise<void>;
	/** @deprecated 使用 stopBackend() */
	kill(): Promise<void>;
	/** @deprecated 使用 chipos.backend.reasoningUrl 配置 */
	setManualUrl(url: string | undefined): void;
	/** @deprecated 使用 reasoningUrl */
	readonly wsUrl: string;
	/** @deprecated */
	readonly port: number;
}
