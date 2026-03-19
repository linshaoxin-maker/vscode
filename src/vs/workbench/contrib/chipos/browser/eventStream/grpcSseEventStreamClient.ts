/*---------------------------------------------------------------------------------------------
 *  FEAT-T08: gRPC-Web + SSE Event Stream Client (v2)
 *
 *  替换 webSocketEventStreamClient.ts，使用 HTTP/2 SSE 接收推理层推送，
 *  HTTP/2 POST 发送任务/停止/确认。
 *
 *  设计为可替换的 IEventStreamClient 实现。
 *---------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IServerMessage, AgentEventType } from './eventTypes.js';

/**
 * 连接状态
 */
export const enum ConnectionState {
	Disconnected = 0,
	Connecting = 1,
	Connected = 2,
	Reconnecting = 3,
}

/**
 * SSE + HTTP/2 配置
 */
export interface IGrpcSseClientConfig {
	/** 推理层 HTTP/2 基础 URL (e.g. https://reasoning.chipos.ai) */
	baseUrl: string;
	/** JWT Token */
	token?: string;
	/** 部署模式 */
	deploymentMode: 'local' | 'remote-reasoning' | 'remote-all';
	/** 重连间隔基数 (ms) */
	reconnectBaseMs?: number;
	/** 最大重连间隔 (ms) */
	reconnectMaxMs?: number;
	/** 最大重连次数 */
	maxReconnectAttempts?: number;
}

/**
 * gRPC-Web + SSE 事件流客户端
 *
 * 通信协议：
 * - UI -> 推理层: HTTP/2 POST (SendTask / StopTask / SendConfirmResponse)
 * - 推理层 -> UI: HTTP/2 SSE (EventStream)
 */
export class GrpcSseEventStreamClient extends Disposable {

	private readonly _disposables = new DisposableStore();
	private _eventSource: EventSource | null = null;
	private _sessionId: string = '';
	private _lastSequenceId: number = 0;
	private _reconnectAttempts: number = 0;
	private _state: ConnectionState = ConnectionState.Disconnected;

	private readonly _onMessage = new Emitter<IServerMessage>();
	readonly onMessage: Event<IServerMessage> = this._onMessage.event;

	private readonly _onStateChange = new Emitter<ConnectionState>();
	readonly onStateChange: Event<ConnectionState> = this._onStateChange.event;

	constructor(private readonly _config: IGrpcSseClientConfig) {
		super();
	}

	/**
	 * 发送任务 (HTTP/2 POST)
	 */
	async sendTask(params: {
		prompt: string;
		mode?: string;
		model?: string;
		provider?: string;
		apiKey?: string;
		apiBaseUrl?: string;
		contextFiles?: Array<{ path: string; content: string; kind: string }>;
		thinking?: boolean;
	}): Promise<string> {
		const response = await this._post('/api/v1/task', {
			session_id: this._sessionId || undefined,
			prompt: params.prompt,
			mode: params.mode || 'agent',
			llm_config: {
				model: params.model || '',
				provider: params.provider || 'auto',
				api_key: params.apiKey || '',
				api_base_url: params.apiBaseUrl || '',
			},
			context_files: params.contextFiles || [],
			thinking: params.thinking || false,
		});

		const data = await response.json();
		this._sessionId = data.session_id;

		// 开始监听 SSE 事件流
		this._connectSSE();

		return this._sessionId;
	}

	/**
	 * 停止任务 (HTTP/2 POST)
	 */
	async sendStop(): Promise<void> {
		if (!this._sessionId) { return; }
		await this._post('/api/v1/stop', {
			session_id: this._sessionId,
		});
	}

	/**
	 * 发送确认响应 (HTTP/2 POST)
	 */
	async sendConfirmResponse(callId: string, choice: string, comment?: string): Promise<void> {
		await this._post('/api/v1/confirm', {
			session_id: this._sessionId,
			call_id: callId,
			choice,
			comment: comment || '',
		});
	}

	/**
	 * 获取模型列表
	 */
	async listModels(): Promise<Array<{
		id: string;
		name: string;
		provider: string;
		profile: {
			max_context_window: number;
			vision: boolean;
			tool_use: boolean;
			streaming: boolean;
			thinking: boolean;
		};
	}>> {
		const response = await this._get('/api/v1/models');
		const data = await response.json();
		return data.models || [];
	}

	/**
	 * 连接 SSE 事件流
	 */
	private _connectSSE(): void {
		if (this._eventSource) {
			this._eventSource.close();
		}

		this._setState(ConnectionState.Connecting);

		const url = `${this._config.baseUrl}/api/v1/events?session_id=${this._sessionId}&last_sequence_id=${this._lastSequenceId}`;
		this._eventSource = new EventSource(url, {
			// Note: EventSource 不支持自定义 headers，
			// JWT token 通过 query param 传递（或使用 cookie）
		});

		this._eventSource.onopen = () => {
			this._setState(ConnectionState.Connected);
			this._reconnectAttempts = 0;
		};

		this._eventSource.onmessage = (event) => {
			try {
				const serverEvent = JSON.parse(event.data);
				this._lastSequenceId = parseInt(serverEvent.sequence_id?.split('-')[1] || '0', 10);
				this._dispatchEvent(serverEvent);
			} catch (e) {
				console.error('[GrpcSseClient] Failed to parse SSE event:', e);
			}
		};

		this._eventSource.onerror = () => {
			this._setState(ConnectionState.Reconnecting);
			this._scheduleReconnect();
		};
	}

	/**
	 * 将 ServerEvent 转换为 IServerMessage 并分发
	 */
	private _dispatchEvent(serverEvent: any): void {
		const type = serverEvent.type;
		const data = serverEvent.data || {};

		// 映射 Proto ServerEvent 类型到前端 AgentEventType
		const typeMap: Record<string, AgentEventType> = {
			'text_delta': AgentEventType.TextDelta,
			'thinking_delta': AgentEventType.ThinkingDelta,
			'tool_call': AgentEventType.ToolCallStart,
			'tool_result': AgentEventType.ToolCallEnd,
			'confirm_request': AgentEventType.ConfirmRequest,
			'done': AgentEventType.Done,
			'error': AgentEventType.Error,
			'subagent': AgentEventType.SubagentEvent,
			'status': AgentEventType.Status,
			'usage': AgentEventType.Usage,
			'heartbeat': AgentEventType.Heartbeat,
		};

		const agentType = typeMap[type];
		if (agentType !== undefined) {
			this._onMessage.fire({
				type: agentType,
				data,
				sessionId: serverEvent.session_id,
				sequenceId: serverEvent.sequence_id,
			});
		}
	}

	/**
	 * 指数退避重连
	 */
	private _scheduleReconnect(): void {
		const maxAttempts = this._config.maxReconnectAttempts ?? 5;
		if (this._reconnectAttempts >= maxAttempts) {
			this._setState(ConnectionState.Disconnected);
			this._onMessage.fire({
				type: AgentEventType.Error,
				data: { code: 'RECONNECT_FAILED', message: '无法连接推理服务，请检查网络', retryable: false },
				sessionId: this._sessionId,
			});
			return;
		}

		const baseMs = this._config.reconnectBaseMs ?? 1000;
		const maxMs = this._config.reconnectMaxMs ?? 30000;
		const delay = Math.min(baseMs * Math.pow(2, this._reconnectAttempts), maxMs);
		this._reconnectAttempts++;

		setTimeout(() => {
			if (this._state === ConnectionState.Reconnecting) {
				this._connectSSE();
			}
		}, delay);
	}

	private _setState(state: ConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this._onStateChange.fire(state);
		}
	}

	private async _post(path: string, body: any): Promise<Response> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this._config.token) {
			headers['Authorization'] = `Bearer ${this._config.token}`;
		}

		return fetch(`${this._config.baseUrl}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
	}

	private async _get(path: string): Promise<Response> {
		const headers: Record<string, string> = {};
		if (this._config.token) {
			headers['Authorization'] = `Bearer ${this._config.token}`;
		}

		return fetch(`${this._config.baseUrl}${path}`, {
			method: 'GET',
			headers,
		});
	}

	get connectionState(): ConnectionState {
		return this._state;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	override dispose(): void {
		if (this._eventSource) {
			this._eventSource.close();
			this._eventSource = null;
		}
		this._disposables.dispose();
		super.dispose();
	}
}
