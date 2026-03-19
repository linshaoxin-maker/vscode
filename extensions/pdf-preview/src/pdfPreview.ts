/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS Team. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const LOG_PREFIX = '[PDF Preview]';
const outputChannel = vscode.window.createOutputChannel('PDF Preview');

function log(msg: string): void {
	const line = `${LOG_PREFIX} ${msg}`;
	console.log(line);
	outputChannel.appendLine(line);
}

export class PdfPreviewProvider implements vscode.CustomReadonlyEditorProvider {

	public static readonly viewType = 'pdfPreview.previewEditor';

	private _activeWebview: vscode.WebviewPanel | undefined;
	private _activeResource: vscode.Uri | undefined;

	constructor(private readonly _context: vscode.ExtensionContext) {}

	public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		log(`openCustomDocument: ${uri.toString()}`);
		return { uri, dispose: () => {} };
	}

	public async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		log(`resolveCustomEditor: ${document.uri.toString()}`);
		this._activeWebview = webviewPanel;
		this._activeResource = document.uri;

		webviewPanel.webview.options = {
			enableScripts: true,
			enableForms: false,
			localResourceRoots: [
				this._context.extensionUri,
				vscode.Uri.joinPath(document.uri, '..'),
			]
		};

		webviewPanel.webview.onDidReceiveMessage(message => {
			this._handleMessage(message, document.uri);
		});

		webviewPanel.onDidChangeViewState(() => {
			if (webviewPanel.active) {
				this._activeWebview = webviewPanel;
				this._activeResource = document.uri;
			}
		});

		webviewPanel.onDidDispose(() => {
			if (this._activeWebview === webviewPanel) {
				this._activeWebview = undefined;
				this._activeResource = undefined;
			}
		});

		webviewPanel.webview.html = await this._getHtmlForWebview(webviewPanel.webview, document.uri);
	}

	public toggleHighlight(): void {
		this._activeWebview?.webview.postMessage({ type: 'toggleHighlight' });
	}

	public clearAnnotations(): void {
		if (this._activeResource) {
			const annotationUri = this._getAnnotationUri(this._activeResource);
			vscode.workspace.fs.delete(annotationUri).then(() => {}, () => {});
			this._activeWebview?.webview.postMessage({ type: 'clearAnnotations' });
		}
	}

	public zoom(direction: 'in' | 'out'): void {
		this._activeWebview?.webview.postMessage({ type: 'zoom', direction });
	}

	private async _handleMessage(message: any, resource: vscode.Uri): Promise<void> {
		switch (message.type) {
			case 'saveAnnotations': {
				const annotationUri = this._getAnnotationUri(resource);
				const encoder = new TextEncoder();
				const data = encoder.encode(JSON.stringify(message.annotations, null, 2));
				await vscode.workspace.fs.writeFile(annotationUri, data);
				break;
			}
			case 'loadAnnotations': {
				const annotationUri = this._getAnnotationUri(resource);
				try {
					const data = await vscode.workspace.fs.readFile(annotationUri);
					const decoder = new TextDecoder();
					const annotations = JSON.parse(decoder.decode(data));
					this._activeWebview?.webview.postMessage({ type: 'loadAnnotations', annotations });
				} catch {
					// No annotations file yet
				}
				break;
			}
		}
	}

	private _getAnnotationUri(resource: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(resource, '..', `.${resource.path.split('/').pop()}.annotations.json`);
	}

	private async _getHtmlForWebview(webview: vscode.Webview, resource: vscode.Uri): Promise<string> {
		log(`Reading PDF file: ${resource.toString()}`);
		const pdfData = await vscode.workspace.fs.readFile(resource);
		log(`PDF file size: ${pdfData.length} bytes`);
		const pdfBase64 = uint8ArrayToBase64(pdfData);
		log(`PDF base64 length: ${pdfBase64.length} chars`);
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		log(`CSP source: ${cspSource}`);

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>PDF Preview</title>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: ${cspSource}; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; style-src 'nonce-${nonce}' ${cspSource}; worker-src blob:; font-src data: ${cspSource}; connect-src https://cdnjs.cloudflare.com;">
	<style nonce="${nonce}">
		* { margin: 0; padding: 0; box-sizing: border-box; }
		html, body { width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); }
		#viewer {
			width: 100%; height: 100%; overflow: auto;
			display: flex; flex-direction: column; align-items: center;
			padding: 16px 0; gap: 12px;
		}
		.page-container {
			position: relative; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
			background: white;
		}
		.page-container canvas { display: block; }
		/* Annotation overlay */
		.annotation-layer {
			position: absolute; top: 0; left: 0; width: 100%; height: 100%;
			pointer-events: none;
		}
		.annotation-layer.active { pointer-events: auto; cursor: crosshair; }
		.highlight-rect {
			position: absolute; background: rgba(255, 235, 59, 0.35);
			border: 1px solid rgba(255, 193, 7, 0.6); cursor: pointer;
			pointer-events: auto;
		}
		.highlight-rect:hover { background: rgba(255, 235, 59, 0.55); }
		.highlight-rect.selected { border: 2px solid #f44336; }
		/* Toolbar indicator */
		#mode-indicator {
			position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
			background: var(--vscode-badge-background, #007acc);
			color: var(--vscode-badge-foreground, #fff);
			padding: 4px 12px; border-radius: 4px; font-size: 12px;
			z-index: 1000; display: none;
			font-family: var(--vscode-font-family, sans-serif);
		}
		#mode-indicator.visible { display: block; }
		/* Page number */
		#page-info {
			position: fixed; bottom: 8px; right: 16px;
			background: var(--vscode-badge-background, #007acc);
			color: var(--vscode-badge-foreground, #fff);
			padding: 4px 10px; border-radius: 4px; font-size: 11px;
			z-index: 1000;
			font-family: var(--vscode-font-family, sans-serif);
		}
	</style>
</head>
<body>
	<div id="mode-indicator">Highlight Mode</div>
	<div id="viewer"></div>
	<div id="page-info"></div>
	<script nonce="${nonce}">
	(function() {
		const vscode = acquireVsCodeApi();
		const viewer = document.getElementById('viewer');
		const modeIndicator = document.getElementById('mode-indicator');
		const pageInfo = document.getElementById('page-info');

		console.log('[PDF Preview Webview] Initializing...');

		let scale = 1.5;
		let highlightMode = false;
		let annotations = {}; // { pageNum: [{ x, y, w, h }] }
		let pdfDoc = null;
		let pageCanvases = [];

		// ---- pdf.js inline (minimal subset) ----
		// We use the browser's built-in PDF rendering via canvas + pdf.js CDN fallback
		// For bundled extension, we embed a minimal pdf.js

		const PDF_DATA = atob('${pdfBase64}');
		const pdfBytes = new Uint8Array(PDF_DATA.length);
		for (let i = 0; i < PDF_DATA.length; i++) {
			pdfBytes[i] = PDF_DATA.charCodeAt(i);
		}
		console.log('[PDF Preview Webview] PDF data decoded, size:', pdfBytes.length, 'bytes');

		// Load pdf.js from CDN (will be replaced with bundled version in production)
		const pdfjsScript = document.createElement('script');
		pdfjsScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
		pdfjsScript.onload = () => {
			console.log('[PDF Preview Webview] pdf.js loaded from CDN');
			pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
			loadPdf();
		};
		pdfjsScript.onerror = (err) => {
			console.error('[PDF Preview Webview] Failed to load pdf.js from CDN:', err);
			viewer.innerHTML = '<p style="color:var(--vscode-errorForeground,red);padding:20px;">Failed to load pdf.js library. Check network/CSP settings.</p>';
		};
		document.head.appendChild(pdfjsScript);

		async function loadPdf() {
			try {
				pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
				pageInfo.textContent = pdfDoc.numPages + ' pages';
				renderAllPages();
				// Load saved annotations
				vscode.postMessage({ type: 'loadAnnotations' });
			} catch (err) {
				viewer.innerHTML = '<p style="color:var(--vscode-errorForeground,red);padding:20px;">Failed to load PDF: ' + err.message + '</p>';
			}
		}

		async function renderAllPages() {
			viewer.innerHTML = '';
			pageCanvases = [];
			for (let i = 1; i <= pdfDoc.numPages; i++) {
				const page = await pdfDoc.getPage(i);
				const viewport = page.getViewport({ scale });

				const container = document.createElement('div');
				container.className = 'page-container';
				container.dataset.page = i;
				container.style.width = viewport.width + 'px';
				container.style.height = viewport.height + 'px';

				const canvas = document.createElement('canvas');
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				const ctx = canvas.getContext('2d');
				await page.render({ canvasContext: ctx, viewport }).promise;

				const annotLayer = document.createElement('div');
				annotLayer.className = 'annotation-layer';
				annotLayer.dataset.page = i;

				// Highlight drawing
				let startX, startY, currentRect;
				annotLayer.addEventListener('mousedown', (e) => {
					if (!highlightMode) return;
					const rect = annotLayer.getBoundingClientRect();
					startX = e.clientX - rect.left;
					startY = e.clientY - rect.top;
					currentRect = document.createElement('div');
					currentRect.className = 'highlight-rect';
					currentRect.style.left = startX + 'px';
					currentRect.style.top = startY + 'px';
					annotLayer.appendChild(currentRect);
				});
				annotLayer.addEventListener('mousemove', (e) => {
					if (!currentRect) return;
					const rect = annotLayer.getBoundingClientRect();
					const x = e.clientX - rect.left;
					const y = e.clientY - rect.top;
					currentRect.style.left = Math.min(startX, x) + 'px';
					currentRect.style.top = Math.min(startY, y) + 'px';
					currentRect.style.width = Math.abs(x - startX) + 'px';
					currentRect.style.height = Math.abs(y - startY) + 'px';
				});
				annotLayer.addEventListener('mouseup', (e) => {
					if (!currentRect) return;
					const rect = annotLayer.getBoundingClientRect();
					const x = e.clientX - rect.left;
					const y = e.clientY - rect.top;
					const w = Math.abs(x - startX);
					const h = Math.abs(y - startY);
					if (w < 5 || h < 5) {
						currentRect.remove();
					} else {
						const pageNum = i;
						if (!annotations[pageNum]) annotations[pageNum] = [];
						const annot = {
							x: parseFloat(currentRect.style.left) / viewport.width,
							y: parseFloat(currentRect.style.top) / viewport.height,
							w: w / viewport.width,
							h: h / viewport.height
						};
						annotations[pageNum].push(annot);
						currentRect.addEventListener('dblclick', () => removeAnnotation(pageNum, annot, currentRect));
						saveAnnotations();
					}
					currentRect = null;
				});

				container.appendChild(canvas);
				container.appendChild(annotLayer);
				viewer.appendChild(container);
				pageCanvases.push({ canvas, page, container, annotLayer });
			}
			restoreAnnotations();
		}

		function removeAnnotation(pageNum, annot, el) {
			const arr = annotations[pageNum];
			if (arr) {
				const idx = arr.indexOf(annot);
				if (idx >= 0) arr.splice(idx, 1);
			}
			el.remove();
			saveAnnotations();
		}

		function restoreAnnotations() {
			pageCanvases.forEach(({ annotLayer, container }, idx) => {
				const pageNum = idx + 1;
				const pageAnnots = annotations[pageNum];
				if (!pageAnnots) return;
				const w = parseFloat(container.style.width);
				const h = parseFloat(container.style.height);
				pageAnnots.forEach(annot => {
					const rect = document.createElement('div');
					rect.className = 'highlight-rect';
					rect.style.left = (annot.x * w) + 'px';
					rect.style.top = (annot.y * h) + 'px';
					rect.style.width = (annot.w * w) + 'px';
					rect.style.height = (annot.h * h) + 'px';
					rect.addEventListener('dblclick', () => removeAnnotation(pageNum, annot, rect));
					annotLayer.appendChild(rect);
				});
			});
		}

		function saveAnnotations() {
			vscode.postMessage({ type: 'saveAnnotations', annotations });
		}

		function setHighlightMode(enabled) {
			highlightMode = enabled;
			modeIndicator.classList.toggle('visible', enabled);
			pageCanvases.forEach(({ annotLayer }) => {
				annotLayer.classList.toggle('active', enabled);
			});
		}

		async function rerender() {
			// Clear existing annotation DOM but keep data
			for (let i = 0; i < pageCanvases.length; i++) {
				const { canvas, page, container, annotLayer } = pageCanvases[i];
				const viewport = page.getViewport({ scale });
				container.style.width = viewport.width + 'px';
				container.style.height = viewport.height + 'px';
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				const ctx = canvas.getContext('2d');
				await page.render({ canvasContext: ctx, viewport }).promise;
				// Clear and restore annotations
				annotLayer.innerHTML = '';
			}
			restoreAnnotations();
		}

		// Handle messages from extension
		window.addEventListener('message', (e) => {
			const msg = e.data;
			switch (msg.type) {
				case 'toggleHighlight':
					setHighlightMode(!highlightMode);
					break;
				case 'clearAnnotations':
					annotations = {};
					pageCanvases.forEach(({ annotLayer }) => { annotLayer.innerHTML = ''; });
					break;
				case 'zoom':
					scale *= msg.direction === 'in' ? 1.25 : 0.8;
					scale = Math.max(0.5, Math.min(5, scale));
					rerender();
					break;
				case 'loadAnnotations':
					if (msg.annotations) {
						annotations = msg.annotations;
						restoreAnnotations();
					}
					break;
			}
		});

		// Scroll tracking for page info
		viewer.addEventListener('scroll', () => {
			if (!pdfDoc) return;
			const containers = viewer.querySelectorAll('.page-container');
			const viewerRect = viewer.getBoundingClientRect();
			let currentPage = 1;
			containers.forEach((c, i) => {
				const r = c.getBoundingClientRect();
				if (r.top < viewerRect.top + viewerRect.height / 2) {
					currentPage = i + 1;
				}
			});
			pageInfo.textContent = currentPage + ' / ' + pdfDoc.numPages;
		});
	})();
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	// btoa is available in both Node.js 16+ and browser environments
	return btoa(binary);
}
