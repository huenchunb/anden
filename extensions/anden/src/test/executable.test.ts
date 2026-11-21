/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { resolveExecutable } from '../executable';

const name = process.platform === 'win32' ? 'pi.exe' : 'pi';

test('searches absolute PATH directories in order for an executable file', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'anden-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const first = join(dir, 'first');
	const second = join(dir, 'second');
	await mkdir(join(first, name), { recursive: true });
	await mkdir(second);
	const executable = join(second, name);
	await writeFile(executable, '', { mode: 0o755 });
	assert.equal(await resolveExecutable('pi', undefined, ['.', first, second].join(delimiter)), executable);
	assert.equal(await resolveExecutable('pi', undefined, ['.', first].join(delimiter)), undefined);
	assert.equal(await resolveExecutable('codex', undefined, second), undefined);
});

test('a configured executable must be absolute and does not fall back to PATH', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'anden-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const executable = join(dir, name);
	await writeFile(executable, '', { mode: 0o755 });
	assert.equal(await resolveExecutable('pi', executable, ''), executable);
	assert.equal(await resolveExecutable('pi', name, dir), undefined);
	assert.equal(await resolveExecutable('pi', join(dir, 'missing'), dir), undefined);
});
