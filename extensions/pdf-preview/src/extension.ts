/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS Team. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PdfPreviewProvider } from './pdfPreview';

export function activate(context: vscode.ExtensionContext) {
	console.log('[PDF Preview] Extension activating...');

	const provider = new PdfPreviewProvider(context);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			PdfPreviewProvider.viewType,
			provider,
			{
				supportsMultipleEditorsPerDocument: true,
				webviewOptions: {
					retainContextWhenHidden: true,
				}
			}
		)
	);
	console.log('[PDF Preview] Custom editor provider registered for viewType:', PdfPreviewProvider.viewType);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('pdfPreview.toggleHighlight', () => {
			console.log('[PDF Preview] toggleHighlight command executed');
			provider.toggleHighlight();
		}),
		vscode.commands.registerCommand('pdfPreview.clearAnnotations', () => {
			console.log('[PDF Preview] clearAnnotations command executed');
			provider.clearAnnotations();
		}),
		vscode.commands.registerCommand('pdfPreview.zoomIn', () => {
			console.log('[PDF Preview] zoomIn command executed');
			provider.zoom('in');
		}),
		vscode.commands.registerCommand('pdfPreview.zoomOut', () => {
			console.log('[PDF Preview] zoomOut command executed');
			provider.zoom('out');
		})
	);

	console.log('[PDF Preview] Extension activated successfully');
}
