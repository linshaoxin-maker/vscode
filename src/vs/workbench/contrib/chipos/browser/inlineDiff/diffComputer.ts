/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js';
import type { IEditOperation } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

// ── IDiffHunk ───────────────────────────────────────────────────────────────

export interface IDiffHunk {
	readonly id: string;
	readonly type: 'insert' | 'delete' | 'modify';
	readonly oldRange: { startLine: number; endLine: number };
	readonly newRange: { startLine: number; endLine: number };
	readonly oldContent: string[];
	readonly newContent: string[];
	status: 'pending' | 'accepted' | 'rejected' | 'conflict';
}

// ── DiffComputer ────────────────────────────────────────────────────────────

export class DiffComputer {

	/**
	 * Apply a set of edits to the original content and return the resulting text.
	 * Edits are sorted in reverse order so later positions are applied first,
	 * keeping earlier offsets stable.
	 */
	static applyEdits(oldContent: string, edits: IEditOperation[]): string {
		if (edits.length === 0) {
			return oldContent;
		}

		const lines = oldContent.split('\n');

		const sorted = [...edits].sort((a, b) => {
			if (a.range.startLine !== b.range.startLine) {
				return b.range.startLine - a.range.startLine;
			}
			return b.range.startCol - a.range.startCol;
		});

		for (const edit of sorted) {
			const { startLine, startCol, endLine, endCol } = edit.range;

			const sIdx = startLine - 1;
			const eIdx = endLine - 1;

			if (sIdx < 0 || eIdx >= lines.length) {
				continue;
			}

			const prefix = lines[sIdx].substring(0, startCol - 1);
			const suffix = lines[eIdx].substring(endCol - 1);
			const replacement = prefix + edit.newText + suffix;

			const newLines = replacement.split('\n');
			lines.splice(sIdx, eIdx - sIdx + 1, ...newLines);
		}

		return lines.join('\n');
	}

	/**
	 * Compare old and new content line-by-line, grouping consecutive
	 * differences into hunks.
	 */
	static compute(oldContent: string, newContent: string): IDiffHunk[] {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');

		const maxLen = Math.max(oldLines.length, newLines.length);
		const hunks: IDiffHunk[] = [];

		let i = 0;
		while (i < maxLen) {
			const oldLine = i < oldLines.length ? oldLines[i] : undefined;
			const newLine = i < newLines.length ? newLines[i] : undefined;

			if (oldLine === newLine) {
				i++;
				continue;
			}

			// Start of a differing region
			const regionStart = i;
			const oldStart: string[] = [];
			const newStart: string[] = [];

			while (i < maxLen) {
				const ol = i < oldLines.length ? oldLines[i] : undefined;
				const nl = i < newLines.length ? newLines[i] : undefined;
				if (ol === nl) {
					break;
				}
				if (ol !== undefined) {
					oldStart.push(ol);
				}
				if (nl !== undefined) {
					newStart.push(nl);
				}
				i++;
			}

			const type = DiffComputer._classifyHunk(oldStart, newStart);

			hunks.push({
				id: generateUuid(),
				type,
				oldRange: {
					startLine: regionStart + 1,
					endLine: regionStart + Math.max(oldStart.length, 1),
				},
				newRange: {
					startLine: regionStart + 1,
					endLine: regionStart + Math.max(newStart.length, 1),
				},
				oldContent: oldStart,
				newContent: newStart,
				status: 'pending',
			});
		}

		return hunks;
	}

	// ── Private ────────────────────────────────────────────────────────────

	private static _classifyHunk(
		oldLines: string[],
		newLines: string[],
	): 'insert' | 'delete' | 'modify' {
		if (oldLines.length === 0 && newLines.length > 0) {
			return 'insert';
		}
		if (oldLines.length > 0 && newLines.length === 0) {
			return 'delete';
		}
		return 'modify';
	}
}
