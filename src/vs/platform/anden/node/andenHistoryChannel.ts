/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../files/common/files.js';
import { IUserDataProfilesService } from '../../userDataProfile/common/userDataProfile.js';
import { resolvePiSession } from './andenPiSession.js';
import { AndenHistoryResume, AndenHistorySummary, isHistoryId, maxHistoryBytes, parseHistoryRecord, parseHistorySummary } from '../common/andenHistory.js';

/** One writer across windows of the same desktop instance. A disconnected window loses its leases. */
export class AndenHistoryChannel implements IServerChannel<string> {
	private readonly queue = new Sequencer();
	private readonly owners = new Map<string, string>();

	constructor(private readonly files: IFileService, private readonly profiles: IUserDataProfilesService) { }

	listen<T>(): Event<T> { return Event.None; }

	releaseWindow(context: string): void {
		void this.queue.queue(async () => {
			for (const [key, owner] of this.owners) {
				if (owner === context) { this.owners.delete(key); }
			}
		});
	}

	async call<T>(context: string, command: string, args: unknown): Promise<T> {
		if (!context.startsWith('window:') || !Array.isArray(args)) { throw new Error('Invalid history request'); }
		return this.queue.queue(async () => {
			const [profileId, id, value] = args;
			const profile = this.profiles.profiles.find(profile => profile.id === profileId);
			if (!profile) { throw new Error('Unknown history profile'); }
			// Use the profile's own directory, even when it inherits global state from another profile.
			const root = joinPath(profile.location, 'anden-history');
			if (command === 'list') { return await this.list(root) as T; }
			if (!isHistoryId(id)) { throw new Error('Invalid history ID'); }
			const key = `${profile.id}:${id}`;
			const summary = joinPath(root, `${id}.summary.json`);
			const content = joinPath(root, `${id}.json`);
			switch (command) {
				case 'claim':
					if (this.owners.has(key) || await this.files.exists(summary) || await this.files.exists(content)) { throw new Error('History already exists'); }
					this.owners.set(key, context);
					break;
				case 'save': {
					if (this.owners.get(key) !== context) { throw new Error('History is not owned by this window'); }
					const record = parseHistoryRecord(value, id);
					const metadata = parseHistorySummary(value, id);
					if (!record || !metadata) { throw new Error('Invalid history record'); }
					const data = VSBuffer.fromString(JSON.stringify(record));
					if (data.byteLength > maxHistoryBytes) { throw new Error('History exceeds size limit'); }
					const atomic = { postfix: '.tmp' };
					await this.files.writeFile(content, data, { atomic });
					await this.files.writeFile(summary, VSBuffer.fromString(JSON.stringify(metadata)), { atomic });
					break;
				}
				case 'release':
					if (this.owners.get(key) === context) { this.owners.delete(key); }
					break;
				case 'read':
					return parseHistoryRecord(await this.read(content, maxHistoryBytes), id) as T;
				case 'canResume':
				case 'resume': {
					if (command === 'resume' && this.owners.has(key)) { return { kind: 'busy' } satisfies AndenHistoryResume as T; }
					const record = parseHistoryRecord(await this.read(content, maxHistoryBytes), id);
					const native = record?.piSession && await resolvePiSession(record.piSession, record.folder);
					if (command === 'canResume') { return !!native as T; }
					if (!record || !native) { return { kind: 'unavailable' } satisfies AndenHistoryResume as T; }
					this.owners.set(key, context);
					return { kind: 'ready', record: { ...record, piSession: native } } satisfies AndenHistoryResume as T;
				}
				case 'delete':
					if (this.owners.has(key)) { return false as T; }
					// Delete the payload first; on a partial failure the entry remains visible and retryable.
					await this.delete(content);
					await this.delete(summary);
					return true as T;
				default: throw new Error('Unknown history command');
			}
			return undefined as T;
		});
	}

	private async list(root: URI): Promise<AndenHistorySummary[]> {
		let children;
		try { children = (await this.files.resolve(root)).children; }
		catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) { return []; }
			throw error;
		}
		const results = new Map<string, AndenHistorySummary>();
		for (const child of children ?? []) {
			if (!child.isFile || child.isSymbolicLink || !child.name.endsWith('.summary.json')) { continue; }
			const id = child.name.slice(0, -'.summary.json'.length);
			if (!isHistoryId(id)) { continue; }
			const summary = parseHistorySummary(await this.read(child.resource, 65536), id);
			if (summary) { results.set(id, summary); }
		}
		// Recover the last atomic payload if its summary was not written or became corrupt.
		for (const child of children ?? []) {
			if (!child.isFile || child.isSymbolicLink || !child.name.endsWith('.json')) { continue; }
			const id = child.name.slice(0, -'.json'.length);
			if (!isHistoryId(id) || results.has(id)) { continue; }
			const summary = parseHistorySummary(await this.read(child.resource, maxHistoryBytes), id);
			if (summary) { results.set(id, summary); }
		}
		return [...results.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
	}

	private async read(uri: URI, size: number): Promise<unknown> {
		try {
			const stat = await this.files.stat(uri);
			if (!stat.isFile || stat.isSymbolicLink || stat.size > size) { return undefined; }
			return JSON.parse((await this.files.readFile(uri, { limits: { size } })).value.toString());
		} catch {
			return undefined;
		}
	}

	private async delete(uri: URI): Promise<void> {
		try { await this.files.del(uri); }
		catch (error) { if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; } }
	}
}
