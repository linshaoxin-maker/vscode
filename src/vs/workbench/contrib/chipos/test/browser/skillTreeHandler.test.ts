/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	SkillTreeHandler,
	type ISkillDomain,
	type ISkillItem,
	type ISkillTreeData,
} from '../../../../../workbench/contrib/chipos/browser/migration/skillTreeHandler.js';

class StubLogService {
	trace(..._args: unknown[]): void { /* noop */ }
	debug(..._args: unknown[]): void { /* noop */ }
	info(..._args: unknown[]): void { /* noop */ }
	warn(..._args: unknown[]): void { /* noop */ }
	error(..._args: unknown[]): void { /* noop */ }
}

function makeSkill(id: string, name: string, enabled = true, triggerMode: ISkillItem['triggerMode'] = 'auto'): ISkillItem {
	return { id, name, description: `${name} description`, triggerMode, enabled };
}

function makeTreeData(domains: ISkillDomain[]): ISkillTreeData {
	return { domains };
}

suite('SkillTreeHandler', () => {

	let handler: SkillTreeHandler;
	let logService: StubLogService;

	setup(() => {
		logService = new StubLogService();
		handler = new SkillTreeHandler(logService as any);
	});

	teardown(() => {
		handler.dispose();
	});

	// ── Full skill tree update ────────────────────────────────────────────

	test('updateSkillTree stores domains', () => {
		const data = makeTreeData([
			{ id: 'eda', label: 'EDA Tools', skills: [makeSkill('synth', 'Synthesis')] },
			{ id: 'sim', label: 'Simulation', skills: [makeSkill('iverilog', 'Icarus Verilog')] },
		]);

		handler.updateSkillTree(data);

		assert.strictEqual(handler.domains.length, 2);
		assert.strictEqual(handler.domains[0].id, 'eda');
		assert.strictEqual(handler.domains[1].id, 'sim');
	});

	test('updateSkillTree fires onDidChangeTreeData', () => {
		let fired = false;
		handler.onDidChangeTreeData(() => { fired = true; });

		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'Domain', skills: [] },
		]));

		assert.strictEqual(fired, true);
	});

	test('updateSkillTree replaces previous data', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'old', label: 'Old', skills: [makeSkill('s1', 'Skill1')] },
		]));
		assert.strictEqual(handler.domains.length, 1);

		handler.updateSkillTree(makeTreeData([
			{ id: 'new1', label: 'New1', skills: [] },
			{ id: 'new2', label: 'New2', skills: [] },
		]));
		assert.strictEqual(handler.domains.length, 2);
		assert.strictEqual(handler.domains[0].id, 'new1');
	});

	// ── Incremental skill update ──────────────────────────────────────────

	test('updateSkill modifies an existing skill', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'eda', label: 'EDA', skills: [makeSkill('synth', 'Synthesis', true)] },
		]));

		handler.updateSkill('synth', { enabled: false, name: 'Synthesis v2' });

		const skill = handler.domains[0].skills[0];
		assert.strictEqual(skill.enabled, false);
		assert.strictEqual(skill.name, 'Synthesis v2');
		assert.strictEqual(skill.description, 'Synthesis description'); // unchanged
	});

	test('updateSkill fires onDidChangeTreeData', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd', label: 'D', skills: [makeSkill('s1', 'S1')] },
		]));

		let changeCount = 0;
		handler.onDidChangeTreeData(() => { changeCount++; });
		handler.updateSkill('s1', { enabled: false });

		assert.strictEqual(changeCount, 1);
	});

	test('updateSkill with unknown id does not crash', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd', label: 'D', skills: [makeSkill('s1', 'S1')] },
		]));

		let changeCount = 0;
		handler.onDidChangeTreeData(() => { changeCount++; });
		handler.updateSkill('nonexistent', { enabled: false });

		assert.strictEqual(changeCount, 0);
	});

	// ── getTreeDataProvider ───────────────────────────────────────────────

	test('getChildren returns domains at root level', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'D1', skills: [makeSkill('s1', 'S1')] },
			{ id: 'd2', label: 'D2', skills: [] },
		]));

		const provider = handler.getTreeDataProvider();
		const roots = provider.getChildren();

		assert.strictEqual(roots.length, 2);
	});

	test('getChildren returns skills for a domain', () => {
		const skills = [makeSkill('s1', 'S1'), makeSkill('s2', 'S2')];
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'D1', skills },
		]));

		const provider = handler.getTreeDataProvider();
		const roots = provider.getChildren();
		const children = provider.getChildren(roots[0]);

		assert.strictEqual(children.length, 2);
	});

	test('getChildren returns empty array for skill leaf node', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'D1', skills: [makeSkill('s1', 'S1')] },
		]));

		const provider = handler.getTreeDataProvider();
		const domain = provider.getChildren()[0];
		const skill = provider.getChildren(domain)[0];
		const leaves = provider.getChildren(skill);

		assert.strictEqual(leaves.length, 0);
	});

	test('getTreeItem returns collapsible domain with skill count', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'EDA Tools', skills: [makeSkill('s1', 'S1'), makeSkill('s2', 'S2')] },
		]));

		const provider = handler.getTreeDataProvider();
		const domain = provider.getChildren()[0];
		const item = provider.getTreeItem(domain);

		assert.strictEqual(item.id, 'd1');
		assert.strictEqual(item.label, 'EDA Tools');
		assert.ok(item.description!.includes('2 skills'));
		assert.strictEqual(item.collapsibleState, 1); // Collapsed
	});

	test('getTreeItem returns non-collapsible for empty domain', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'Empty Domain', skills: [] },
		]));

		const provider = handler.getTreeDataProvider();
		const domain = provider.getChildren()[0];
		const item = provider.getTreeItem(domain);

		assert.strictEqual(item.collapsibleState, 0); // None
	});

	test('getTreeItem returns skill with enabled check mark', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'D1', skills: [makeSkill('s1', 'Synthesis', true, 'auto')] },
		]));

		const provider = handler.getTreeDataProvider();
		const domain = provider.getChildren()[0];
		const skill = provider.getChildren(domain)[0];
		const item = provider.getTreeItem(skill);

		assert.ok(item.label.includes('✓'));
		assert.ok(item.label.includes('Synthesis'));
		assert.ok(item.description!.includes('auto'));
		assert.strictEqual(item.collapsibleState, 0);
	});

	test('getTreeItem shows circle for disabled skill', () => {
		handler.updateSkillTree(makeTreeData([
			{ id: 'd1', label: 'D1', skills: [makeSkill('s1', 'Lint', false)] },
		]));

		const provider = handler.getTreeDataProvider();
		const domain = provider.getChildren()[0];
		const skill = provider.getChildren(domain)[0];
		const item = provider.getTreeItem(skill);

		assert.ok(item.label.includes('○'));
		assert.ok(!item.label.includes('✓'));
	});

	// ── Empty state ───────────────────────────────────────────────────────

	test('empty state returns no children', () => {
		const provider = handler.getTreeDataProvider();
		const roots = provider.getChildren();
		assert.strictEqual(roots.length, 0);
	});

	test('empty state after updateSkillTree with empty domains', () => {
		handler.updateSkillTree(makeTreeData([]));
		assert.strictEqual(handler.domains.length, 0);

		const provider = handler.getTreeDataProvider();
		assert.strictEqual(provider.getChildren().length, 0);
	});
});
