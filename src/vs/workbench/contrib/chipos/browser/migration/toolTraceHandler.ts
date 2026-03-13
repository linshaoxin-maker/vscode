/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import * as dom from '../../../../../base/browser/dom.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import type { IToolCallEvent, IToolResultEvent } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const $ = dom.$;

const AUTO_GROUP_THRESHOLD = 5;
const RESULT_TRUNCATE_LENGTH = 2000;

export class ToolTraceHandler extends Disposable {

	private readonly _toolElements = new Map<string, HTMLElement>();
	private _consecutiveCount = 0;
	private _currentGroup: HTMLElement | undefined;
	private _currentGroupBody: HTMLElement | undefined;

	constructor(
		private readonly _container: HTMLElement,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	handleToolCall(event: IToolCallEvent): HTMLElement {
		const { payload } = event;
		this._consecutiveCount++;

		this._logService.trace('[ToolTraceHandler] Tool call:', payload.tool_name, payload.call_id);

		if (this._consecutiveCount === AUTO_GROUP_THRESHOLD) {
			this._startGroup();
		}

		const panel = this._createToolPanel(payload.tool_name, payload.call_id, payload.arguments);

		if (this._consecutiveCount >= AUTO_GROUP_THRESHOLD && this._currentGroupBody) {
			this._currentGroupBody.appendChild(panel);
			this._updateGroupHeader();
		} else {
			this._container.appendChild(panel);
		}

		this._toolElements.set(payload.call_id, panel);
		return panel;
	}

	handleToolResult(event: IToolResultEvent): void {
		const { payload } = event;
		const panel = this._toolElements.get(payload.call_id);

		if (!panel) {
			this._logService.warn('[ToolTraceHandler] No panel for call_id:', payload.call_id);
			return;
		}

		const statusBadge = panel.querySelector('.chipos-tool-status') as HTMLElement | null;
		if (statusBadge) {
			statusBadge.textContent = payload.success ? '✓ done' : '✗ failed';
			statusBadge.classList.remove('chipos-tool-status-running');
			statusBadge.classList.add(
				payload.success ? 'chipos-tool-status-done' : 'chipos-tool-status-failed'
			);
		}

		const body = panel.querySelector('.chipos-tool-body') as HTMLElement | null;
		if (body) {
			const resultBlock = $('pre.chipos-tool-result');
			const text = typeof payload.result === 'string'
				? payload.result
				: JSON.stringify(payload.result, null, 2);
			resultBlock.textContent = text.length > RESULT_TRUNCATE_LENGTH
				? text.slice(0, RESULT_TRUNCATE_LENGTH) + '\n…(truncated)'
				: text;
			body.appendChild(resultBlock);
		}

		this._consecutiveCount = 0;
		this._currentGroup = undefined;
		this._currentGroupBody = undefined;
	}

	override dispose(): void {
		this._toolElements.clear();
		this._currentGroup = undefined;
		this._currentGroupBody = undefined;
		super.dispose();
	}

	// ── Tool panel creation ───────────────────────────────────────────────

	private _createToolPanel(toolName: string, callId: string, args: Record<string, unknown>): HTMLElement {
		const details = document.createElement('details');
		details.className = 'chipos-tool-panel';
		details.dataset.callId = callId;

		const summary = document.createElement('summary');
		summary.className = 'chipos-tool-summary';

		const nameSpan = $('span.chipos-tool-name');
		nameSpan.textContent = toolName;
		summary.appendChild(nameSpan);

		const statusBadge = $('span.chipos-tool-status.chipos-tool-status-running');
		statusBadge.textContent = '⏳ running';
		summary.appendChild(statusBadge);

		details.appendChild(summary);

		const body = $('.chipos-tool-body');

		const argsBlock = $('pre.chipos-tool-args');
		try {
			argsBlock.textContent = JSON.stringify(args, null, 2);
		} catch {
			argsBlock.textContent = String(args);
		}
		body.appendChild(argsBlock);

		details.appendChild(body);

		return details;
	}

	// ── Auto-grouping ─────────────────────────────────────────────────────

	private _startGroup(): void {
		const groupDetails = document.createElement('details');
		groupDetails.className = 'chipos-tool-group';

		const summary = document.createElement('summary');
		summary.className = 'chipos-tool-group-summary';
		summary.textContent = `Tool calls (${this._consecutiveCount})`;
		groupDetails.appendChild(summary);

		const groupBody = $('.chipos-tool-group-body');
		groupDetails.appendChild(groupBody);

		// Move previously ungrouped panels into the group
		const ungrouped: HTMLElement[] = [];
		for (const [, el] of this._toolElements) {
			if (el.parentElement === this._container) {
				ungrouped.push(el);
			}
		}
		for (const el of ungrouped) {
			groupBody.appendChild(el);
		}

		this._container.appendChild(groupDetails);
		this._currentGroup = groupDetails;
		this._currentGroupBody = groupBody;
	}

	private _updateGroupHeader(): void {
		if (!this._currentGroup) {
			return;
		}
		const summary = this._currentGroup.querySelector('.chipos-tool-group-summary');
		if (summary) {
			summary.textContent = `Tool calls (${this._consecutiveCount})`;
		}
	}
}
