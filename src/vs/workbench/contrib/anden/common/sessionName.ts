/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

export function suggestSessionName(folderName: string, agent: string, existing: Iterable<string>): string {
	const base = localize('sessionName', '{0} · {1}', folderName, agent);
	const names = new Set(existing);
	let label = base;
	for (let number = 2; names.has(label); number++) {
		label = localize('numberedSessionName', '{0} · {1}', base, number);
	}
	return label;
}
