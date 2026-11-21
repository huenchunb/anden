/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const agents = [
	{ id: 'pi', label: 'Pi' },
	{ id: 'codex', label: 'Codex' },
] as const;

type Agent = typeof agents[number];

export interface Session<Terminal, Folder> {
	readonly terminal: Terminal;
	readonly folder: Folder;
	readonly label: string;
}

export function getPreferredFolder<Folder>(folders: readonly Folder[], activeFolder: Folder | undefined): Folder | undefined {
	return folders.length === 1 ? folders[0] : folders.find(folder => folder === activeFolder);
}

export class SessionRegistry<Terminal, Folder> {
	private readonly sessions = new Map<Terminal, Session<Terminal, Folder>>();
	private readonly counts = new Map<Agent['id'], number>();

	get all(): readonly Session<Terminal, Folder>[] {
		return [...this.sessions.values()];
	}

	create(agent: Agent, folder: Folder, createTerminal: (label: string) => Terminal): Terminal {
		const number = (this.counts.get(agent.id) ?? 0) + 1;
		const label = `${agent.label} · ${number}`;
		const terminal = createTerminal(label);
		this.counts.set(agent.id, number);
		this.sessions.set(terminal, { terminal, folder, label });
		return terminal;
	}

	has(terminal: Terminal): boolean {
		return this.sessions.has(terminal);
	}

	remove(terminal: Terminal): boolean {
		return this.sessions.delete(terminal);
	}
}
