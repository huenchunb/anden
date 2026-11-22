/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CancellationTokenSource, LogOutputChannel, window } from 'vscode';
import { countNewTextLines, getAndenSummary, parseNumstat } from '../andenSummary';
import { findGit, Git, Repository } from '../git';

suite('Anden repository summary', () => {
	let git: Git;
	let logger: LogOutputChannel;
	let root: string;
	let repository: Repository;
	let tokenSource: CancellationTokenSource;

	suiteSetup(async () => {
		logger = window.createOutputChannel('Anden repository summary test', { log: true });
		const found = await findGit(['git'], () => true, logger);
		git = new Git({ gitPath: found.path, version: found.version, userAgent: 'anden-summary-test' });
	});

	suiteTeardown(() => logger?.dispose());

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'anden-summary-test-'));
		await git.exec(root, ['init', '-q']);
		await git.exec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
		await git.exec(root, ['config', 'user.name', 'Anden Test']);
		await git.exec(root, ['config', 'user.email', 'test@example.invalid']);
		await git.exec(root, ['config', 'commit.gpgsign', 'false']);
		await git.exec(root, ['config', 'core.autocrlf', 'false']);
		repository = git.open(root, undefined, await git.getRepositoryDotGit(root), logger);
		tokenSource = new CancellationTokenSource();
	});

	teardown(async () => {
		tokenSource?.dispose();
		await fs.rm(root, { recursive: true, force: true });
	});

	const write = (name: string, contents: string | Buffer) => fs.writeFile(path.join(root, name), contents);
	const summary = () => getAndenSummary(repository, tokenSource.token);
	async function commitFixture(): Promise<void> {
		await write('example.txt', 'original\n');
		await repository.exec(['add', 'example.txt']);
		await repository.exec(['commit', '-qm', 'initial']);
	}

	test('parses NUL-delimited rename paths and skips binaries', () => {
		assert.deepStrictEqual(parseNumstat('0\t0\t\0old\tname\0new\nname\0-\t-\tbinary\0' + '3\t2\ttext\0'), { added: 3, deleted: 2 });
		assert.strictEqual(countNewTextLines(Buffer.from('one\ntwo')), 2);
		assert.strictEqual(countNewTextLines(Buffer.from([0, 10, 10])), 0);
	});

	test('counts the net disk diff instead of summing staged and unstaged changes', async () => {
		await commitFixture();
		await write('example.txt', 'original\n' + 'added\n'.repeat(10));
		await repository.exec(['add', 'example.txt']);
		const originalIndex = await fs.readFile(repository.dotGit.path + '/index');
		await write('example.txt', 'original\n' + 'added\n'.repeat(6));
		assert.deepStrictEqual((await summary())?.lines, { added: 6, deleted: 0 });
		assert.deepStrictEqual(await fs.readFile(repository.dotGit.path + '/index'), originalIndex);
	});

	test('compares a path removed from the index but retained on disk only once', async () => {
		await commitFixture();
		await repository.exec(['rm', '--cached', 'example.txt']);
		await write('example.txt', 'original\nadded\n');
		assert.deepStrictEqual((await summary())?.lines, { added: 1, deleted: 0 });
	});

	test('includes new text and excludes ignored paths and binary contents on an unborn branch', async () => {
		await write('.gitignore', 'ignored.txt\n');
		await write('ignored.txt', 'not counted\n');
		await write('new text.txt', 'one\ntwo');
		await write('indexed.txt', 'one\n');
		await write('binary', Buffer.from([0, 1, 10, 10]));
		await repository.exec(['add', 'indexed.txt']);
		assert.deepStrictEqual(await summary(), { branch: 'main', commit: undefined, lines: { added: 4, deleted: 0 } });
	});

	test('uses the current branch or detached commit and preserves pure rename totals', async () => {
		await commitFixture();
		await repository.exec(['checkout', '-qb', 'feature/summary']);
		await repository.exec(['mv', 'example.txt', 'renamed file.txt']);
		assert.strictEqual((await summary())?.branch, 'feature/summary');
		assert.deepStrictEqual((await summary())?.lines, { added: 0, deleted: 0 });
		await repository.exec(['reset', '--hard', 'HEAD']);
		await repository.exec(['checkout', '--detach', 'HEAD']);
		const current = await summary();
		assert.strictEqual(current?.branch, undefined);
		assert.match(current?.commit ?? '', /^[0-9a-f]{40,64}$/);
		await fs.rm(path.join(root, 'example.txt'));
		assert.deepStrictEqual((await summary())?.lines, { added: 0, deleted: 1 });
	});
});
