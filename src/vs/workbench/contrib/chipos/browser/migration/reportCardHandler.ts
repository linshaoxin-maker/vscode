/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import * as dom from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService, IMarkerData, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { MiniWebviewHost } from '../../../../../workbench/contrib/chipos/browser/chatPanel/miniWebviewHost.js';
import type { IToolResultEvent } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

const $ = dom.$;

const REPORT_OWNER = 'chipos.reportCard';

const KNOWN_REPORT_TYPES = new Set([
	'sim_report',
	'coverage_report',
	'lint_report',
	'negotiation_view',
	'spec_review',
	'pre_review_report',
]);

export class ReportCardHandler extends Disposable {

	private readonly _activeReports = new Map<string, { element: HTMLElement; disposables: DisposableStore }>();

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();
	}

	// ── Public API ─────────────────────────────────────────────────────────

	handleReportEvent(event: IToolResultEvent): void {
		const subType = event.sub_type ?? '';
		if (!KNOWN_REPORT_TYPES.has(subType)) {
			this._logService.warn('[ReportCardHandler] Unknown report sub_type:', subType);
			return;
		}

		this._logService.trace('[ReportCardHandler] Rendering report:', subType, event.event_id);

		const data = typeof event.payload.result === 'object' && event.payload.result !== null
			? event.payload.result as Record<string, unknown>
			: { raw: event.payload.result };

		const cardElement = this._renderReportCard(subType, data);
		this._container.appendChild(cardElement);

		if (subType === 'lint_report') {
			this._injectLintDiagnostics(data);
		}
	}

	override dispose(): void {
		for (const entry of this._activeReports.values()) {
			entry.disposables.dispose();
		}
		this._activeReports.clear();
		super.dispose();
	}

	// ── Report card rendering via MiniWebviewHost ─────────────────────────

	private _renderReportCard(subType: string, data: Record<string, unknown>): HTMLElement {
		const disposables = new DisposableStore();

		const card = $(`.chipos-report-card.chipos-report-card-${subType}`);

		const header = $('.chipos-report-header');
		const icon = $('span.chipos-report-icon');
		icon.textContent = this._getReportIcon(subType);
		header.appendChild(icon);

		const title = $('span.chipos-report-title');
		title.textContent = this._getReportTitle(subType);
		header.appendChild(title);
		card.appendChild(header);

		const webviewContainer = $('.chipos-report-webview-container');
		card.appendChild(webviewContainer);

		const host = disposables.add(
			this._instantiationService.createInstance(MiniWebviewHost, webviewContainer)
		);

		disposables.add(host.onDidReceiveMessage((msg) => {
			this._handleLinkClick(msg);
		}));

		host.loadCard(subType, data);

		const reportId = `${subType}-${Date.now()}`;
		this._activeReports.set(reportId, { element: card, disposables });

		return card;
	}

	// ── Lint diagnostics injection ────────────────────────────────────────

	private _injectLintDiagnostics(lintData: Record<string, unknown>): void {
		const files = lintData['files'];
		if (!Array.isArray(files)) {
			this._logService.warn('[ReportCardHandler] lint_report missing files array');
			return;
		}

		for (const fileEntry of files) {
			if (typeof fileEntry !== 'object' || fileEntry === null) {
				continue;
			}

			const entry = fileEntry as Record<string, unknown>;
			const filePath = entry['path'];
			if (typeof filePath !== 'string') {
				continue;
			}

			const diagnostics = entry['diagnostics'];
			if (!Array.isArray(diagnostics)) {
				continue;
			}

			const markers: IMarkerData[] = [];
			for (const diag of diagnostics) {
				if (typeof diag !== 'object' || diag === null) {
					continue;
				}
				const d = diag as Record<string, unknown>;

				markers.push({
					severity: this._parseSeverity(d['severity']),
					message: String(d['message'] ?? ''),
					source: 'chipos-lint',
					startLineNumber: Number(d['line'] ?? 1),
					startColumn: Number(d['column'] ?? 1),
					endLineNumber: Number(d['endLine'] ?? d['line'] ?? 1),
					endColumn: Number(d['endColumn'] ?? d['column'] ?? 1),
				});
			}

			if (markers.length > 0) {
				const uri = URI.file(filePath);
				this._markerService.changeOne(REPORT_OWNER, uri, markers);
			}
		}

		this._logService.debug('[ReportCardHandler] Injected lint diagnostics');
	}

	// ── Link click handling ───────────────────────────────────────────────

	private _handleLinkClick(message: unknown): void {
		if (typeof message !== 'object' || message === null) {
			return;
		}

		const data = message as Record<string, unknown>;
		if (data['type'] !== 'chipos:report:link') {
			return;
		}

		const target = data['target'];
		if (typeof target !== 'string') {
			return;
		}

		if (target.startsWith('file://') || target.startsWith('/')) {
			const filePath = target.startsWith('file://') ? target.slice(7) : target;
			const line = typeof data['line'] === 'number' ? data['line'] : undefined;
			const uri = URI.file(filePath);

			this._editorService.openEditor({
				resource: uri,
				options: line !== undefined ? { selection: { startLineNumber: line, startColumn: 1 } } : undefined,
			});
		}
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	private _parseSeverity(value: unknown): MarkerSeverity {
		if (typeof value === 'string') {
			switch (value.toLowerCase()) {
				case 'error': return MarkerSeverity.Error;
				case 'warning': return MarkerSeverity.Warning;
				case 'info': return MarkerSeverity.Info;
			}
		}
		if (typeof value === 'number') {
			return value as MarkerSeverity;
		}
		return MarkerSeverity.Warning;
	}

	private _getReportIcon(subType: string): string {
		switch (subType) {
			case 'sim_report': return '📊';
			case 'coverage_report': return '📈';
			case 'lint_report': return '🔍';
			case 'negotiation_view': return '🤝';
			case 'spec_review': return '📋';
			case 'pre_review_report': return '📝';
			default: return '📄';
		}
	}

	private _getReportTitle(subType: string): string {
		switch (subType) {
			case 'sim_report': return 'Simulation Report';
			case 'coverage_report': return 'Coverage Report';
			case 'lint_report': return 'Lint Report';
			case 'negotiation_view': return 'Negotiation View';
			case 'spec_review': return 'Spec Review';
			case 'pre_review_report': return 'Pre-Review Report';
			default: return subType;
		}
	}
}
