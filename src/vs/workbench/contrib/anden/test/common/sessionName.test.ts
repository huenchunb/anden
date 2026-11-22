/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { suggestSessionName } from '../../common/sessionName.js';

suite('Anden session names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses folder and agent instead of a global agent ordinal', () => {
		assert.strictEqual(suggestSessionName('anden', 'Pi', ['docs · Pi', 'anden · Codex']), 'anden · Pi');
	});

	test('suggests the first available suffix when the base name is in use', () => {
		assert.strictEqual(suggestSessionName('anden', 'Pi', ['anden · Pi', 'anden · Pi · 2']), 'anden · Pi · 3');
		assert.strictEqual(suggestSessionName('anden', 'Pi', ['anden · Pi', 'anden · Pi · 3']), 'anden · Pi · 2');
	});
});
