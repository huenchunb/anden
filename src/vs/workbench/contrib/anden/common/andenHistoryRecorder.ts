/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AndenPiSession, AndenHistoryMessage, AndenHistoryRecord, AndenHistorySummary, maxDraftLength, maxHistoryMessage, maxHistoryMessages, maxHistoryText } from '../../../../platform/anden/common/andenHistory.js';
import { AndenAgentUpdate } from './andenAgent.js';

interface Entry extends AndenHistoryMessage {
	readonly id: string;
}

/** Projects UI events into an allowlisted, bounded transcript. Never records tool or approval events. */
export class AndenHistoryRecorder {
	private readonly messages: Entry[] = [];
	private truncated = false;
	private draft = '';
	private size = 0;
	private piSession: AndenPiSession | undefined;

	constructor(private readonly summary: AndenHistorySummary, restored?: AndenHistoryRecord) {
		if (!restored) { return; }
		this.piSession = restored.piSession;
		this.draft = restored.draft;
		this.truncated = restored.truncated;
		for (const [index, message] of restored.messages.entries()) {
			this.messages.push({ ...message, id: `history:${index}` });
			this.size += message.text.length;
		}
	}

	setDraft(value: string): boolean {
		const draft = value.slice(0, maxDraftLength);
		if (this.draft === draft) { return false; }
		this.draft = draft;
		return true;
	}

	apply(update: AndenAgentUpdate): boolean {
		switch (update.kind) {
			case 'piSession':
				this.piSession = update.session;
				return true;
			case 'user': return this.put(update.id, 'user', update.text, false, false);
			case 'text': return this.put(update.id, 'assistant', update.text, !update.append, update.append);
			case 'userAccepted': {
				const index = this.messages.findIndex(message => message.role === 'user' && message.id === update.id);
				if (index < 0) { return false; }
				this.messages[index] = { ...this.messages[index], complete: true };
				return true;
			}
			default: return false;
		}
	}

	snapshot(label: string): AndenHistoryRecord {
		return { version: 1, id: this.summary.id, agent: this.summary.agent, folder: this.summary.folder, createdAt: this.summary.createdAt, ...(this.piSession ? { piSession: this.piSession } : {}), label, updatedAt: Math.max(Date.now(), this.summary.createdAt), draft: this.draft, truncated: this.truncated, messages: this.messages.map(({ role, text, complete }) => ({ role, text, complete })) };
	}

	private put(id: string, role: Entry['role'], value: string, complete: boolean, append: boolean): boolean {
		if (!id || !value) { return false; }
		const index = this.messages.findIndex(message => message.role === role && message.id === id);
		const previous = this.messages[index];
		if (append && previous?.complete) { return false; }
		if (append && previous?.text.length === maxHistoryMessage) {
			const changed = !this.truncated;
			this.truncated = true;
			return changed;
		}
		const raw = append && previous ? previous.text + value : value;
		const text = raw.slice(0, maxHistoryMessage);
		this.truncated ||= raw.length > text.length;
		const entry = { id, role, text, complete };
		if (previous) { this.messages[index] = entry; }
		else { this.messages.push(entry); }
		this.size += text.length - (previous?.text.length ?? 0);
		while (this.messages.length > maxHistoryMessages || this.size > maxHistoryText) {
			const oldest = this.messages.shift();
			this.size -= oldest?.text.length ?? 0;
			this.truncated = true;
		}
		return true;
	}
}
