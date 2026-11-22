/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CancellationError, CancellationToken } from 'vscode';
import { GitError, type Repository } from './git';
import { isDescendant } from './util';

interface LineCounts { added: number; deleted: number }
export interface AndenSummary {
	readonly branch?: string;
	readonly commit?: string;
	readonly lines?: LineCounts;
}

const maxExtraFiles = 1000;
const maxExtraFileBytes = 2 * 1024 * 1024;
const maxExtraBytes = 16 * 1024 * 1024;
const diffOptions = ['--numstat', '-z', '--no-ext-diff', '--no-textconv'];
const env = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };

export function parseNumstat(output: string): LineCounts {
	const records = output.split('\0');
	const totals = { added: 0, deleted: 0 };
	for (let i = 0; i < records.length - 1; i++) {
		const record = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
		if (!record) {
			throw new Error('Invalid Git numstat record');
		}
		if (!record[3]) {
			// A rename/copy has two additional NUL-terminated path fields.
			i += 2;
		}
		if (record[1] !== '-' && record[2] !== '-') {
			totals.added += Number(record[1]);
			totals.deleted += Number(record[2]);
		}
	}
	return totals;
}

export function countNewTextLines(bytes: Buffer): number {
	// Match Git's binary heuristic for files that do not yet have an index entry.
	if (bytes.subarray(0, 8000).includes(0) || !bytes.length) {
		return 0;
	}
	let count = 0;
	for (const byte of bytes) {
		if (byte === 10) {
			count++;
		}
	}
	return count + Number(bytes[bytes.length - 1] !== 10);
}

function cancelIfRequested(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

/** Undefined means HEAD moved while reading; the caller should try again. */
export async function getAndenSummary(repository: Pick<Repository, 'root' | 'exec' | 'getObjectDetails' | 'buffer'>, token: CancellationToken): Promise<AndenSummary | undefined> {
	const exec = async (args: string[], acceptedExitCode?: number) => {
		cancelIfRequested(token);
		try {
			return (await repository.exec(args, { env, cancellationToken: token })).stdout;
		} catch (error) {
			if (error instanceof GitError && error.exitCode === acceptedExitCode && !error.stderr) {
				return error.stdout ?? '';
			}
			throw error;
		}
	};
	const readHead = async () => {
		const [branch, commit] = await Promise.all([
			exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], 1),
			exec(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 1),
		]);
		return { branch: branch.trim() || undefined, commit: commit.trim() || undefined };
	};
	const head = await readHead();
	let lines: LineCounts | undefined;
	let scratch: string | undefined;
	try {
		const base = head.commit ?? (await exec(['hash-object', '-t', 'tree', '--stdin'])).trim();
		const [untrackedOutput, removedOutput] = await Promise.all([
			exec(['ls-files', '--others', '--exclude-standard', '-z', '--']),
			exec(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=D', '-z', base, '--']),
		]);
		const untracked = new Set(untrackedOutput.split('\0').filter(Boolean));
		const removed = removedOutput.split('\0').filter(Boolean);
		if (untracked.size + removed.length > maxExtraFiles) {
			throw new Error('Too many files to calculate session line counts');
		}
		const retained: string[] = [];
		for (const name of removed) {
			cancelIfRequested(token);
			try {
				const stat = await fs.lstat(path.join(repository.root, name));
				if (stat.isFile() || stat.isSymbolicLink()) {
					retained.push(name);
					untracked.delete(name);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
					throw error;
				}
			}
		}
		const exclusions = retained.map(name => `:(exclude,literal)${name}`);
		const totals = parseNumstat(await exec(['diff', ...diffOptions, '--find-renames', '--ignore-submodules=all', base, '--', ...exclusions]));
		let extraBytes = 0;
		const realRoot = await fs.realpath(repository.root);
		const readFile = async (name: string) => {
			cancelIfRequested(token);
			const file = path.join(repository.root, name);
			const stat = await fs.lstat(file);
			if (!stat.isFile()) {
				return undefined;
			}
			const realFile = await fs.realpath(file);
			if (!isDescendant(realRoot, realFile) || stat.size > maxExtraFileBytes || extraBytes + stat.size > maxExtraBytes) {
				throw new Error('Cannot safely count lines for a working tree file');
			}
			const handle = await fs.open(realFile, 'r');
			try {
				const bytes = Buffer.alloc(stat.size + 1);
				let count = 0;
				while (count < bytes.length) {
					const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
					if (!bytesRead) {
						break;
					}
					count += bytesRead;
				}
				if (count !== stat.size) {
					throw new Error('Working tree file changed while counting lines');
				}
				extraBytes += count;
				return bytes.subarray(0, count);
			} finally {
				await handle.close();
			}
		};
		for (const name of untracked) {
			const bytes = await readFile(name);
			if (bytes) {
				totals.added += countNewTextLines(bytes);
			}
		}
		// Git's HEAD-to-disk diff uses the real index to find paths. A file removed only
		// from the index is reported as deleted, even if it still exists in the working tree.
		for (const name of retained) {
			const bytes = await readFile(name);
			const file = path.join(repository.root, name);
			const object = await repository.getObjectDetails(base, file, true);
			if (!bytes || !object.mode.startsWith('100') || object.size > maxExtraFileBytes || extraBytes + object.size > maxExtraBytes) {
				throw new Error('Cannot compare an index-only removal');
			}
			extraBytes += object.size;
			const previous = await repository.buffer(base, file, true);
			scratch ??= await fs.mkdtemp(path.join(os.tmpdir(), 'anden-diff-'));
			const before = path.join(scratch, 'before');
			const after = path.join(scratch, 'after');
			await Promise.all([fs.writeFile(before, previous), fs.writeFile(after, bytes)]);
			const delta = parseNumstat(await exec(['diff', '--no-index', ...diffOptions, '--', before, after], 1));
			totals.added += delta.added;
			totals.deleted += delta.deleted;
		}
		lines = totals;
	} catch {
		// Keep the branch visible, but never show a partial line total.
		cancelIfRequested(token);
	} finally {
		if (scratch) {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	}
	const currentHead = await readHead();
	return currentHead.branch === head.branch && currentHead.commit === head.commit ? { ...head, lines } : undefined;
}
