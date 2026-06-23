/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *
 *  Pure WaveJSON → inline SVG renderer for the EDA "waveform" render card.
 *
 *  Ported VERBATIM (char-for-char body) from the vscode-extension CLI so the two
 *  surfaces draw byte-identical waveforms. Only the param/return type annotations
 *  and the minimal local type annotations needed for strict TS were added; the
 *  logic is unchanged. Theme colors flow through `--vscode-*` CSS variables so the
 *  card honours the host theme.
 *--------------------------------------------------------------------------------------------*/

export interface WaveformSignal { name: string; wave: string; data?: string[]; }
export interface WaveformData { title?: string; signals: WaveformSignal[]; timescale?: string; summary?: string; }

export function buildWaveformSvg(data: WaveformData): string {
	var MUT = 'var(--vscode-descriptionForeground, #888)';
	var sigs = (data && Array.isArray(data.signals) ? data.signals : [])
		.filter(function (s) { return s && typeof s.wave === 'string'; });
	if (!sigs.length) {
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 24" width="100%" role="img" class="cw-svg">' +
			'<text x="4" y="16" font-family="var(--vscode-editor-font-family, monospace)" font-size="12" fill="' + MUT + '">（空波形）</text></svg>';
	}
	var nameW = 86, x0 = nameW + 6, stepW = 42, tw = 6, rowH = 34, top = 6, axisH = 12;
	var nSteps = sigs.reduce(function (m, s) { return Math.max(m, s.wave.length); }, 0);
	var W = x0 + nSteps * stepW + 10;
	var Hgt = top + sigs.length * rowH + axisH;
	var xAt = function (i: number) { return x0 + i * stepW; };
	function segs(wave: string, dat?: string[]) {
		var out: any[] = [], di = 0;
		for (var i = 0; i < wave.length; i++) {
			var c = wave[i];
			if (c === '.') { if (out.length) { out[out.length - 1].end = i; } continue; }
			if (c === '=' || (c >= '2' && c <= '9')) { out.push({ s: i, end: i, t: 'bus', v: (dat && dat[di++]) || '' }); }
			else if (c === '0' || c === '1') { out.push({ s: i, end: i, t: 'lvl', v: c }); }
			else if (c === 'z' || c === 'Z') { out.push({ s: i, end: i, t: 'z' }); }
			else { out.push({ s: i, end: i, t: 'x' }); }
		}
		return out;
	}
	function esc(s: unknown) { return String(s).replace(/[&<>]/g, function (m) { return m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'; }); }
	var WAVE = 'var(--vscode-editor-foreground, var(--vscode-foreground))';
	var BUSC = 'var(--vscode-charts-blue, var(--vscode-textLink-foreground))';
	var ERR = 'var(--vscode-errorForeground, #e24b4a)';
	var GRID = 'var(--vscode-panel-border, rgba(127,127,127,0.25))';
	var p: string[] = [];
	p.push('<defs><pattern id="cw-xh" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
		'<line x1="0" y1="0" x2="0" y2="6" stroke="' + ERR + '" stroke-width="1" opacity="0.45"/></pattern></defs>');
	sigs.forEach(function (sig, r) {
		var rt = top + r * rowH, yHi = rt + 7, yLo = rt + 25, yMid = rt + 16;
		p.push('<text x="' + (nameW - 4) + '" y="' + (yMid + 4) + '" text-anchor="end" font-family="var(--vscode-editor-font-family, monospace)" font-size="12" fill="' + MUT + '">' + esc(sig.name || '') + '</text>');
		if (r > 0) { p.push('<line x1="' + x0 + '" y1="' + (rt - 0.5) + '" x2="' + (W - 6) + '" y2="' + (rt - 0.5) + '" stroke="' + GRID + '" stroke-width="0.5"/>'); }
		var list = segs(sig.wave, sig.data), prevY: number | null = null;
		list.forEach(function (g) {
			var xs = xAt(g.s), xe = xAt(g.end + 1);
			if (g.t === 'lvl') {
				var y = g.v === '1' ? yHi : yLo;
				if (prevY !== null && prevY !== y) { p.push('<line x1="' + xs + '" y1="' + prevY + '" x2="' + xs + '" y2="' + y + '" stroke="' + WAVE + '" stroke-width="1.6"/>'); }
				p.push('<line x1="' + xs + '" y1="' + y + '" x2="' + xe + '" y2="' + y + '" stroke="' + WAVE + '" stroke-width="1.6"/>');
				prevY = y;
			} else if (g.t === 'bus') {
				p.push('<path d="M' + xs + ',' + yMid + ' L' + (xs + tw) + ',' + yHi + ' L' + (xe - tw) + ',' + yHi + ' L' + xe + ',' + yMid + ' L' + (xe - tw) + ',' + yLo + ' L' + (xs + tw) + ',' + yLo + ' Z" fill="none" stroke="' + BUSC + '" stroke-width="1.2"/>');
				p.push('<text x="' + ((xs + xe) / 2) + '" y="' + (yMid + 4) + '" text-anchor="middle" font-family="var(--vscode-editor-font-family, monospace)" font-size="11" fill="' + BUSC + '">' + esc(g.v) + '</text>');
				prevY = yMid;
			} else if (g.t === 'x') {
				p.push('<rect x="' + xs + '" y="' + yHi + '" width="' + (xe - xs) + '" height="' + (yLo - yHi) + '" fill="url(#cw-xh)" stroke="' + ERR + '" stroke-width="1"/>');
				prevY = yMid;
			} else {
				p.push('<line x1="' + xs + '" y1="' + yMid + '" x2="' + xe + '" y2="' + yMid + '" stroke="' + MUT + '" stroke-width="1.4" stroke-dasharray="4 3"/>');
				prevY = yMid;
			}
		});
	});
	for (var i = 0; i <= nSteps; i += 2) {
		p.push('<line x1="' + xAt(i) + '" y1="' + top + '" x2="' + xAt(i) + '" y2="' + (top + sigs.length * rowH) + '" stroke="' + GRID + '" stroke-width="0.5" opacity="0.5"/>');
	}
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + Hgt + '" width="100%" preserveAspectRatio="xMinYMin meet" role="img" class="cw-svg">' + p.join('') + '</svg>';
}
