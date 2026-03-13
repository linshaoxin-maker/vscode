/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import * as dom from '../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { MiniWebviewHost } from '../../../../../workbench/contrib/chipos/browser/chatPanel/miniWebviewHost.js';
import type { ITextDeltaEvent } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const $ = dom.$;

const PROGRESS_COMPLETE_REMOVE_DELAY_MS = 3000;

export class ProgressHandler extends Disposable {

	private readonly _activeProgresses = new Map<string, { element: HTMLElement; disposables: DisposableStore }>();

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	handleProgressEvent(event: ITextDeltaEvent): void {
		const subType = event.sub_type ?? '';
		const data = typeof event.payload.content === 'string'
			? this._tryParseJson(event.payload.content)
			: {};

		switch (subType) {
			case 'parallel_progress': {
				const el = this._renderParallelProgress(data);
				this._activeProgresses.set(event.event_id, { element: el, disposables: new DisposableStore() });
				this._container.appendChild(el);
				break;
			}
			case 'loop_progress': {
				const el = this._renderLoopProgress(data);
				this._activeProgresses.set(event.event_id, { element: el, disposables: new DisposableStore() });
				this._container.appendChild(el);
				break;
			}
		}
	}

	updateProgress(eventId: string, data: Record<string, unknown>): void {
		const entry = this._activeProgresses.get(eventId);
		if (!entry) {
			return;
		}

		const tracks = data['tracks'];
		if (Array.isArray(tracks)) {
			this._updateParallelTracks(entry.element, tracks);
			return;
		}

		const percent = data['percent'];
		if (typeof percent === 'number') {
			this._updateLoopBar(entry.element, percent, data['label'] as string | undefined);
		}

		if (percent === 100 || data['done'] === true) {
			this._scheduleRemoval(eventId);
		}
	}

	override dispose(): void {
		for (const entry of this._activeProgresses.values()) {
			entry.disposables.dispose();
		}
		this._activeProgresses.clear();
		super.dispose();
	}

	// ── Parallel progress (MiniWebviewHost) ───────────────────────────────

	private _renderParallelProgress(data: Record<string, unknown>): HTMLElement {
		const card = $('.chipos-progress-card.chipos-progress-parallel');

		const header = $('.chipos-progress-header');
		const title = $('span.chipos-progress-title');
		title.textContent = String(data['title'] ?? 'Parallel Tasks');
		header.appendChild(title);
		card.appendChild(header);

		const webviewContainer = $('.chipos-progress-webview-container');
		card.appendChild(webviewContainer);

		const host = this._instantiationService.createInstance(MiniWebviewHost, webviewContainer);
		host.loadCard('parallel_progress', data);

		const tracks = data['tracks'];
		if (Array.isArray(tracks)) {
			const tracksContainer = $('.chipos-progress-tracks');
			for (const track of tracks) {
				if (typeof track !== 'object' || track === null) {
					continue;
				}
				const t = track as Record<string, unknown>;
				tracksContainer.appendChild(this._createTrackElement(t));
			}
			card.appendChild(tracksContainer);
		}

		return card;
	}

	private _createTrackElement(track: Record<string, unknown>): HTMLElement {
		const row = $('.chipos-progress-track');
		row.dataset.trackId = String(track['id'] ?? '');

		const label = $('span.chipos-progress-track-label');
		label.textContent = String(track['label'] ?? '');
		row.appendChild(label);

		const barOuter = $('.chipos-progress-bar-outer');
		const barInner = $('.chipos-progress-bar-inner');
		const pct = Number(track['percent'] ?? 0);
		barInner.style.width = `${Math.min(100, Math.max(0, pct))}%`;
		barInner.style.transition = 'width 0.3s ease';
		barOuter.appendChild(barInner);
		row.appendChild(barOuter);

		const pctLabel = $('span.chipos-progress-track-pct');
		pctLabel.textContent = `${Math.round(pct)}%`;
		row.appendChild(pctLabel);

		return row;
	}

	private _updateParallelTracks(element: HTMLElement, tracks: unknown[]): void {
		const container = element.querySelector('.chipos-progress-tracks');
		if (!container) {
			return;
		}

		for (const track of tracks) {
			if (typeof track !== 'object' || track === null) {
				continue;
			}
			const t = track as Record<string, unknown>;
			const trackId = String(t['id'] ?? '');
			const existing = container.querySelector(`[data-track-id="${trackId}"]`);

			if (existing) {
				const bar = existing.querySelector('.chipos-progress-bar-inner') as HTMLElement | null;
				const pctLabel = existing.querySelector('.chipos-progress-track-pct');
				const pct = Number(t['percent'] ?? 0);
				if (bar) {
					bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
				}
				if (pctLabel) {
					pctLabel.textContent = `${Math.round(pct)}%`;
				}
			} else {
				container.appendChild(this._createTrackElement(t));
			}
		}
	}

	// ── Loop progress (native bar) ────────────────────────────────────────

	private _renderLoopProgress(data: Record<string, unknown>): HTMLElement {
		const card = $('.chipos-progress-card.chipos-progress-loop');

		const header = $('.chipos-progress-header');
		const label = $('span.chipos-progress-label');
		label.textContent = String(data['label'] ?? 'Processing...');
		header.appendChild(label);
		card.appendChild(header);

		const barOuter = $('.chipos-progress-bar-outer');
		const barInner = $('.chipos-progress-bar-inner');
		const pct = Number(data['percent'] ?? 0);
		barInner.style.width = `${Math.min(100, Math.max(0, pct))}%`;
		barInner.style.transition = 'width 0.3s ease';
		barOuter.appendChild(barInner);
		card.appendChild(barOuter);

		const pctText = $('span.chipos-progress-pct');
		pctText.textContent = `${Math.round(pct)}%`;
		card.appendChild(pctText);

		return card;
	}

	private _updateLoopBar(element: HTMLElement, percent: number, label?: string): void {
		const bar = element.querySelector('.chipos-progress-bar-inner') as HTMLElement | null;
		if (bar) {
			bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
		}
		const pctText = element.querySelector('.chipos-progress-pct');
		if (pctText) {
			pctText.textContent = `${Math.round(percent)}%`;
		}
		if (label) {
			const labelEl = element.querySelector('.chipos-progress-label');
			if (labelEl) {
				labelEl.textContent = label;
			}
		}
	}

	// ── Removal scheduling ────────────────────────────────────────────────

	private _scheduleRemoval(eventId: string): void {
		setTimeout(() => {
			const entry = this._activeProgresses.get(eventId);
			if (entry) {
				entry.element.classList.add('chipos-progress-done');
				entry.disposables.dispose();
				this._activeProgresses.delete(eventId);
			}
		}, PROGRESS_COMPLETE_REMOVE_DELAY_MS);
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	private _tryParseJson(text: string): Record<string, unknown> {
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// not JSON
		}
		return {};
	}
}
