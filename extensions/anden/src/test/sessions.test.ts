/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agents, getPreferredFolder, SessionRegistry } from '../sessions';

const [pi, codex] = agents;

test('selects the sole folder or the folder of the active file', () => {
	assert.equal(getPreferredFolder([], undefined), undefined);
	assert.equal(getPreferredFolder(['a'], undefined), 'a');
	assert.equal(getPreferredFolder(['a', 'b'], 'b'), 'b');
	assert.equal(getPreferredFolder(['a', 'b'], undefined), undefined);
	assert.equal(getPreferredFolder(['a', 'b'], 'outside'), undefined);
});

test('tracks independent terminals and does not reuse session labels', () => {
	const sessions = new SessionRegistry<object, string>();
	const firstPi = sessions.create(pi, '/repo', () => ({}));
	const onlyCodex = sessions.create(codex, '/other-repo', () => ({}));
	const secondPi = sessions.create(pi, '/repo', () => ({}));
	assert.deepEqual(sessions.all.map(session => [session.label, session.folder]), [
		['Pi · 1', '/repo'], ['Codex · 1', '/other-repo'], ['Pi · 2', '/repo'],
	]);
	assert.equal(sessions.remove({}), false);
	assert.equal(sessions.remove(firstPi), true);
	assert.equal(sessions.has(firstPi), false);
	assert.equal(sessions.has(onlyCodex), true);
	assert.equal(sessions.has(secondPi), true);
	sessions.create(pi, '/repo', () => ({}));
	assert.deepEqual(sessions.all.map(session => session.label), ['Codex · 1', 'Pi · 2', 'Pi · 3']);
});

test('does not register a terminal if terminal creation throws', () => {
	const sessions = new SessionRegistry<object, string>();
	assert.throws(() => sessions.create(pi, '/repo', () => { throw new Error('launch failure'); }), /launch failure/);
	assert.equal(sessions.all.length, 0);
	sessions.create(pi, '/repo', () => ({}));
	assert.equal(sessions.all[0].label, 'Pi · 1');
});
