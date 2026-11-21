/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';
import { Uri } from 'vscode';
import { reviewEntries } from '../api/andenReview';
import { Status } from '../api/git.constants';
import { fromGitUri } from '../uri';

suite('Anden Git review', () => {
	const root = Uri.file('/workspace/review').fsPath;
	const file = (name: string) => Uri.file(path.join(root, name));
	const resource = (type: Status, name: string, before = name) => ({ type, resourceUri: file(name), original: file(before) });
	const submodules = [{ name: 'module', path: 'module', url: '' }];
	const fixtures = () => reviewEntries({
		root, submodules,
		mergeGroup: { resourceStates: [resource(Status.BOTH_MODIFIED, 'conflict.ts')] },
		indexGroup: { resourceStates: [resource(Status.INDEX_MODIFIED, 'source.ts'), resource(Status.INDEX_RENAMED, 'renamed ñ.ts', 'old.ts')] },
		workingTreeGroup: { resourceStates: [resource(Status.MODIFIED, 'source.ts'), resource(Status.DELETED, 'gone.ts'), resource(Status.UNTRACKED, 'mixed.ts'), resource(Status.IGNORED, 'ignored.ts'), resource(Status.MODIFIED, 'module')] },
		untrackedGroup: { resourceStates: [resource(Status.UNTRACKED, 'separate.ts')] },
	});

	test('the same path compares HEAD to index and index to disk independently', () => {
		const [staged, unstaged] = fixtures().filter(entry => entry.path === 'source.ts');
		assert.strictEqual(staged.group, 'staged');
		assert.strictEqual(fromGitUri(Uri.parse(staged.original!)).ref, 'HEAD');
		assert.strictEqual(staged.modified, unstaged.original);
		assert.strictEqual(fromGitUri(Uri.parse(staged.modified!)).ref, '');
		assert.strictEqual(unstaged.modified, file('source.ts').toString());
	});

	test('renames use the old path at HEAD and the new path in the index', () => {
		const rename = fixtures().find(entry => entry.kind === 'renamed')!;
		assert.strictEqual(rename.previousPath, 'old.ts');
		assert.strictEqual(rename.path, 'renamed ñ.ts');
		assert.strictEqual(fromGitUri(Uri.parse(rename.original!)).path, file('old.ts').fsPath);
		assert.strictEqual(fromGitUri(Uri.parse(rename.modified!)).path, file('renamed ñ.ts').fsPath);
	});

	test('untracked and deleted entries compare against empty sides; conflicts and submodules have no text sides', () => {
		const entries = fixtures();
		assert.deepStrictEqual(entries.filter(entry => entry.group === 'untracked').map(entry => [entry.path, entry.original]), [['mixed.ts', undefined], ['separate.ts', undefined]]);
		assert.strictEqual(entries.find(entry => entry.kind === 'deleted')?.modified, undefined);
		assert.deepStrictEqual(entries.filter(entry => entry.kind === 'conflict' || entry.kind === 'submodule').map(entry => [entry.original, entry.modified]), [[undefined, undefined], [undefined, undefined]]);
		assert.ok(!entries.some(entry => entry.path === 'ignored.ts'));
	});
});
