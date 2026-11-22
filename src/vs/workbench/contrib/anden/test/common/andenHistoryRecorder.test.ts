/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { maxHistoryMessage, parseHistoryRecord } from '../../../../../platform/anden/common/andenHistory.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { AndenHistoryRecorder } from '../../common/andenHistoryRecorder.js';

suite('Anden history transcript', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const id = '00000000-0000-4000-8000-000000000001';
	const recorder = () => new AndenHistoryRecorder({ version: 1, id, label: 'Session', agent: 'pi', folder: isWindows ? 'C:\\repo' : '/repo', createdAt: 1, updatedAt: 1 });

	test('projects only conversation and draft, preserving confirmation and partial text', () => {
		const history = recorder();
		history.setDraft('try again');
		history.apply({ kind: 'user', id: 'user-1', text: 'First' });
		history.apply({ kind: 'userAccepted', id: 'user-1' });
		history.apply({ kind: 'text', id: 'assistant-1', text: 'part', append: true });
		assert.strictEqual(history.apply({ kind: 'tool', tool: { id: 'tool', name: 'A tool', kind: 'other', status: 'completed', output: 'Excluded' } }), false);
		assert.strictEqual(history.apply({ kind: 'request', request: { id: 'request', kind: 'input', title: 'Input', options: [], value: 'Excluded' } }), false);
		assert.strictEqual(history.apply({ kind: 'state', state: 'error', error: 'Excluded' }), false);
		history.apply({ kind: 'text', id: 'assistant-1', text: 'Final', append: false });
		history.apply({ kind: 'user', id: 'user-2', text: 'Second' });
		history.apply({ kind: 'text', id: 'assistant-2', text: 'In', append: true });
		history.apply({ kind: 'text', id: 'assistant-2', text: 'complete', append: true });
		const snapshot = history.snapshot('Renamed');
		assert.strictEqual(snapshot.label, 'Renamed');
		assert.strictEqual(snapshot.draft, 'try again');
		assert.deepStrictEqual(snapshot.messages, [
			{ role: 'user', text: 'First', complete: true },
			{ role: 'assistant', text: 'Final', complete: true },
			{ role: 'user', text: 'Second', complete: false },
			{ role: 'assistant', text: 'Incomplete', complete: false },
		]);
		assert.deepStrictEqual(parseHistoryRecord(snapshot, id), snapshot);
	});

	test('appends to a restored transcript even when the worker reuses message IDs', () => {
		const original = recorder();
		original.setDraft('unsent');
		original.apply({ kind: 'user', id: 'user-1', text: 'old prompt' });
		original.apply({ kind: 'userAccepted', id: 'user-1' });
		const saved = original.snapshot('Session');
		const resumed = new AndenHistoryRecorder(saved, saved);
		resumed.apply({ kind: 'user', id: 'user-1', text: 'new prompt' });
		const updated = resumed.snapshot('Session');
		assert.strictEqual(updated.draft, 'unsent');
		assert.deepStrictEqual(updated.messages.map(m => m.text), ['old prompt', 'new prompt']);
	});

	test('bounds stored messages and total size without losing the latest entries', () => {
		const history = recorder();
		for (let i = 0; i < 5; i++) {
			history.apply({ kind: 'text', id: `reply-${i}`, text: `${i}${'a'.repeat(maxHistoryMessage)}`, append: false });
		}
		const snapshot = history.snapshot('Session');
		assert.strictEqual(snapshot.truncated, true);
		assert.deepStrictEqual(snapshot.messages.map(m => m.text[0]), ['2', '3', '4']);
		assert.ok(parseHistoryRecord(snapshot, id));
	});
});
