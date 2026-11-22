/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { joinPath } from '../../../../base/common/resources.js';
import { join } from '../../../../base/common/path.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { FileService } from '../../../files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../files/node/diskFileSystemProvider.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../userDataProfile/common/userDataProfile.js';
import { AndenHistoryRecord } from '../../common/andenHistory.js';
import { AndenHistoryChannel } from '../../node/andenHistoryChannel.js';

suite('Anden history storage', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const id = '00000000-0000-4000-8000-000000000001';
	const anotherId = '00000000-0000-4000-8000-000000000002';
	const first = 'window:1';
	const second = 'window:2';
	let files: FileService;
	let profiles: IUserDataProfilesService;
	let store: AndenHistoryChannel;
	let root: URI;
	const record: AndenHistoryRecord = { version: 1, id, label: 'Example', agent: 'pi', folder: isWindows ? 'C:\\repo' : '/repo', createdAt: 1, updatedAt: 2, draft: 'Unsent', messages: [], truncated: false };

	setup(async () => {
		root = URI.file(await mkdtemp(join(tmpdir(), 'anden-history-test-')));
		const log = new NullLogService();
		files = disposables.add(new FileService(log));
		disposables.add(files.registerProvider('file', disposables.add(new DiskFileSystemProvider(log))));
		const cache = joinPath(root, 'cache');
		const profileA = toUserDataProfile('a', 'A', joinPath(root, 'a'), cache);
		const profileB = toUserDataProfile('b', 'B', joinPath(root, 'b'), cache, { useDefaultFlags: { globalState: true } }, profileA);
		profiles = new class extends mock<IUserDataProfilesService>() { override readonly profiles = [profileA, profileB]; };
		store = new AndenHistoryChannel(files, profiles);
	});

	teardown(async () => { await rm(root.fsPath, { recursive: true, force: true }); });

	test('restores after restart, isolates profiles, and does not delete a live session', async () => {
		await store.call(first, 'claim', ['a', id]);
		await store.call(first, 'save', ['a', id, record]);
		assert.deepStrictEqual(await store.call(second, 'read', ['a', id]), record);
		assert.deepStrictEqual(await store.call(second, 'list', ['b']), []);
		assert.strictEqual(await store.call(second, 'read', ['b', id]), undefined);
		assert.strictEqual(await store.call(second, 'delete', ['a', id]), false);
		await assert.rejects(store.call(second, 'save', ['a', id, record]));
		store.releaseWindow(first);
		await store.call(second, 'list', ['a']);
		store = new AndenHistoryChannel(files, profiles);
		assert.deepStrictEqual(await store.call(second, 'read', ['a', id]), record);
		assert.strictEqual(await store.call(second, 'delete', ['a', id]), true);
		await assert.rejects(store.call(first, 'save', ['a', id, record]));
		assert.deepStrictEqual(await store.call(first, 'list', ['a']), []);
	});

	test('only leases materialized Pi records and rejects a different working folder', async () => {
		const folder = await realpath(root.fsPath);
		const file = joinPath(URI.file(folder), 'native.jsonl');
		const saved: AndenHistoryRecord = { ...record, folder, piSession: { sessionId: anotherId, sessionFile: file.fsPath, cwd: folder } };
		await store.call(first, 'claim', ['a', id]);
		await store.call(first, 'save', ['a', id, saved]);
		await store.call(first, 'release', ['a', id]);
		assert.strictEqual(await store.call(second, 'canResume', ['a', id]), false);
		const header = { type: 'session', version: 3, id: anotherId, cwd: folder };
		await files.writeFile(file, VSBuffer.fromString(`${JSON.stringify({ ...header, cwd: join(folder, 'a') })}\n`));
		assert.deepStrictEqual(await store.call(second, 'resume', ['a', id]), { kind: 'unavailable' });
		await files.writeFile(file, VSBuffer.fromString(`${JSON.stringify(header)}\n`));
		assert.strictEqual(await store.call(second, 'canResume', ['a', id]), true);
		assert.deepStrictEqual(await store.call(second, 'resume', ['a', id]), { kind: 'ready', record: saved });
		assert.deepStrictEqual(await store.call(first, 'resume', ['a', id]), { kind: 'busy' });
		assert.strictEqual(await store.call(first, 'delete', ['a', id]), false);
		await store.call(second, 'release', ['a', id]);
		await files.move(file, joinPath(URI.file(folder), 'moved.jsonl'));
		assert.deepStrictEqual(await store.call(first, 'resume', ['a', id]), { kind: 'unavailable' });
		assert.deepStrictEqual(await store.call(first, 'read', ['a', id]), saved);
	});

	test('ignores unsupported old records without deleting their files', async () => {
		const directory = joinPath(root, 'a', 'anden-history');
		const content = joinPath(directory, `${id}.json`);
		const summary = joinPath(directory, `${id}.summary.json`);
		const legacy = VSBuffer.fromString(JSON.stringify({ ...record, agent: 'unsupported' }));
		await files.writeFile(content, legacy);
		await files.writeFile(summary, legacy);
		assert.deepStrictEqual(await store.call(first, 'list', ['a']), []);
		assert.strictEqual(await store.call(first, 'read', ['a', id]), undefined);
		assert.strictEqual((await files.readFile(content)).value.toString(), legacy.toString());
	});

	test('recovers from damaged metadata and isolates a corrupt transcript', async () => {
		await store.call(first, 'claim', ['a', id]);
		await store.call(first, 'save', ['a', id, record]);
		await store.call(first, 'claim', ['a', anotherId]);
		await store.call(first, 'save', ['a', anotherId, { ...record, id: anotherId }]);
		await files.writeFile(joinPath(root, 'a', 'anden-history', `${id}.summary.json`), VSBuffer.fromString('{'));
		await files.writeFile(joinPath(root, 'a', 'anden-history', `${anotherId}.json`), VSBuffer.fromString('{'));
		assert.strictEqual((await store.call<unknown[]>(first, 'list', ['a'])).length, 2);
		assert.deepStrictEqual(await store.call(first, 'read', ['a', id]), record);
		assert.strictEqual(await store.call(first, 'read', ['a', anotherId]), undefined);
		await assert.rejects(store.call(first, 'read', ['a', '../../escape']));
	});
});
