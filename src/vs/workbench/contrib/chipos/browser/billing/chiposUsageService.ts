/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  Phase 2 Usage polling service: fetches /api/billing/usage + /subscription
 *  on a slow timer (default 60s) and pushes the result into the status bar.
 *
 *  No-op when the user isn't logged in or when chipos.auth.websiteUrl is not
 *  configured. Failures (network / 4xx) silently leave the previous value.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChipOSTokenManager } from '../auth/chiposTokenManager.js';
import { IChipOSUsageDisplay } from '../migration/statusBarHandler.js';

const POLL_INTERVAL_MS = 60_000;
// Minimum gap between two refreshes triggered by external events (login,
// manual refresh) — prevents the status bar from hammering the website if
// a chain of events fires.
const MIN_REFRESH_GAP_MS = 5_000;

export interface IChipOSUsageService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeUsage: Event<IChipOSUsageDisplay | null>;

	start(): void;
	stop(): void;
	refresh(): Promise<void>;
	getCurrent(): IChipOSUsageDisplay | null;
}

export const IChipOSUsageService = createDecorator<IChipOSUsageService>('chipOSUsageService');

interface UsageApiResponse {
	total_tokens?: number;
	metering_enabled?: boolean;
}

interface SubscriptionApiResponse {
	limits?: {
		monthly_tokens?: number | null;
	};
}

export class ChipOSUsageService extends Disposable implements IChipOSUsageService {
	declare readonly _serviceBrand: undefined;

	private _timer: ReturnType<typeof setInterval> | undefined;
	private _running = false;
	private _lastFetchAt = 0;
	private _current: IChipOSUsageDisplay | null = null;

	private readonly _onDidChangeUsage = this._register(new Emitter<IChipOSUsageDisplay | null>());
	readonly onDidChangeUsage = this._onDidChangeUsage.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
	) {
		super();

		// Re-fetch when login state flips so the bar reflects the new user.
		this._register(this._tokenManager.onDidChangeToken(() => {
			if (this._running) {
				this.refresh().catch(() => { /* logged in refresh() */ });
			}
		}));
	}

	start(): void {
		if (this._running) {
			return;
		}
		this._running = true;
		// Initial fetch + recurring poll.
		this.refresh().catch(() => { /* logged in refresh() */ });
		this._timer = setInterval(() => {
			this.refresh().catch(() => { /* logged in refresh() */ });
		}, POLL_INTERVAL_MS);
	}

	stop(): void {
		this._running = false;
		if (this._timer !== undefined) {
			clearInterval(this._timer);
			this._timer = undefined;
		}
	}

	getCurrent(): IChipOSUsageDisplay | null {
		return this._current;
	}

	async refresh(): Promise<void> {
		const now = Date.now();
		if (now - this._lastFetchAt < MIN_REFRESH_GAP_MS) {
			return;
		}
		this._lastFetchAt = now;

		const websiteUrl = this._tokenManager.resolveWebsiteUrl();
		if (!websiteUrl) {
			this._publish(null);
			return;
		}
		const token = await this._tokenManager.getAccessToken();
		if (!token) {
			this._publish(null);
			return;
		}

		try {
			const [usageResp, subResp] = await Promise.all([
				fetch(`${websiteUrl}/api/billing/usage?period=current_month`, {
					method: 'GET',
					headers: { 'Authorization': `Bearer ${token}` },
				}),
				fetch(`${websiteUrl}/api/billing/subscription`, {
					method: 'GET',
					headers: { 'Authorization': `Bearer ${token}` },
				}),
			]);

			if (!usageResp.ok || !subResp.ok) {
				this._logService.warn('[ChipOS Usage] non-OK response usage=%d sub=%d', usageResp.status, subResp.status);
				return;
			}
			const usage = await usageResp.json() as UsageApiResponse;
			const sub = await subResp.json() as SubscriptionApiResponse;

			const next: IChipOSUsageDisplay = {
				totalTokens: usage.total_tokens ?? 0,
				limitTokens: sub.limits?.monthly_tokens ?? null,
				meteringEnabled: usage.metering_enabled ?? false,
			};
			this._publish(next);
		} catch (err) {
			this._logService.warn('[ChipOS Usage] fetch failed: %s', String(err));
		}
	}

	private _publish(next: IChipOSUsageDisplay | null): void {
		this._current = next;
		this._onDidChangeUsage.fire(next);
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
