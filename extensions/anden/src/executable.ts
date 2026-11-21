/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export async function resolveExecutable(command: string, configuredPath: string | undefined, searchPath = process.env.PATH ?? ''): Promise<string | undefined> {
	if (configuredPath) {
		return isAbsolute(configuredPath) && await isExecutable(configuredPath) ? configuredPath : undefined;
	}

	const name = process.platform === 'win32' ? `${command}.exe` : command;
	// Avoid the integrated terminal's fallback to the workspace cwd when resolving a bare command.
	for (const directory of searchPath.split(delimiter)) {
		if (isAbsolute(directory)) {
			const candidate = join(directory, name);
			if (await isExecutable(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}
