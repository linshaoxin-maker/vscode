/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import {
	AgentEventType,
	type AgentEvent,
	type ISkillTreeEvent,
	type IToolResultEvent,
} from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { ChipOSEditorEffects } from '../../../../../workbench/contrib/chipos/browser/chatAgent/editorEffects.js';

class StubLogService {
	trace(..._args: unknown[]): void { }
	debug(..._args: unknown[]): void { }
	info(..._args: unknown[]): void { }
	warn(..._args: unknown[]): void { }
	error(..._args: unknown[]): void { }
}

class StubMarkerService {
	changeOne(_owner: string, _resource: URI, _markers: unknown[]): void { }
	remove(_owner: string, _resources: readonly URI[]): void { }
}

class StubEditorService {
	readonly opened: URI[] = [];

	async openEditor(input: { resource?: URI; modified?: { resource: URI } }): Promise<void> {
		const resource = input.resource ?? input.modified?.resource;
		if (resource) {
			this.opened.push(resource);
		}
	}
}

class StubWorkspaceContextService {
	getWorkspace() {
		return {
			folders: [{ uri: URI.file('/workspace') }],
		};
	}
}

function createToolResultEvent(filePath: string): IToolResultEvent {
	return {
		event_id: `tool-result:${filePath}`,
		event_type: AgentEventType.ToolResult,
		timestamp: Date.now(),
		payload: {
			call_id: `call:${filePath}`,
			tool_name: 'write_file',
			result: { file_path: filePath },
			success: true,
		},
	} as IToolResultEvent;
}

function createSkillTreeEvent(domainId: string, skillName: string): ISkillTreeEvent {
	return {
		event_id: `skill-tree:${domainId}`,
		event_type: AgentEventType.SkillTree,
		timestamp: Date.now(),
		payload: {
			version: 1,
			total_skills: 1,
			children: [{
				id: domainId,
				label: `${domainId}-label`,
				children: [{
					id: `${domainId}-skill`,
					name: skillName,
					description: `${skillName} description`,
					trigger_mode: 'manual',
					enabled: true,
				}],
			}],
		},
	} as ISkillTreeEvent;
}

suite('ChipOSEditorEffects', () => {
	let effects: ChipOSEditorEffects;
	let editorService: StubEditorService;

	setup(() => {
		editorService = new StubEditorService();
		effects = new ChipOSEditorEffects(
			new StubLogService() as any,
			new StubMarkerService() as any,
			editorService as any,
			new StubWorkspaceContextService() as any,
		);
	});

	teardown(() => {
		effects.dispose();
	});

	test('projects file changes from active session only', async () => {
		const sessionA = URI.parse('chat://session/a');
		const sessionB = URI.parse('chat://session/b');

		effects.handleEvent(sessionA, createToolResultEvent('src/a.ts') as AgentEvent);
		effects.handleEvent(sessionB, createToolResultEvent('src/b.ts') as AgentEvent);

		effects.setActiveSession(sessionA);
		assert.strictEqual(effects.fileChangeCount, 1);
		assert.deepStrictEqual(effects.fileChanges.map(f => f.path), ['src/a.ts']);

		effects.setActiveSession(sessionB);
		assert.strictEqual(effects.fileChangeCount, 1);
		assert.deepStrictEqual(effects.fileChanges.map(f => f.path), ['src/b.ts']);

		assert.deepStrictEqual(
			editorService.opened.map(uri => uri.path),
			['/workspace/src/a.ts', '/workspace/src/b.ts'],
		);
	});

	test('projects skill tree from active session only', () => {
		const sessionA = URI.parse('chat://session/a');
		const sessionB = URI.parse('chat://session/b');

		effects.handleEvent(sessionA, createSkillTreeEvent('eda', 'Lint A') as AgentEvent);
		effects.handleEvent(sessionB, createSkillTreeEvent('sim', 'Lint B') as AgentEvent);

		effects.setActiveSession(sessionA);
		assert.strictEqual(effects.skillTreeHandler.domains.length, 1);
		assert.strictEqual(effects.skillTreeHandler.domains[0].id, 'eda');
		assert.strictEqual(effects.skillTreeHandler.domains[0].skills[0].name, 'Lint A');

		effects.setActiveSession(sessionB);
		assert.strictEqual(effects.skillTreeHandler.domains.length, 1);
		assert.strictEqual(effects.skillTreeHandler.domains[0].id, 'sim');
		assert.strictEqual(effects.skillTreeHandler.domains[0].skills[0].name, 'Lint B');
	});

	test('clearSessionState removes only target session projection', () => {
		const sessionA = URI.parse('chat://session/a');
		const sessionB = URI.parse('chat://session/b');

		effects.handleEvent(sessionA, createToolResultEvent('src/a.ts') as AgentEvent);
		effects.handleEvent(sessionB, createToolResultEvent('src/b.ts') as AgentEvent);

		effects.setActiveSession(sessionA);
		assert.deepStrictEqual(effects.fileChanges.map(f => f.path), ['src/a.ts']);

		effects.clearSessionState(sessionA);
		assert.strictEqual(effects.fileChangeCount, 0);
		assert.deepStrictEqual(effects.fileChanges, []);

		effects.setActiveSession(sessionB);
		assert.deepStrictEqual(effects.fileChanges.map(f => f.path), ['src/b.ts']);
	});
});
