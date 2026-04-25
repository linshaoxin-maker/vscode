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
 * 默认值是 `Auto` —— 由 `SidecarManager` 在运行时根据 workspace 远程性、
 * 已有进程探测等信号自动解析为 Local / CloudReasoning / Manual 之一。
 *
 * 显式取 Local / CloudReasoning / Manual 仅在 `chipos.backend.developerMode`
 * 打开时通过设置 UI 暴露，普通用户无需关心。
 */
export enum BackendMode {
	/** 自适应：根据环境自动选择最合适的模式（默认） */
	Auto = 'auto',
	/** 场景 A / B1: 推理+执行同进程（本地或 Remote-SSH 远程） */
	Local = 'local',
	/** 场景 B2 / E: 本地执行 + 云端推理 */
	CloudReasoning = 'cloud-reasoning',
	/** 场景 C / D: 手动指定地址（预部署） */
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

	// ── 生命周期 ────────────────────────────────────────────────────────

	/**
	 * 根据 chipos.backend.mode 配置启动后端。
	 * - local: spawn local_runner.py（推理+执行同进程）
	 * - cloud-reasoning: spawn Worker + 连接云端推理
	 * - manual: 不 spawn，直接连接预部署的后端
	 */
	startBackend(): Promise<void>;

	/**
	 * 停止后端（包括 Worker 和推理层进程）
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
