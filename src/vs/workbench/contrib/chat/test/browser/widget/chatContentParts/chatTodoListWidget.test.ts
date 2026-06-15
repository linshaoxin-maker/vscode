/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isAncestorOfActiveElement } from '../../../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { Event } from '../../../../../../../base/common/event.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatTodoListWidget } from '../../../../browser/widget/chatContentParts/chatTodoListWidget.js';
import { IChatTodo, IChatTodoListService } from '../../../../common/tools/chatTodoListService.js';

const testSessionUri = URI.parse('chat-session://test/session1');

suite('ChatTodoListWidget Accessibility', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let widget: ChatTodoListWidget;

	const sampleTodos: IChatTodo[] = [
		{ id: 1, title: 'First task', status: 'not-started' },
		{ id: 2, title: 'Second task', status: 'in-progress' },
		{ id: 3, title: 'Third task', status: 'completed' }
	];

	setup(() => {
		// Mock the todo list service
		const mockTodoListService: IChatTodoListService = {
			_serviceBrand: undefined,
			onDidUpdateTodos: Event.None,
			getTodos: (sessionResource: URI) => sampleTodos,
			setTodos: (sessionResource: URI, todos: IChatTodo[]) => { },
			migrateTodos: (oldSessionResource: URI, newSessionResource: URI) => { }
		};

		// Mock the configuration service
		const mockConfigurationService = new TestConfigurationService();

		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IChatTodoListService, mockTodoListService);
		instantiationService.stub(IConfigurationService, mockConfigurationService);
		widget = store.add(instantiationService.createInstance(ChatTodoListWidget));
		mainWindow.document.body.appendChild(widget.domNode);
	});

	teardown(() => {
		if (widget.domNode.parentNode) {
			widget.domNode.parentNode.removeChild(widget.domNode);
		}
	});

	test('creates proper semantic list structure', () => {
		widget.render(testSessionUri);

		const todoListContainer = widget.domNode.querySelector('.todo-list-container');
		assert.ok(todoListContainer, 'Should have todo list container');
		assert.strictEqual(todoListContainer?.getAttribute('aria-labelledby'), 'todo-list-title');
		assert.strictEqual(todoListContainer?.getAttribute('role'), 'list');

		const titleElement = widget.domNode.querySelector('#todo-list-title');
		assert.ok(titleElement, 'Should have title element with ID todo-list-title');
		// When collapsed, title shows progress and current task without "Todos" prefix
		assert.ok(titleElement?.textContent, 'Title should have content');

		// The todo list container itself acts as the list (no nested ul element)
		const todoItems = todoListContainer?.querySelectorAll('li.todo-item');
		assert.ok(todoItems && todoItems.length > 0, 'Should have todo items in the list container');
	});

	test('todo items have proper accessibility attributes', () => {
		widget.render(testSessionUri);

		const todoItems = widget.domNode.querySelectorAll('.todo-item');
		assert.strictEqual(todoItems.length, 3, 'Should have 3 todo items');

		// Check first item (not-started)
		const firstItem = todoItems[0] as HTMLElement;
		assert.strictEqual(firstItem.getAttribute('role'), 'listitem');
		assert.ok(firstItem.getAttribute('aria-label')?.includes('First task'));
		assert.ok(firstItem.getAttribute('aria-label')?.includes('not started'));

		// Check second item (in-progress)
		const secondItem = todoItems[1] as HTMLElement;
		assert.ok(secondItem.getAttribute('aria-label')?.includes('Second task'));
		assert.ok(secondItem.getAttribute('aria-label')?.includes('in progress'));

		// Check third item (completed)
		const thirdItem = todoItems[2] as HTMLElement;
		assert.ok(thirdItem.getAttribute('aria-label')?.includes('Third task'));
		assert.ok(thirdItem.getAttribute('aria-label')?.includes('completed'));
	});

	test('status icons are hidden from screen readers', () => {
		widget.render(testSessionUri);

		const statusIcons = widget.domNode.querySelectorAll('.todo-status-icon');
		statusIcons.forEach(icon => {
			assert.strictEqual(icon.getAttribute('aria-hidden'), 'true', 'Status icons should be hidden from screen readers');
		});
	});

	test('expand button has proper accessibility attributes', () => {
		widget.render(testSessionUri);

		// The expandoButton is now a Monaco Button, so we need to check its element
		const expandoContainer = widget.domNode.querySelector('.todo-list-expand');
		assert.ok(expandoContainer, 'Should have expando container');

		const expandoButton = expandoContainer?.querySelector('.monaco-button');
		assert.ok(expandoButton, 'Should have Monaco button');
		assert.strictEqual(expandoButton?.getAttribute('aria-expanded'), 'true'); // Defaults expanded (ChipOS UX: todos are the plan-of-record)
		assert.strictEqual(expandoButton?.getAttribute('aria-controls'), 'todo-list-container');

		// The title element should have progress information
		const titleElement = expandoButton?.querySelector('.todo-list-title');
		assert.ok(titleElement, 'Should have title element');
		const titleText = titleElement?.textContent;
		// Default is expanded (ChipOS UX), so the title is "Todos (2/3)".
		// Progress is 2/3 because: 1 completed + 1 in-progress (current) = task 2 of 3
		assert.ok(titleText?.includes('(2/3)'), `Title should show progress format, but got: "${titleText}"`);
		assert.ok(titleText?.includes('Todos'), `Expanded title should show the Todos label, but got: "${titleText}"`);
	});

	test('todo items have complete aria-label with status information', () => {
		widget.render(testSessionUri);

		const todoItems = widget.domNode.querySelectorAll('.todo-item');
		assert.strictEqual(todoItems.length, 3, 'Should have 3 todo items');

		// Check first item (not-started) - aria-label should include title and status
		const firstItem = todoItems[0] as HTMLElement;
		const firstAriaLabel = firstItem.getAttribute('aria-label');
		assert.ok(firstAriaLabel?.includes('First task'), 'First item aria-label should include title');
		assert.ok(firstAriaLabel?.includes('not started'), 'First item aria-label should include status');

		// Check second item (in-progress) - aria-label should include title and status
		const secondItem = todoItems[1] as HTMLElement;
		const secondAriaLabel = secondItem.getAttribute('aria-label');
		assert.ok(secondAriaLabel?.includes('Second task'), 'Second item aria-label should include title');
		assert.ok(secondAriaLabel?.includes('in progress'), 'Second item aria-label should include status');

		// Check third item (completed) - aria-label should include title and status
		const thirdItem = todoItems[2] as HTMLElement;
		const thirdAriaLabel = thirdItem.getAttribute('aria-label');
		assert.ok(thirdAriaLabel?.includes('Third task'), 'Third item aria-label should include title');
		assert.ok(thirdAriaLabel?.includes('completed'), 'Third item aria-label should include status');
	});

	test('widget displays properly when no todos exist', () => {
		// Create a new mock service with empty todos
		const emptyTodoListService: IChatTodoListService = {
			_serviceBrand: undefined,
			onDidUpdateTodos: Event.None,
			getTodos: (sessionResource: URI) => [],
			setTodos: (sessionResource: URI, todos: IChatTodo[]) => { },
			migrateTodos: (oldSessionResource: URI, newSessionResource: URI) => { }
		};

		const emptyConfigurationService = new TestConfigurationService();

		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IChatTodoListService, emptyTodoListService);
		instantiationService.stub(IConfigurationService, emptyConfigurationService);
		const emptyWidget = store.add(instantiationService.createInstance(ChatTodoListWidget));
		mainWindow.document.body.appendChild(emptyWidget.domNode);

		emptyWidget.render(testSessionUri);

		// Widget should be hidden when no todos
		assert.strictEqual(emptyWidget.domNode.style.display, 'none', 'Widget should be hidden when no todos');
	});

	test('widget hides stale todos when a rendered session becomes empty', () => {
		let todos = sampleTodos;
		const mutableTodoListService: IChatTodoListService = {
			_serviceBrand: undefined,
			onDidUpdateTodos: Event.None,
			getTodos: () => todos,
			setTodos: (_sessionResource: URI, updatedTodos: IChatTodo[]) => {
				todos = updatedTodos;
			},
			migrateTodos: () => { }
		};
		const mutableConfigurationService = new TestConfigurationService();
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IChatTodoListService, mutableTodoListService);
		instantiationService.stub(IConfigurationService, mutableConfigurationService);
		const mutableWidget = store.add(instantiationService.createInstance(ChatTodoListWidget));
		mainWindow.document.body.appendChild(mutableWidget.domNode);

		mutableWidget.render(testSessionUri);
		assert.strictEqual(mutableWidget.domNode.style.display, 'block', 'Widget should be visible when todos exist');
		assert.strictEqual(mutableWidget.hasTodos(), true, 'Widget should report todos after rendering a non-empty list');

		todos = [];
		mutableWidget.render(testSessionUri);

		assert.strictEqual(mutableWidget.domNode.style.display, 'none', 'Widget should hide after todos are cleared');
		assert.strictEqual(mutableWidget.domNode.classList.contains('has-todos'), false, 'Widget should remove the has-todos state');
		assert.strictEqual(mutableWidget.hasTodos(), false, 'Widget should not report stale todos after clearing');

		if (mutableWidget.domNode.parentNode) {
			mutableWidget.domNode.parentNode.removeChild(mutableWidget.domNode);
		}
	});

	test('clear button has proper accessibility', () => {
		widget.render(testSessionUri);

		const clearButton = widget.domNode.querySelector('.todo-clear-button-container .monaco-button');
		assert.ok(clearButton, 'Should have clear button');
		assert.strictEqual(clearButton?.getAttribute('tabindex'), '0', 'Clear button should be focusable');
	});

	test('title element displays progress correctly and is accessible', () => {
		widget.render(testSessionUri);

		const titleElement = widget.domNode.querySelector('#todo-list-title');
		assert.ok(titleElement, 'Should have title element with ID');

		// Default is expanded (ChipOS UX), so the title is "Todos (2/3)" (collapsed
		// would instead surface the current task). Progress is 2/3 because:
		// 1 completed + 1 in-progress (current) = task 2 of 3.
		const titleText = titleElement?.textContent;
		assert.ok(titleText?.includes('(2/3)'), `Title should show progress format, but got: "${titleText}"`);
		assert.ok(titleText?.includes('Todos'), `Expanded title should show the Todos label, but got: "${titleText}"`);

		// Verify aria-labelledby connection works
		const todoListContainer = widget.domNode.querySelector('.todo-list-container');
		assert.strictEqual(todoListContainer?.getAttribute('aria-labelledby'), 'todo-list-title');
	});

	test('focus expands and places focus on the todo list', () => {
		widget.render(testSessionUri);

		const expandoButton = widget.domNode.querySelector('.todo-list-expand .monaco-button');
		assert.strictEqual(expandoButton?.getAttribute('aria-expanded'), 'true', 'Todo list should start expanded (ChipOS UX default)');

		const focused = widget.focus();
		assert.strictEqual(focused, true, 'Focus should succeed when todos are present');
		assert.strictEqual(expandoButton?.getAttribute('aria-expanded'), 'true', 'Todo list should remain expanded after focus');

		const todoListContainer = widget.domNode.querySelector('.todo-list-container') as HTMLElement;
		assert.ok(todoListContainer, 'Todo list container should exist');
		assert.ok(isAncestorOfActiveElement(todoListContainer), 'Todo list container should contain the active element after focusing');
	});

	test('hasTodos reports visibility state', () => {
		widget.render(testSessionUri);
		assert.strictEqual(widget.hasTodos(), true, 'Widget should report todos are present');

		const emptyTodoListService: IChatTodoListService = {
			_serviceBrand: undefined,
			onDidUpdateTodos: Event.None,
			getTodos: () => [],
			setTodos: () => { },
			migrateTodos: () => { }
		};
		const emptyConfigurationService = new TestConfigurationService({ 'chat.todoListTool.descriptionField': true });
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IChatTodoListService, emptyTodoListService);
		instantiationService.stub(IConfigurationService, emptyConfigurationService);
		const emptyWidget = store.add(instantiationService.createInstance(ChatTodoListWidget));
		mainWindow.document.body.appendChild(emptyWidget.domNode);

		emptyWidget.render(testSessionUri);
		assert.strictEqual(emptyWidget.hasTodos(), false, 'Widget should report no todos when the list is empty');

		if (emptyWidget.domNode.parentNode) {
			emptyWidget.domNode.parentNode.removeChild(emptyWidget.domNode);
		}
	});
});
