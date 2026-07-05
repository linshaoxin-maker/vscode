/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { ChatEdaSimReportContentPart } from '../../../../browser/widget/chatContentParts/edaParts/chatEdaSimReportPart.js';
import { ChatEdaCoverageReportContentPart } from '../../../../browser/widget/chatContentParts/edaParts/chatEdaCoverageReportPart.js';
import { ChatEdaLintReportContentPart } from '../../../../browser/widget/chatContentParts/edaParts/chatEdaLintReportPart.js';
import { ChatEdaPpaReportContentPart } from '../../../../browser/widget/chatContentParts/edaParts/chatEdaPpaReportPart.js';
import { ChatEdaNegotiationViewContentPart } from '../../../../browser/widget/chatContentParts/edaParts/chatEdaNegotiationViewPart.js';
import { IChatEdaSimReport, IChatEdaCoverageReport, IChatEdaLintReport, IChatEdaPpaReport, IChatEdaNegotiationView } from '../../../../common/chatEdaTypes.js';

/**
 * Runtime verification of the EDA card i18n pass (Track 3, tri-surface unification):
 * the report cards render their section titles in Chinese (was hardcoded English),
 * and the PPA card renders `improvement` as the raw percentage (the fmtPct ×100 bug
 * turned 8.3% into 830%). Instantiates the REAL content parts and inspects the REAL
 * DOM they produce — no Electron launch needed.
 */
suite('ChatEda card i18n titles + PPA improvement %', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The Lint / PPA parts take one injected service each; the cards never invoke them
	// during construction (only on button click), so minimal stubs suffice.
	const editorService = { openEditor: async () => undefined } as unknown as IEditorService;
	const commandService = {
		executeCommand: async () => undefined,
		onWillExecuteCommand: () => ({ dispose() { } }),
		onDidExecuteCommand: () => ({ dispose() { } }),
	} as unknown as ICommandService;

	const titleOf = (node: HTMLElement): string => node.querySelector('.eda-section-title')?.textContent ?? '';

	test('sim report title → 仿真结果', () => {
		const part = store.add(new ChatEdaSimReportContentPart(
			{ tests: [{ name: 'tb_add', status: 'pass' }], summary: { total: 1, passed: 1, failed: 0 } } as unknown as IChatEdaSimReport));
		assert.ok(titleOf(part.domNode).includes('仿真结果'), `expected 中文 title, got: "${titleOf(part.domNode)}"`);
	});

	test('coverage report title → 覆盖率报告', () => {
		const part = store.add(new ChatEdaCoverageReportContentPart(
			{ line_cov: 90, branch_cov: 80 } as unknown as IChatEdaCoverageReport));
		assert.ok(titleOf(part.domNode).includes('覆盖率报告'), `got: "${titleOf(part.domNode)}"`);
	});

	test('lint report title → Lint 报告', () => {
		const part = store.add(new ChatEdaLintReportContentPart(
			{ errors: [] } as unknown as IChatEdaLintReport, editorService));
		assert.ok(titleOf(part.domNode).includes('Lint 报告'), `got: "${titleOf(part.domNode)}"`);
	});

	test('negotiation view title → 团队分析', () => {
		const part = store.add(new ChatEdaNegotiationViewContentPart(
			{ issue: '综合面积 vs 时序', perspectives: [], recommendation: '优先时序' } as unknown as IChatEdaNegotiationView));
		assert.ok(titleOf(part.domNode).includes('团队分析'), `got: "${titleOf(part.domNode)}"`);
	});

	test('ppa report → PPA 报告 + improvement 8.3% (fmtPct no ×100)', () => {
		const part = store.add(new ChatEdaPpaReportContentPart(
			{
				stage: 'improved',
				baseline_ppa: { area: 120 }, current_ppa: { area: 110 }, ppa: { area: 110 },
				improvement: { area: 8.3 },
			} as unknown as IChatEdaPpaReport, commandService));
		const text = part.domNode.textContent ?? '';
		assert.ok(titleOf(part.domNode).includes('PPA 报告'), `title: "${titleOf(part.domNode)}"`);
		assert.ok(text.includes('8.3%'), `improvement should render 8.3%: "${text}"`);
		assert.ok(!text.includes('830'), `must NOT show 830% (the ×100 bug): "${text}"`);
	});
});
