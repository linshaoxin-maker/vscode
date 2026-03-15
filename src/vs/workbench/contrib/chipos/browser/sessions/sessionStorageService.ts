/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';

export interface ISessionMetadata {
	readonly id: string;
	readonly title: string;
	readonly model: string;
	readonly provider: string;
	readonly createdAt: number;
	lastMessageAt: number;
	messageCount: number;
}

export const ISessionStorageService = createDecorator<ISessionStorageService>('chiposSessionStorageService');

export interface ISessionStorageService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSessions: Event<void>;

	saveSession(meta: ISessionMetadata): void;
	getSessions(): ISessionMetadata[];
	getSession(id: string): ISessionMetadata | undefined;
	deleteSession(id: string): void;
	getActiveSessionId(): string | undefined;
	setActiveSessionId(id: string | undefined): void;
	updateSessionTitle(id: string, title: string): void;
	touchSession(id: string): void;
}

const STORAGE_KEY_SESSIONS = 'chipos.sessions';
const STORAGE_KEY_ACTIVE_SESSION = 'chipos.activeSessionId';

class SessionStorageService extends Disposable implements ISessionStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private _sessions: Map<string, ISessionMetadata> = new Map();
	private _activeSessionId: string | undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._load();
	}

	private _load(): void {
		try {
			const raw = this._storageService.get(STORAGE_KEY_SESSIONS, StorageScope.WORKSPACE);
			if (raw) {
				const arr: ISessionMetadata[] = JSON.parse(raw);
				for (const s of arr) {
					this._sessions.set(s.id, s);
				}
			}
			this._activeSessionId = this._storageService.get(STORAGE_KEY_ACTIVE_SESSION, StorageScope.WORKSPACE);
		} catch (err) {
			this._logService.warn('[ChipOS SessionStorage] Failed to load:', String(err));
		}
	}

	private _persist(): void {
		const arr = Array.from(this._sessions.values())
			.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
		this._storageService.store(STORAGE_KEY_SESSIONS, JSON.stringify(arr), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (this._activeSessionId) {
			this._storageService.store(STORAGE_KEY_ACTIVE_SESSION, this._activeSessionId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(STORAGE_KEY_ACTIVE_SESSION, StorageScope.WORKSPACE);
		}
		this._onDidChangeSessions.fire();
	}

	saveSession(meta: ISessionMetadata): void {
		this._sessions.set(meta.id, { ...meta });
		this._persist();
		this._logService.info('[ChipOS SessionStorage] Saved session:', meta.id, meta.title);
	}

	getSessions(): ISessionMetadata[] {
		return Array.from(this._sessions.values())
			.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
	}

	getSession(id: string): ISessionMetadata | undefined {
		return this._sessions.get(id);
	}

	deleteSession(id: string): void {
		this._sessions.delete(id);
		if (this._activeSessionId === id) {
			this._activeSessionId = undefined;
		}
		this._persist();
	}

	getActiveSessionId(): string | undefined {
		return this._activeSessionId;
	}

	setActiveSessionId(id: string | undefined): void {
		this._activeSessionId = id;
		this._persist();
	}

	updateSessionTitle(id: string, title: string): void {
		const session = this._sessions.get(id);
		if (session) {
			(session as { title: string }).title = title;
			this._persist();
		}
	}

	touchSession(id: string): void {
		const session = this._sessions.get(id);
		if (session) {
			session.lastMessageAt = Date.now();
			session.messageCount++;
			this._persist();
		}
	}
}

registerSingleton(ISessionStorageService, SessionStorageService, InstantiationType.Delayed);
