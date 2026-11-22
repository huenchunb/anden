/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

export const andenSlashCommands = {
	model: localize('slashModel', 'Choose a model'),
	thinking: localize('slashThinking', 'Choose a reasoning level'),
	reasoning: localize('slashReasoning', 'Alias for /thinking'),
	settings: localize('slashSettings', 'Show session settings'),
	new: localize('slashNew', 'Open a new Pi session'),
	resume: localize('slashResume', 'Browse saved sessions'),
	name: localize('slashName', 'Rename this session'),
	copy: localize('slashCopy', 'Copy the last Pi response'),
	session: localize('slashSession', 'Show model and usage statistics'),
	hotkeys: localize('slashHotkeys', 'Show Anden keyboard shortcuts'),
} as const;

export type AndenLocalCommand = keyof typeof andenSlashCommands;

const terminalOnly = new Set(['tree', 'scoped-models', 'export', 'import', 'share', 'bug', 'changelog', 'fork', 'clone', 'trust', 'login', 'logout', 'compact', 'reload', 'quit', 'debug', 'arminsayshi', 'dementedelves']);

export function isAndenLocalCommand(name: string): name is AndenLocalCommand {
	return Object.hasOwn(andenSlashCommands, name);
}

export function isPiTerminalCommand(name: string): boolean {
	return terminalOnly.has(name);
}

export function isPiCommandName(name: string): boolean {
	return /^[\w.:-]{1,160}$/.test(name);
}

/** Do not interpret paths such as /Users/me or Markdown with a non-command opening. */
export function parseSlashCommand(value: string): { name: string; args: string } | undefined {
	const match = /^\/([\w.:-]{1,160})(?:\s+([\s\S]*))?$/.exec(value.trim());
	return match ? { name: match[1], args: match[2] ?? '' } : undefined;
}
