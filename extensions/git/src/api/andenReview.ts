/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { commands, Disposable, Uri, workspace } from 'vscode';
import type { GitExtensionImpl } from './extension';
import { AndenRepositorySubscriptions } from './andenRepositorySubscriptions';
import { Status } from './git.constants';
import type { Repository, Resource } from '../repository';
import { toGitUri } from '../uri';
import { isDescendant, pathEquals } from '../util';

type ReviewResource = Pick<Resource, 'type' | 'resourceUri' | 'original'>;
type ReviewRepository = Pick<Repository, 'root' | 'submodules'> & Record<'indexGroup' | 'workingTreeGroup' | 'untrackedGroup' | 'mergeGroup', { readonly resourceStates: readonly ReviewResource[] }>;

export function reviewEntries(repository: ReviewRepository) {
	const submodules = repository.submodules.map(submodule => path.join(repository.root, submodule.path));
	const gitUri = (uri: Uri, ref: string) => toGitUri(uri, ref, { reviewRoot: repository.root }).toString();
	function entry(resource: ReviewResource, group: 'staged' | 'unstaged' | 'untracked' | 'conflicts') {
		const { type, resourceUri, original } = resource;
		const staged = group === 'staged';
		const added = type === Status.INDEX_ADDED || type === Status.INTENT_TO_ADD || group === 'untracked';
		const deleted = type === Status.INDEX_DELETED || type === Status.DELETED;
		const renamed = type === Status.INDEX_RENAMED || type === Status.INDEX_COPIED || type === Status.INTENT_TO_RENAME;
		const submodule = submodules.some(submodule => pathEquals(submodule, resourceUri.fsPath));
		const kind = group === 'conflicts' ? 'conflict' : submodule ? 'submodule' : added ? 'added' : deleted ? 'deleted' : renamed ? 'renamed' : 'modified';
		const beforePath = renamed ? original : resourceUri;
		const reviewable = !submodule && group !== 'conflicts';
		return {
			group, kind,
			path: path.relative(repository.root, resourceUri.fsPath),
			previousPath: renamed ? path.relative(repository.root, original.fsPath) : undefined,
			original: reviewable && !added ? gitUri(beforePath, staged ? 'HEAD' : '') : undefined,
			modified: reviewable && !deleted ? (staged ? gitUri(resourceUri, '') : resourceUri.toString()) : undefined,
		};
	}
	return [
		...repository.mergeGroup.resourceStates.map(resource => entry(resource, 'conflicts')),
		...repository.indexGroup.resourceStates.map(resource => entry(resource, 'staged')),
		...repository.workingTreeGroup.resourceStates.filter(resource => resource.type !== Status.IGNORED)
			.map(resource => entry(resource, resource.type === Status.UNTRACKED ? 'untracked' : 'unstaged')),
		...repository.untrackedGroup.resourceStates.map(resource => entry(resource, 'untracked')),
	];
}

/** Private bridge for Anden's empty-window, read-only repository view. */
export function registerAndenReviewCommands(extension: GitExtensionImpl): Disposable {
	const subscriptions = new AndenRepositorySubscriptions(extension);
	return Disposable.from(
		subscriptions,
		commands.registerCommand('_git.anden.watchRepository', (id: string, folder: Uri) => subscriptions.watch(id, folder)),
		commands.registerCommand('_git.anden.unwatchRepository', (id: string) => subscriptions.unwatch(id)),
		commands.registerCommand('_git.anden.openReview', async (id: string) => {
			const repository = await subscriptions.open(id, true);
			if (typeof repository === 'string') {
				return { status: repository };
			}
			await repository.status();
			subscriptions.refresh(repository);
			return { status: 'ready', root: Uri.file(repository.root).toString(), entries: reviewEntries(repository) };
		}),
		commands.registerCommand('_git.anden.reviewState', async (root: Uri, refresh: boolean) => {
			const repository = extension.model?.repositories.find(repository => pathEquals(repository.root, root.fsPath));
			if (!repository || !await workspace.isResourceTrusted(root)) {
				return undefined;
			}
			if (refresh) {
				await repository.status();
				subscriptions.refresh(repository);
			}
			return reviewEntries(repository);
		}),
		commands.registerCommand('_git.anden.isReviewFile', async (root: Uri, file: Uri) => {
			if (root.scheme !== 'file' || file.scheme !== 'file' || !isDescendant(root.fsPath, file.fsPath) || !await workspace.isResourceTrusted(root)) {
				return false;
			}
			// Do not open a symlink or a path that resolves outside the repository.
			const [stat, realRoot, realFile] = await Promise.all([fs.lstat(file.fsPath), fs.realpath(root.fsPath), fs.realpath(file.fsPath)]);
			return stat.isFile() && !stat.isSymbolicLink() && isDescendant(realRoot, realFile);
		}),
	);
}
