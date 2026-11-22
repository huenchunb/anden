/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { CancellationTokenSource, commands, Disposable, RelativePattern, Uri, workspace } from 'vscode';
import type { AndenSummary } from '../andenSummary';
import type { Model } from '../model';
import type { Repository } from '../repository';
import { pathEquals } from '../util';
import type { GitExtensionImpl } from './extension';

type OpenResult = 'notRepository' | 'unsafe' | 'untrusted' | 'unavailable' | 'disabled';

interface SessionLease {
	readonly id: string;
	readonly folder: Uri;
	watch?: RepositoryWatch;
}

/** Owns one calculation/cache per Git model repository, even across several sessions. */
class RepositoryWatch {
	readonly sessions = new Set<SessionLease>();
	private readonly listeners: Disposable;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: CancellationTokenSource | undefined;
	private dirty = false;
	private disposed = false;
	summary: AndenSummary | undefined;

	constructor(readonly model: Model, readonly repository: Repository, onClose: () => void, private readonly onSummary: (summary: AndenSummary | undefined) => void) {
		const commonDir = repository.dotGit.commonPath ?? repository.dotGit.path;
		const packedRefs = path.join(commonDir, 'packed-refs');
		const refs = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(commonDir), '{refs/heads/**,packed-refs}'));
		const onRefChange = (uri: Uri) => {
			const branch = this.summary?.branch;
			if (branch && (pathEquals(uri.fsPath, packedRefs) || pathEquals(uri.fsPath, path.join(commonDir, 'refs', 'heads', branch)))) {
				this.invalidate();
			}
		};
		this.listeners = Disposable.from(
			refs, refs.onDidChange(onRefChange), refs.onDidCreate(onRefChange), refs.onDidDelete(onRefChange),
			repository.onDidChangeWorkingTree(() => this.invalidate()),
			repository.onDidChangeRepository(() => this.invalidate()),
			model.onDidCloseRepository(closed => { if (closed === repository) { onClose(); } }),
		);
		this.invalidate();
	}

	invalidate(): void {
		this.dirty = true;
		this.running?.cancel();
		this.schedule();
	}

	private schedule(): void {
		if (this.disposed || !this.dirty || this.timer || this.running) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.update();
		}, 200);
	}

	private async update(): Promise<void> {
		this.dirty = false;
		const request = this.running = new CancellationTokenSource();
		try {
			const result = await this.repository.getAndenSummary(request.token);
			if (!request.token.isCancellationRequested) {
				if (result) {
					const previous = this.summary;
					this.summary = result;
					if (previous?.branch !== result.branch || previous?.commit !== result.commit || previous?.lines?.added !== result.lines?.added || previous?.lines?.deleted !== result.lines?.deleted) {
						this.onSummary(result);
					}
				} else {
					this.dirty = true;
				}
			}
		} catch {
			if (!request.token.isCancellationRequested) {
				this.summary = undefined;
				this.onSummary(undefined);
			}
		} finally {
			request.dispose();
			this.running = undefined;
			this.schedule();
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.running?.cancel();
		this.listeners.dispose();
	}
}

export class AndenRepositorySubscriptions {
	private readonly leases = new Map<string, SessionLease>();
	private readonly watches = new Map<Repository, RepositoryWatch>();
	private readonly trustListener = workspace.onDidChangeWorkspaceTrustedFolders(() => { void this.updateTrust().catch(() => { }); });

	constructor(private readonly extension: GitExtensionImpl) { }

	watch(id: string, folder: Uri): void {
		if (!this.leases.has(id)) {
			this.leases.set(id, { id, folder });
		}
		// Register the lease immediately; repository context must never block the agent.
		void this.open(id, false).catch(() => { });
	}

	async open(id: string, interactive: boolean): Promise<Repository | OpenResult> {
		const lease = this.leases.get(id);
		const model = this.extension.model;
		if (!lease || !model) {
			return 'unavailable';
		}
		if (lease.folder.scheme !== 'file' || !workspace.getConfiguration('git', lease.folder).get<boolean>('enabled')) {
			return 'disabled';
		}
		const repository = await model.openSessionRepository(lease.folder, interactive);
		if (typeof repository === 'string') {
			return repository;
		}
		if (this.leases.get(id) !== lease) {
			if (!this.watches.has(repository)) {
				model.releaseSessionRepository(repository);
			}
			return 'unavailable';
		}
		if (lease.watch?.repository === repository) {
			return repository;
		}
		this.detach(lease);
		let watch = this.watches.get(repository);
		if (!watch) {
			watch = new RepositoryWatch(model, repository, () => this.closeWatch(repository, true), summary => {
				for (const session of this.watches.get(repository)?.sessions ?? []) {
					this.notify(session, summary);
				}
			});
			this.watches.set(repository, watch);
		}
		lease.watch = watch;
		watch.sessions.add(lease);
		this.notify(lease, watch.summary);
		return repository;
	}

	refresh(repository: Repository): void {
		this.watches.get(repository)?.invalidate();
	}

	unwatch(id: string): void {
		const lease = this.leases.get(id);
		if (lease) {
			this.leases.delete(id);
			this.detach(lease);
		}
	}

	private notify(lease: SessionLease, summary: AndenSummary | undefined): void {
		void commands.executeCommand('_anden.repositoryChanged', lease.id, summary ?? null).then(undefined, () => { });
	}

	private detach(lease: SessionLease): void {
		const watch = lease.watch;
		lease.watch = undefined;
		watch?.sessions.delete(lease);
		if (watch && !watch.sessions.size) {
			this.closeWatch(watch.repository, false);
		}
	}

	private closeWatch(repository: Repository, alreadyClosed: boolean): void {
		const watch = this.watches.get(repository);
		if (watch) {
			this.watches.delete(repository);
			watch.dispose();
			for (const session of watch.sessions) {
				session.watch = undefined;
				this.notify(session, undefined);
			}
			watch.sessions.clear();
			if (!alreadyClosed) {
				watch.model.releaseSessionRepository(repository);
			}
		}
	}

	private async updateTrust(): Promise<void> {
		for (const lease of this.leases.values()) {
			const watch = lease.watch;
			if (!watch) {
				this.watch(lease.id, lease.folder);
				continue;
			}
			const { repository } = watch;
			const paths = [repository.root, path.dirname(repository.dotGit.path), path.dirname(repository.dotGit.commonPath ?? repository.dotGit.path)];
			const trusted = await Promise.all(paths.map(value => workspace.isResourceTrusted(Uri.file(value))));
			if (lease.watch === watch && trusted.some(value => !value)) {
				this.closeWatch(repository, false);
			}
		}
	}

	dispose(): void {
		this.trustListener.dispose();
		this.leases.clear();
		for (const repository of this.watches.keys()) {
			this.closeWatch(repository, false);
		}
	}
}
