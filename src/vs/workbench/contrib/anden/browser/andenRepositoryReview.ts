/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IDiffEditorViewState } from '../../../../editor/common/editorCommon.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { emptyProgressRunner, IEditorProgressService } from '../../../../platform/progress/common/progress.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../services/textfile/common/textfiles.js';
import { ISCMService } from '../../scm/common/scm.js';
import { andenCodeFont, loadAndenCodeFont } from './andenTypography.js';

const groups = {
	conflicts: localize('conflicts', 'Conflicts'),
	staged: localize('staged', 'Staged · HEAD → Index'),
	unstaged: localize('unstaged', 'Unstaged · Index → Disk'),
	untracked: localize('untracked', 'Untracked'),
};
const kinds = {
	added: localize('added', 'Added'),
	modified: localize('modified', 'Modified'),
	deleted: localize('deleted', 'Deleted'),
	renamed: localize('renamed', 'Renamed'),
	conflict: localize('conflict', 'Conflict'),
	submodule: localize('submodule', 'Submodule'),
};
interface ReviewEntry {
	readonly group: keyof typeof groups;
	readonly kind: keyof typeof kinds;
	readonly path: string;
	readonly previousPath?: string;
	readonly original?: string;
	readonly modified?: string;
}
interface ReviewSnapshot {
	readonly status: 'ready' | 'disabled' | 'unavailable' | 'notRepository' | 'untrusted' | 'unsafe';
	readonly root?: string;
	readonly entries?: readonly ReviewEntry[];
}
export interface IAndenReviewState {
	readonly folder: URI;
	entry?: string;
	viewState?: IDiffEditorViewState;
}

const keyOf = (entry: ReviewEntry) => `${entry.group}:${entry.path}`;
const maxReviewBytes = 2 * 1024 * 1024;

export class AndenRepositoryReview extends Disposable {
	private readonly editorInstantiation: IInstantiationService;
	private readonly title: HTMLElement;
	private readonly status: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly refreshButton: HTMLButtonElement;
	private readonly list: HTMLElement;
	private readonly preview: HTMLElement;
	private readonly message: HTMLElement;
	private readonly editorHost: HTMLElement;
	private selectedButton: HTMLButtonElement | undefined;
	private readonly subscriptions = this._register(new DisposableStore());
	private readonly fileWatches = this._register(new DisposableStore());
	private readonly models = this._register(new MutableDisposable<DisposableStore>());
	private readonly diffRefresh = this._register(new RunOnceScheduler(() => void this.loadDiff(), 200));
	private readonly statusRefresh = this._register(new RunOnceScheduler(() => void this.loadEntries(), 150));
	private state: IAndenReviewState | undefined;
	private root: URI | undefined;
	private entries: readonly ReviewEntry[] = [];
	private editor: DiffEditorWidget | undefined;
	private diffRequest: CancellationTokenSource | undefined;
	private modelKey: string | undefined;
	private statusVersion = 0;

	constructor(
		private readonly container: HTMLElement,
		private readonly updateCount: (count: number | undefined) => void,
		@ICommandService private readonly commands: ICommandService,
		@IInstantiationService instantiation: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languages: ILanguageService,
		@ITextFileService private readonly texts: ITextFileService,
		@IFileService private readonly files: IFileService,
		@ISCMService private readonly scm: ISCMService,
		@IUriIdentityService private readonly uris: IUriIdentityService,
		@ILogService private readonly log: ILogService,
		@IWorkspaceTrustManagementService trust: IWorkspaceTrustManagementService,
	) {
		super();
		// The standard diff editor gets progress from its editor group. Anden has no editor group.
		const progress: IEditorProgressService = { _serviceBrand: undefined, show: () => emptyProgressRunner, showWhile: async promise => { await promise; } };
		this.editorInstantiation = this._register(instantiation.createChild(new ServiceCollection([IEditorProgressService, progress])));
		this.toolbar = append(container, $('div.anden-review-toolbar'));
		this.title = append(this.toolbar, $('h2', {}, localize('repositoryChanges', 'Repository Changes')));
		this.refreshButton = append(this.toolbar, $<HTMLButtonElement>('button', { type: 'button' }, localize('refresh', 'Refresh')));
		this.refreshButton.onclick = () => void this.loadEntries(true);
		this.status = append(container, $('div.anden-review-status', { role: 'status' }));
		const body = append(container, $('div.anden-review-body'));
		this.list = append(body, $('nav.anden-review-files', { 'aria-label': localize('changedFiles', 'Changed files') }));
		this.preview = append(body, $('section.anden-review-preview', { 'aria-label': localize('diffPreview', 'Diff preview') }));
		this.message = append(this.preview, $('div.anden-review-message', { role: 'status' }));
		this.editorHost = append(this.preview, $('div.anden-review-editor'));
		this.editorHost.hidden = true;
		this._register(scm.onDidAddRepository(() => this.bindRepository()));
		this._register(scm.onDidRemoveRepository(() => {
			if (this.root) {
				this.bindRepository();
				this.statusRefresh.schedule();
			}
		}));
		this._register(files.onDidFilesChange(event => {
			const entry = this.getEntry();
			if (entry && [entry.original, entry.modified].some(side => side && event.contains(URI.parse(side)))) {
				this.diffRefresh.schedule();
			}
		}));
		this._register(trust.onDidChangeTrustedFolders(async () => {
			const state = this.state;
			const root = this.root;
			if (state && root && (!(await trust.getUriTrustInfo(state.folder)).trusted || !(await trust.getUriTrustInfo(root)).trusted) && this.state === state) {
				this.show(undefined);
				this.updateCount(undefined);
				this.state = state;
				this.container.hidden = false;
				this.setStatus(localize('reviewTrustRequired', 'Trust the repository to review its changes.'));
			}
		}));
	}

	show(state: IAndenReviewState | undefined): void {
		if (this.state === state) {
			return;
		}
		this.saveViewState();
		this.state = state;
		this.root = undefined;
		this.subscriptions.clear();
		this.statusRefresh.cancel();
		this.statusVersion++;
		this.clearDiff();
		this.entries = [];
		this.renderFiles();
		this.container.hidden = !state;
		this.title.title = '';
		this.title.textContent = localize('repositoryChanges', 'Repository Changes');
		if (state) {
			this.setStatus(localize('openingRepository', 'Opening repository…'));
			void this.loadEntries();
		}
	}

	focus(): void {
		this.refreshButton.focus();
	}

	private bindRepository(): void {
		this.subscriptions.clear();
		const root = this.root;
		if (!root) {
			return;
		}
		const repository = [...this.scm.repositories].find(({ provider }) => provider.providerId === 'git' && this.uris.extUri.isEqual(provider.rootUri, root));
		if (repository) {
			this.subscriptions.add(repository.provider.onDidChangeResources(() => this.statusRefresh.schedule()));
		}
	}

	private async loadEntries(refresh = false): Promise<void> {
		const state = this.state;
		if (!state) {
			return;
		}
		const version = ++this.statusVersion;
		try {
			let entries: readonly ReviewEntry[];
			if (!this.root) {
				const result = await this.commands.executeCommand<ReviewSnapshot>('_git.anden.openReview', state.folder);
				if (version !== this.statusVersion) {
					return;
				}
				if (result?.status !== 'ready' || !result.root || !result.entries) {
					const messages = {
						ready: localize('invalidReview', 'Git did not return a repository to review.'),
						disabled: localize('reviewGitDisabled', 'Git is disabled.'),
						unavailable: localize('reviewGitUnavailable', 'Git or this repository is unavailable.'),
						notRepository: localize('reviewNotRepository', 'This folder is not in a Git repository.'),
						untrusted: localize('reviewTrustRequired', 'Trust the repository to review its changes.'),
						unsafe: localize('reviewUnsafe', 'Git refused to open this repository because of its ownership.'),
					};
					this.setStatus(messages[result?.status ?? 'unavailable']);
					this.updateCount(undefined);
					return;
				}
				this.root = URI.parse(result.root);
				this.bindRepository();
				entries = result.entries;
			} else {
				const result = await this.commands.executeCommand<readonly ReviewEntry[] | undefined>('_git.anden.reviewState', this.root, refresh);
				if (version !== this.statusVersion) {
					return;
				}
				if (!result) {
					this.root = undefined;
					this.subscriptions.clear();
					this.entries = [];
					this.renderFiles();
					this.clearDiff();
					this.updateCount(undefined);
					this.setStatus(localize('reviewRepositoryClosed', 'The repository is no longer available.'));
					return;
				}
				entries = result;
			}
			const count = new Set(entries.map(entry => entry.path)).size;
			this.updateCount(count);
			this.title.title = this.root.fsPath;
			this.title.textContent = localize('repositoryChangesCount', 'Repository Changes · {0}', count);
			this.setStatus(count ? this.root.fsPath : localize('reviewClean', 'No changes in {0}', this.root.fsPath));
			const changed = JSON.stringify(entries) !== JSON.stringify(this.entries);
			this.entries = entries;
			if (!this.getEntry()) {
				this.clearDiff();
				state.entry = entries.length ? keyOf(entries[0]) : undefined;
				state.viewState = undefined;
			}
			if (changed || !this.list.childElementCount) {
				this.renderFiles();
			}
			if (state.entry) {
				this.diffRefresh.schedule(0);
			} else {
				this.clearDiff();
			}
		} catch (error) {
			if (version === this.statusVersion) {
				this.log.warn('Anden: failed to read repository status', error);
				this.entries = [];
				this.renderFiles();
				this.clearDiff();
				this.updateCount(undefined);
				this.setStatus(localize('reviewError', 'Could not read repository changes. Check the Git log or try refreshing.'));
			}
		}
	}

	private setStatus(message: string): void {
		this.status.textContent = message;
		this.status.title = message;
	}

	private renderFiles(): void {
		const focused = this.list.contains(this.list.ownerDocument.activeElement) ? (this.list.ownerDocument.activeElement as HTMLElement).dataset.reviewKey : undefined;
		clearNode(this.list);
		this.selectedButton = undefined;
		for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
			const entries = this.entries.filter(entry => entry.group === group);
			if (!entries.length) {
				continue;
			}
			append(this.list, $('h3', {}, groups[group]));
			const list = append(this.list, $('ul'));
			for (const entry of entries) {
				const key = keyOf(entry);
				const path = entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path;
				const button = append(append(list, $('li')), $<HTMLButtonElement>('button', { type: 'button', title: path, 'aria-current': String(this.state?.entry === key) },
					$('span.anden-review-path', {}, path), $('span.anden-review-kind', {}, kinds[entry.kind])));
				button.dataset.reviewKey = key;
				if (this.state?.entry === key) {
					this.selectedButton = button;
				}
				button.onclick = () => {
					if (!this.state || this.state.entry === key) {
						return;
					}
					this.state.entry = key;
					this.state.viewState = undefined;
					this.clearDiff();
					this.selectedButton?.setAttribute('aria-current', 'false');
					this.selectedButton = button;
					button.setAttribute('aria-current', 'true');
					void this.loadDiff();
				};
				if (key === focused) {
					button.focus();
				}
			}
		}
		if (focused && !this.list.contains(this.list.ownerDocument.activeElement)) {
			this.focus();
		}
	}

	private getEntry(): ReviewEntry | undefined {
		return this.entries.find(entry => keyOf(entry) === this.state?.entry);
	}

	private saveViewState(): void {
		if (this.state && this.state.entry === this.modelKey && this.editor?.getModel()) {
			this.state.viewState = this.editor.saveViewState();
		}
	}

	private clearDiff(): void {
		this.diffRequest?.dispose(true);
		this.diffRequest = undefined;
		this.diffRefresh.cancel();
		this.fileWatches.clear();
		this.editor?.setModel(null);
		this.models.clear();
		this.modelKey = undefined;
		this.editorHost.hidden = true;
		this.message.textContent = '';
	}

	private async loadDiff(): Promise<void> {
		const state = this.state;
		const entry = this.getEntry();
		const root = this.root;
		if (!state || !entry || !root) {
			return;
		}
		this.diffRequest?.dispose(true);
		const request = this.diffRequest = new CancellationTokenSource();
		const { token } = request;
		this.fileWatches.clear();
		if (entry.kind === 'conflict' || entry.kind === 'submodule') {
			this.clearDiff();
			this.message.textContent = entry.kind === 'conflict' ? localize('reviewConflict', 'This file has a Git conflict. Resolve it outside the review view.') : localize('reviewSubmodule', 'Text diffs are not available for submodules.');
			return;
		}
		if (!this.editor?.getModel()) {
			this.message.textContent = localize('reviewLoadingDiff', 'Loading diff…');
		}
		try {
			const [original, modified] = [entry.original, entry.modified].map(side => side ? URI.parse(side) : undefined);
			for (const resource of [original, modified]) {
				if (resource) {
					this.fileWatches.add(this.files.watch(resource));
				}
			}
			const [before, after] = await Promise.all([this.readSide(root, original), this.readSide(root, modified), loadAndenCodeFont(this.container.ownerDocument)]);
			if (token.isCancellationRequested) {
				return;
			}
			if (before === undefined || after === undefined) {
				this.clearDiff();
				this.message.textContent = localize('reviewNotRegularFile', 'Text diffs are only available for regular files inside the repository.');
				return;
			}
			this.saveViewState();
			this.message.textContent = '';
			this.editorHost.hidden = false;
			const editor = this.editor ??= this._register(this.editorInstantiation.createInstance(DiffEditorWidget, this.editorHost, {
				fontFamily: `${andenCodeFont.fontFamily}, monospace`,
				fontSize: andenCodeFont.fontSize,
				fontWeight: String(andenCodeFont.fontWeight),
				readOnly: true,
				isInEmbeddedEditor: true,
				originalEditable: false,
				renderMarginRevertIcon: false,
				renderGutterMenu: false,
				renderSideBySideInlineBreakpoint: 620,
				scrollBeyondLastLine: false,
				automaticLayout: true,
				minimap: { enabled: false },
				originalAriaLabel: localize('before', 'Original code'),
				modifiedAriaLabel: localize('after', 'Modified code'),
			}, {}));
			const current = editor.getModel();
			if (this.modelKey === keyOf(entry) && current?.original.getValue() === before && current.modified.getValue() === after) {
				return;
			}
			const models = new DisposableStore();
			const language = this.languages.createByFilepathOrFirstLine(modified ?? original ?? null, (after || before).slice(0, 256).split('\n')[0]);
			const originalModel = models.add(this.modelService.createModel(before, language));
			const modifiedModel = models.add(this.modelService.createModel(after, language));
			editor.setModel({ original: originalModel, modified: modifiedModel });
			this.models.value = models;
			this.modelKey = keyOf(entry);
			if (state.viewState) {
				editor.restoreViewState(state.viewState);
			}
			editor.layout();
		} catch (error) {
			if (!token.isCancellationRequested) {
				this.log.warn('Anden: failed to open review diff', error);
				this.clearDiff();
				this.message.textContent = error instanceof TextFileOperationError && error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY
					? localize('reviewBinary', 'No text diff is available for this binary file.')
					: error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE
						? localize('reviewTooLarge', 'This file is too large to review here (limit: 2 MiB per side).')
						: localize('reviewDiffError', 'Could not read this diff. The file may have changed; try refreshing.');
			}
		} finally {
			if (this.diffRequest === request) {
				this.diffRequest = undefined;
			}
			request.dispose();
		}
	}

	private async readSide(root: URI, resource: URI | undefined): Promise<string | undefined> {
		if (!resource) {
			return '';
		}
		if (resource.scheme === Schemas.file && !await this.commands.executeCommand<boolean>('_git.anden.isReviewFile', root, resource)) {
			return undefined;
		}
		const stat = await this.files.stat(resource);
		if (!stat.isFile || stat.isSymbolicLink) {
			return undefined;
		}
		// The Git provider reads entire blobs. Check the size before asking it for contents.
		if (stat.size > maxReviewBytes) {
			throw new FileOperationError('Anden review size limit exceeded', FileOperationResult.FILE_TOO_LARGE);
		}
		return (await this.texts.read(resource, { acceptTextOnly: true, limits: { size: maxReviewBytes } })).value;
	}

	override dispose(): void {
		this.statusVersion++;
		this.clearDiff();
		super.dispose();
	}
}
