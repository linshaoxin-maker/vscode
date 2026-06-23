/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IChatEdaWaveform } from '../../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import { IChatContentPart } from '../chatContentParts.js';
import { buildWaveformSvg } from './waveformSvg.js';
import '../media/edaParts.css';

const $ = dom.$;

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

		// Body: the inline SVG. Parse + importNode (trusted-types safe — no innerHTML).
		const body = $('.cw-body');
		const svg = buildWaveformSvg(this._data);
		const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
		const el = doc.documentElement;
		if (el && el.nodeName.toLowerCase() === 'svg') {
			body.appendChild(document.importNode(el, true));
		}
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
