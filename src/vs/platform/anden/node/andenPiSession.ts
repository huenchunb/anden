/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants } from 'fs';
import { lstat, open, realpath, stat } from 'fs/promises';
import { isAbsolute } from '../../../base/common/path.js';
import { AndenPiSession, parsePiSession } from '../common/andenHistory.js';

/** Validate the native file before Pi can adopt the cwd stored in its header. Never read the transcript. */
export async function resolvePiSession(value: AndenPiSession, folder: string): Promise<AndenPiSession | undefined> {
	const session = parsePiSession(value);
	if (!session || !isAbsolute(folder)) { return undefined; }
	try {
		const cwd = await realpath(folder);
		if (cwd !== session.cwd || !(await stat(cwd)).isDirectory()) { return undefined; }
		if (!(await lstat(session.sessionFile)).isFile()) { return undefined; }
		const sessionFile = await realpath(session.sessionFile);
		const handle = await open(sessionFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			if (!(await handle.stat()).isFile()) { return undefined; }
			const bytes = Buffer.alloc(65536);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(bytes, offset, Math.min(4096, bytes.length - offset), offset);
				if (!bytesRead) { return undefined; }
				const end = bytes.subarray(offset, offset + bytesRead).indexOf(10);
				if (end !== -1) {
					const header = JSON.parse(bytes.toString('utf8', 0, offset + end));
					if (header?.type !== 'session' || header.id !== session.sessionId || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || await realpath(header.cwd) !== cwd) { return undefined; }
					return { ...session, sessionFile };
				}
				offset += bytesRead;
			}
		} finally {
			await handle.close();
		}
	} catch {
		// Missing, changed or unreadable native state leaves the Anden transcript usable.
	}
	return undefined;
}
