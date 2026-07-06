/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../../../../base/browser/trustedTypes.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaWaveform } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { buildWaveformSvg } from './waveformSvg.js';
import '../media/edaParts.css';

const $ = dom.$;

/**
 * The waveform SVG is produced by our own {@link buildWaveformSvg} (never user
 * input), so blessing it through a trusted-types policy is the sanctioned way to
 * assign it as `innerHTML`. `DOMParser().parseFromString` is NOT a viable
 * alternative here: under the workbench's `require-trusted-types-for` policy it
 * throws `This document requires 'TrustedHTML' assignment`, which silently broke
 * every waveform card (caught by a real IDE→prod render, 2026-07-06).
 */
const _waveformSvgPolicy = createTrustedTypesPolicy('chiposWaveformSvg', {
	createHTML(html: string) {
		return html;
	}
});

/**
 * Inline GRAPHICAL waveform card (P6). Renders the reasoner's `waveform` /
 * `vcd_waveform` render event as an SVG (NOT monospace text) via the shared
 * {@link buildWaveformSvg} renderer — byte-identical to the CLI surface. The SVG
 * string is parsed with `DOMParser` and `importNode`d (the workbench forbids raw
 * `innerHTML` under trusted-types).
 */
export class ChatEdaWaveformContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly _data: IChatEdaWaveform,
	) {
		super();

		this.domNode = $('.chat-eda-waveform');

		// Header: title + optional dim subtitle (summary / timescale).
		const header = $('.cw-header');
		const titleEl = $('span.cw-title');
		titleEl.textContent = this._data.title || 'Waveform';
		header.appendChild(titleEl);
		const subtitleText = this._data.summary
			? this._data.summary
			: (this._data.timescale ? `timescale: ${this._data.timescale}` : '');
		if (subtitleText) {
			const subtitleEl = $('span.cw-subtitle');
			subtitleEl.textContent = subtitleText;
			header.appendChild(subtitleEl);
		}
		this.domNode.appendChild(header);

		// Body: the inline SVG. Assign the `<svg>…</svg>` string via the trusted-
		// types policy — the browser parses a root <svg> in HTML context into the
		// SVG namespace, so an inline waveform renders without `DOMParser` (which
		// the workbench's trusted-types CSP rejects — see policy note above).
		const body = $('.cw-body');
		const svg = buildWaveformSvg(this._data);
		body.innerHTML = (_waveformSvgPolicy?.createHTML(svg) ?? svg) as unknown as string;
		this.domNode.appendChild(body);
	}

	hasSameContent(other: IChatRendererContent): boolean {
		if (other.kind !== 'edaWaveform') {
			return false;
		}
		const o = other as IChatEdaWaveform;
		return o.title === this._data.title && o.signals?.length === this._data.signals?.length;
	}
}
