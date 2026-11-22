/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../base/common/path.js';

export const andenHistoryChannel = 'andenHistory';
export const maxHistoryName = 256;
export const maxDraftLength = 65536;
export const maxHistoryMessage = 131072;
export const maxHistoryText = 393216;
export const maxHistoryMessages = 500;
export const maxHistoryBytes = 3 * 1024 * 1024;

export interface AndenHistorySummary {
	readonly version: 1;
	readonly id: string;
	readonly label: string;
	readonly agent: 'pi';
	readonly folder: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface AndenHistoryMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly complete: boolean;
}

/** A candidate reported by Pi, not proof that the native file exists yet. */
export interface AndenPiSession {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
}

export interface AndenHistoryRecord extends AndenHistorySummary {
	readonly piSession?: AndenPiSession;
	readonly draft: string;
	readonly messages: readonly AndenHistoryMessage[];
	readonly truncated: boolean;
}

export function isHistoryId(id: unknown): id is string {
	return typeof id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(id);
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export function parsePiSession(value: unknown): AndenPiSession | undefined {
	const v = object(value);
	const absolutePath = (path: unknown): path is string => typeof path === 'string' && path.length <= 8192 && !/[\0\r\n]/.test(path) && isAbsolute(path);
	if (!v || !isHistoryId(v.sessionId) || !absolutePath(v.sessionFile) || !v.sessionFile.endsWith('.jsonl') || !absolutePath(v.cwd)) { return undefined; }
	return { sessionId: v.sessionId, sessionFile: v.sessionFile, cwd: v.cwd };
}

export type AndenHistoryResume = { readonly kind: 'ready'; readonly record: AndenHistoryRecord } | { readonly kind: 'busy' | 'unavailable' };

export function parseHistorySummary(value: unknown, id: string): AndenHistorySummary | undefined {
	const v = object(value);
	if (!v || v.version !== 1 || !isHistoryId(id) || v.id !== id || typeof v.label !== 'string' || !v.label.trim() || v.label.length > maxHistoryName || v.agent !== 'pi' || typeof v.folder !== 'string' || v.folder.length > 8192 || v.folder.includes('\0') || !isAbsolute(v.folder) || typeof v.createdAt !== 'number' || !Number.isSafeInteger(v.createdAt) || v.createdAt < 0 || typeof v.updatedAt !== 'number' || !Number.isSafeInteger(v.updatedAt) || v.updatedAt < v.createdAt) { return undefined; }
	return { version: 1, id, label: v.label, agent: v.agent, folder: v.folder, createdAt: v.createdAt, updatedAt: v.updatedAt };
}

export function parseHistoryRecord(value: unknown, id: string): AndenHistoryRecord | undefined {
	const summary = parseHistorySummary(value, id);
	const v = object(value);
	if (!summary || !v || typeof v.draft !== 'string' || v.draft.length > maxDraftLength || typeof v.truncated !== 'boolean' || !Array.isArray(v.messages) || v.messages.length > maxHistoryMessages) { return undefined; }
	const messages: AndenHistoryMessage[] = [];
	let size = 0;
	for (const entry of v.messages) {
		const m = object(entry);
		if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.complete !== 'boolean' || typeof m.text !== 'string' || m.text.length > maxHistoryMessage || (size += m.text.length) > maxHistoryText) { return undefined; }
		messages.push({ role: m.role, text: m.text, complete: m.complete });
	}
	const piSession = parsePiSession(v.piSession);
	return { ...summary, ...(piSession ? { piSession } : {}), draft: v.draft, messages, truncated: v.truncated };
}
