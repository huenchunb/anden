/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionList } from '../../common/sessionList.js';

suite('Anden SessionList', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('switching selects the existing session and preserves all entries', () => {
		const list = new SessionList<object>();
		const pi = {};
		const codex = {};
		list.add(pi);
		list.add(codex);
		list.select(pi);
		list.select(codex);
		assert.strictEqual(list.active, codex);
		assert.deepStrictEqual([...list.values()], [pi, codex]);
	});

	test('closing the active session selects a surviving session or the empty state', () => {
		const list = new SessionList<object>();
		const first = {};
		const second = {};
		list.add(first);
		list.add(second);
		list.select(second);
		assert.strictEqual(list.remove(second), true);
		assert.strictEqual(list.active, first);
		assert.strictEqual(list.remove(first), true);
		assert.strictEqual(list.active, undefined);
	});

	test('closing a background session leaves the active session and ignores a stale selection', () => {
		const list = new SessionList<object>();
		const first = {};
		const second = {};
		list.add(first);
		list.add(second);
		list.select(first);
		assert.strictEqual(list.remove(second), false);
		assert.strictEqual(list.select(second), false);
		assert.strictEqual(list.active, first);
	});
});
