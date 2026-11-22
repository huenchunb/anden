/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extUri, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isAndenFileName, isAndenSessionPath } from '../../common/andenFileScope.js';

suite('Anden session file scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const root = URI.parse('file:///C:/project');

	test('accepts the root and checks all components of a child in order', async () => {
		const folder = joinPath(root, 'nested');
		const file = joinPath(folder, 'c\u00f3digo.ts');
		const checked: URI[] = [];
		const inspect = async (path: URI) => { checked.push(path); return false; };
		assert.strictEqual(await isAndenSessionPath(root, root, extUri, inspect), true);
		assert.strictEqual(await isAndenSessionPath(root, file, extUri, inspect), true);
		assert.deepStrictEqual(checked, [folder, file]);
	});

	test('rejects siblings, other schemes and Git metadata before accessing the disk', async () => {
		const paths = [joinPath(root, '..', 'project-other', 'file'), joinPath(root, '.GiT', 'config'), root.with({ scheme: 'git' })];
		for (const path of paths) {
			assert.strictEqual(await isAndenSessionPath(root, path, extUri, async () => assert.fail('Unexpected filesystem access')), false);
		}
	});

	test('does not traverse a symbolic link in an ancestor or open the link itself', async () => {
		const link = joinPath(root, 'link');
		for (const file of [link, joinPath(link, 'elsewhere.txt')]) {
			assert.strictEqual(await isAndenSessionPath(root, file, extUri, async resource => {
				assert.deepStrictEqual(resource, link);
				return true;
			}), false);
		}
	});

	test('file operations accept a single name and reject metadata and path separators', () => {
		assert.strictEqual(isAndenFileName('notes 2.md'), true);
		for (const name of ['', '.', '..', '.git', 'a\u0000b', 'a/b', 'a\\b']) { assert.strictEqual(isAndenFileName(name), false, name); }
	});
});
