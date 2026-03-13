/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { generateUuid } from 'vs/base/common/uuid';
import type { IMentionItem, IToolCallPayload } from 'vs/workbench/contrib/chipos/browser/eventStream/eventTypes';

// ── Data models ─────────────────────────────────────────────────────────────

export interface IChatMessage {
	readonly id: string;
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	mentions?: IMentionItem[];
	toolCalls?: IToolCallPayload[];
	timestamp: number;
	isStreaming: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'error';
export type SessionMode = 'agent' | 'spec';

export interface IChatSession {
	readonly id: string;
	title: string;
	messages: IChatMessage[];
	status: SessionStatus;
	mode: SessionMode;
	createdAt: number;
}

// ── ChatSessionManager ─────────────────────────────────────────────────────

const MAX_SESSIONS = 10;

export class ChatSessionManager extends Disposable {

	private readonly _sessions = new Map<string, IChatSession>();
	private _activeSessionId: string | undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IChatSession>());
	readonly onDidChangeActiveSession: Event<IChatSession> = this._onDidChangeActiveSession.event;

	private readonly _onDidChangeSessionList = this._register(new Emitter<IChatSession[]>());
	readonly onDidChangeSessionList: Event<IChatSession[]> = this._onDidChangeSessionList.event;

	private readonly _onDidUpdateSession = this._register(new Emitter<IChatSession>());
	readonly onDidUpdateSession: Event<IChatSession> = this._onDidUpdateSession.event;

	constructor() {
		super();
		this.createSession('New Chat');
	}

	// ── Public API ─────────────────────────────────────────────────────────

	createSession(title?: string): IChatSession {
		if (this._sessions.size >= MAX_SESSIONS) {
			const oldest = this._findOldestIdleSession();
			if (oldest) {
				this._sessions.delete(oldest.id);
			} else {
				throw new Error(`Cannot create more than ${MAX_SESSIONS} concurrent sessions.`);
			}
		}

		const session: IChatSession = {
			id: generateUuid(),
			title: title ?? `Chat ${this._sessions.size + 1}`,
			messages: [],
			status: 'idle',
			mode: 'agent',
			createdAt: Date.now(),
		};

		this._sessions.set(session.id, session);
		this._activeSessionId = session.id;

		this._onDidChangeSessionList.fire(this.getSessions());
		this._onDidChangeActiveSession.fire(session);

		return session;
	}

	switchToSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session || sessionId === this._activeSessionId) {
			return;
		}
		this._activeSessionId = sessionId;
		this._onDidChangeActiveSession.fire(session);
	}

	async closeSession(sessionId: string): Promise<boolean> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return false;
		}

		if (session.status === 'running') {
			// Caller should confirm with user before closing running sessions.
			// Returning false signals that confirmation is needed.
			return false;
		}

		this._sessions.delete(sessionId);

		if (this._activeSessionId === sessionId) {
			const remaining = Array.from(this._sessions.values());
			if (remaining.length > 0) {
				this._activeSessionId = remaining[remaining.length - 1].id;
				this._onDidChangeActiveSession.fire(remaining[remaining.length - 1]);
			} else {
				const newSession = this.createSession('New Chat');
				this._activeSessionId = newSession.id;
			}
		}

		this._onDidChangeSessionList.fire(this.getSessions());
		return true;
	}

	forceCloseSession(sessionId: string): void {
		this._sessions.delete(sessionId);

		if (this._activeSessionId === sessionId) {
			const remaining = Array.from(this._sessions.values());
			if (remaining.length > 0) {
				this._activeSessionId = remaining[remaining.length - 1].id;
				this._onDidChangeActiveSession.fire(remaining[remaining.length - 1]);
			} else {
				this.createSession('New Chat');
			}
		}

		this._onDidChangeSessionList.fire(this.getSessions());
	}

	getActiveSession(): IChatSession | undefined {
		return this._activeSessionId ? this._sessions.get(this._activeSessionId) : undefined;
	}

	getSession(sessionId: string): IChatSession | undefined {
		return this._sessions.get(sessionId);
	}

	getSessions(): IChatSession[] {
		return Array.from(this._sessions.values());
	}

	appendMessage(sessionId: string, message: IChatMessage): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.messages.push(message);
		this._onDidUpdateSession.fire(session);
	}

	updateLastAssistantContent(sessionId: string, appendText: string): IChatMessage | undefined {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return undefined;
		}
		for (let i = session.messages.length - 1; i >= 0; i--) {
			const msg = session.messages[i];
			if (msg.role === 'assistant' && msg.isStreaming) {
				msg.content += appendText;
				return msg;
			}
		}
		return undefined;
	}

	finishStreaming(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}
		for (const msg of session.messages) {
			if (msg.isStreaming) {
				msg.isStreaming = false;
			}
		}
	}

	setSessionStatus(sessionId: string, status: SessionStatus): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.status = status;
		this._onDidUpdateSession.fire(session);
	}

	setSessionMode(sessionId: string, mode: SessionMode): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.mode = mode;
		}
	}

	clearMessages(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.messages = [];
			this._onDidUpdateSession.fire(session);
		}
	}

	// ── Private ────────────────────────────────────────────────────────────

	private _findOldestIdleSession(): IChatSession | undefined {
		let oldest: IChatSession | undefined;
		for (const session of this._sessions.values()) {
			if (session.status === 'idle') {
				if (!oldest || session.createdAt < oldest.createdAt) {
					oldest = session;
				}
			}
		}
		return oldest;
	}
}
