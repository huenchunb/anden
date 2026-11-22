/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isValidBasename } from '../../../../base/common/extpath.js';
import { Schemas } from '../../../../base/common/network.js';
import { IExtUri, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

export function isAndenGitMetadata(name: string): boolean {
	return name.toLowerCase() === '.git';
}

export function isAndenFileName(name: string): boolean {
	return isValidBasename(name) && !/[\\/\0]/.test(name) && !isAndenGitMetadata(name);
}

/** Check every component below the selected root, not just the final file. */
export async function isAndenSessionPath(root: URI, resource: URI, extUri: IExtUri, isSymbolicLink: (path: URI) => Promise<boolean>): Promise<boolean> {
	if (root.scheme !== Schemas.file || !extUri.isEqualOrParent(resource, root)) { return false; }
	const relative = extUri.relativePath(root, resource);
	if (relative === undefined) { return false; }
	if (!relative) { return extUri.isEqual(root, resource); }
	const names = relative.split('/');
	if (names.some(name => !name || name === '.' || name === '..' || isAndenGitMetadata(name))) { return false; }
	let current = root;
	for (const name of names) {
		current = joinPath(current, name);
		if (await isSymbolicLink(current)) { return false; }
	}
	return true;
}
