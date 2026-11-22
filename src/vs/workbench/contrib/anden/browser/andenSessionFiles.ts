/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IContextMenuDelegate } from '../../../../base/browser/contextmenu.js';
import { $, append, DisposableResizeObserver, getClientArea, getWindow } from '../../../../base/browser/dom.js';
import { ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { toAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileKind, FileSystemProviderCapabilities, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import { IContentPart, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { SAVE_FILE_COMMAND_ID } from '../../files/browser/fileConstants.js';
import { IWorkingCopyFileService } from '../../../services/workingCopy/common/workingCopyFileService.js';
import { isAndenFileName, isAndenGitMetadata, isAndenSessionPath } from '../common/andenFileScope.js';
import { andenButton } from './andenIcons.js';

export class AndenSessionFiles extends Disposable {
	private readonly tree: WorkbenchAsyncDataTree<URI, IFileStat>;
	private readonly treeHost: HTMLElement;
	private readonly editorHost: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly status: HTMLElement;
	private readonly operationButton: HTMLButtonElement;
	private readonly watch = this._register(new MutableDisposable());
	private readonly refresh = this._register(new RunOnceScheduler(() => void this.refreshTree(), 200));
	private readonly tokenSource = new CancellationTokenSource();
	private readonly opens = new Sequencer();
	private part: IContentPart | undefined;
	private visible = false;
	private initialized = false;
	private updating = false;
	private editing = false;
	private closed = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly folder: URI,
		@IInstantiationService instantiation: IInstantiationService,
		@IFileService private readonly files: IFileService,
		@ICommandService private readonly commands: ICommandService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IWorkingCopyFileService private readonly workingFiles: IWorkingCopyFileService,
		@IUriIdentityService private readonly uris: IUriIdentityService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
	) {
		super();
		const explorer = append(container, $('section.anden-explorer', { 'aria-label': localize('andenExplorer', 'File Explorer') }));
		const toolbar = append(explorer, $('div.anden-explorer-toolbar'));
		append(toolbar, $('h2', {}, localize('andenFiles', 'Files')));
		const refresh = append(toolbar, andenButton(localize('andenRefreshFiles', 'Refresh Files'), 'refresh', true));
		refresh.onclick = () => this.refresh.schedule(0);
		this.operationButton = append(toolbar, andenButton(localize('andenFileActions', 'File Actions'), 'more', true));
		this.operationButton.setAttribute('aria-haspopup', 'menu');
		this.operationButton.onclick = () => this.showActions(this.operationButton, this.tree.getFocus()[0]);
		const root = append(explorer, $('div.anden-explorer-root', { title: folder.fsPath }, basename(folder) || folder.fsPath));
		root.onclick = () => { this.tree.setFocus([]); this.tree.setSelection([]); this.tree.domFocus(); };
		this.status = append(explorer, $('div.anden-explorer-status', { role: 'status' }));
		this.treeHost = append(explorer, $('div.anden-file-tree.show-file-icons'));
		const editor = append(container, $('div.anden-file-pane'));
		this.empty = append(editor, $('div.anden-file-empty', {}, localize('andenSelectFile', 'Select a file to open it in the editor.')));
		this.editorHost = append(editor, $('div.anden-native-editor'));
		this.editorHost.hidden = true;

		const labels = this._register(instantiation.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		const renderer: ITreeRenderer<IFileStat, void, IResourceLabel> = {
			templateId: 'andenFile',
			renderTemplate: element => labels.create(element),
			renderElement: ({ element: file }, _index, label) => {
				label.setFile(file.resource, { fileKind: file.isDirectory ? FileKind.FOLDER : FileKind.FILE, hidePath: true });
			},
			disposeTemplate: label => label.dispose(),
		};
		this.tree = this._register(instantiation.createInstance(WorkbenchAsyncDataTree<URI, IFileStat>, 'AndenFiles', this.treeHost,
			{ getHeight: () => 22, getTemplateId: () => renderer.templateId }, [renderer], {
			hasChildren: element => URI.isUri(element) || (element.isDirectory && !element.isSymbolicLink),
			getChildren: async element => {
				const resource = URI.isUri(element) ? element : element.resource;
				await this.requirePath(resource);
				return (await this.files.resolve(resource)).children?.filter(child => !isAndenGitMetadata(child.name)) ?? [];
			},
		}, {
			identityProvider: { getId: file => this.uris.extUri.getComparisonKey(file.resource) },
			accessibilityProvider: { getWidgetAriaLabel: () => localize('andenSessionFiles', 'Session files'), getAriaLabel: file => file.isSymbolicLink ? localize('andenLinkLabel', '{0}, symbolic link', file.name) : file.name },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: file => file.name },
			sorter: { compare: (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name) },
			multipleSelectionSupport: false,
		}));
		this._register(this.tree.onDidOpen(event => {
			if (event.element && (!event.element.isDirectory || event.element.isSymbolicLink)) { void this.open(event.element.resource); }
		}));
		this._register(this.tree.onContextMenu(event => {
			if (event.element) { this.tree.setSelection([event.element]); this.tree.setFocus([event.element]); }
			this.showActions(event.anchor, event.element ?? undefined);
		}));
		this._register(files.onDidFilesChange(event => {
			if (this.visible && event.affects(this.folder)) { this.refresh.schedule(); }
		}));
		this._register(files.onDidRunOperation(event => {
			if (this.visible && this.uris.extUri.isEqualOrParent(event.resource, this.folder)) { this.refresh.schedule(); }
		}));
		const observer = this._register(new DisposableResizeObserver('AndenSessionFiles', () => this.layout(), getWindow(container)));
		this._register(observer.observe(this.treeHost));
		this._register(observer.observe(this.editorHost));
	}

	show(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		this.container.hidden = !visible;
		this.part?.setVisible(visible);
		if (visible && !this.closed) {
			this.watch.value = this.files.watch(this.folder, { recursive: true, excludes: ['**/.git/**', '**/node_modules/**'] });
			this.refresh.schedule(0);
			this.layout();
		} else {
			this.watch.clear();
			this.refresh.cancel();
		}
	}

	private get activeGroup() { return this.part?.activeGroup; }

	focus(): void { this.tree.domFocus(); }

	private layout(): void {
		if (!this.visible) { return; }
		const tree = getClientArea(this.treeHost);
		this.tree.layout(tree.height, tree.width);
		if (this.part) {
			const area = getClientArea(this.editorHost);
			const { top, left } = this.editorHost.getBoundingClientRect();
			if (area.width > 0 && area.height > 0) { this.part.layout(area.width, area.height, top, left); }
		}
	}

	private async refreshTree(): Promise<void> {
		if (!this.visible || this.closed || this._store.isDisposed) { return; }
		if (this.updating) { this.refresh.schedule(); return; }
		this.updating = true;
		try {
			if (this.initialized) { await this.tree.updateChildren(); }
			else { await this.tree.setInput(this.folder); this.initialized = true; }
			this.status.textContent = '';
		} catch {
			this.status.textContent = localize('andenFilesUnavailable', 'Could not read the session folder.');
		} finally { this.updating = false; }
	}

	/** Do not traverse links below the selected root, including stale tree nodes. */
	private async requirePath(resource: URI): Promise<void> {
		if (!await isAndenSessionPath(this.folder, resource, this.uris.extUri, async path => (await this.files.stat(path)).isSymbolicLink)) { throw this.invalidPath(); }
	}

	private invalidPath(): Error {
		return new Error(localize('andenInvalidPath', 'Choose a file or folder inside the session root. Symbolic links and Git metadata cannot be opened here.'));
	}

	open(resource: URI): Promise<void> {
		return this.opens.queue(() => this.openResource(resource));
	}

	private async openResource(resource: URI): Promise<void> {
		if (!this.visible || this.closed || this._store.isDisposed) { return; }
		try {
			await this.requirePath(resource);
			if (!(await this.files.stat(resource)).isFile) { throw this.invalidPath(); }
			if (!this.visible || this.closed || this._store.isDisposed) { return; }
			if (!this.part) {
				this.editorHost.hidden = false;
				this.empty.hidden = true;
				this.part = this.groups.createEditorPart({ container: this.editorHost, label: localize('andenEditor', 'Session editor'), partOptions: { showTabs: 'multiple' } });
				this.layout();
			}
			const part = this.part;
			const service = this.groups.getScopedInstantiationService(part).invokeFunction(accessor => accessor.get(IEditorService));
			await service.openEditor({ resource, options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id } }, part.activeGroup.id);
		} catch (error) { this.report(error); }
	}

	save(): void {
		const group = this.activeGroup;
		if (this.visible && !this.closed && group?.activeEditor) {
			void this.commands.executeCommand(SAVE_FILE_COMMAND_ID, { groupId: group.id, editorIndex: group.getIndexOfEditor(group.activeEditor), preserveFocus: true }).catch(error => this.report(error));
		}
	}

	async closeEditors(): Promise<boolean> {
		if (this.editing) { return false; }
		this.closed = true;
		let closed = false;
		try {
			await this.opens.queue(() => Promise.resolve());
			for (const group of this.part?.groups ?? []) {
				if (!await group.closeAllEditors()) { return false; }
			}
			closed = true;
			return true;
		} finally { if (!closed) { this.closed = false; } }
	}

	cancelClose(): void { this.closed = false; }

	private showActions(anchor: ReturnType<IContextMenuDelegate['getAnchor']>, item?: IFileStat): void {
		if (!this.visible || this.closed || this.editing) { return; }
		const parent = item ? (item.isDirectory ? item.resource : dirname(item.resource)) : this.folder;
		this.contextMenu.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				...(this.activeGroup?.activeEditor ? [toAction({ id: 'anden.saveFile', label: localize('andenSaveFile', 'Save Active File'), run: () => this.save() })] : []),
				toAction({ id: 'anden.newFile', label: localize('andenNewFile', 'New File…'), run: () => this.runOperation(() => this.create(parent, false)) }),
				toAction({ id: 'anden.newFolder', label: localize('andenNewFolder', 'New Folder…'), run: () => this.runOperation(() => this.create(parent, true)) }),
				...(item && !item.isSymbolicLink ? [
					toAction({ id: 'anden.renameFile', label: localize('andenRenameFile', 'Rename…'), run: () => this.runOperation(() => this.rename(item)) }),
					toAction({ id: 'anden.deleteFile', label: localize('andenDeleteFile', 'Delete…'), run: () => this.runOperation(() => this.delete(item)) }),
				] : []),
			],
		});
	}

	private async runOperation(operation: () => Promise<void>): Promise<void> {
		if (!this.visible || this.closed || this.editing) { return; }
		this.editing = true;
		this.operationButton.disabled = true;
		try { await operation(); }
		catch (error) { this.report(error); }
		finally {
			this.editing = false;
			this.operationButton.disabled = false;
			if (this.visible && !this._store.isDisposed) { this.refresh.schedule(0); }
		}
	}

	private async inputName(title: string, value?: string): Promise<string | undefined> {
		return (await this.quickInput.input({
			title, value, validateInput: async input => {
				const name = input.trim();
				return isAndenFileName(name) ? undefined : localize('andenInvalidName', 'Enter a valid file or folder name.');
			}
		}))?.trim();
	}

	private async create(parent: URI, directory: boolean): Promise<void> {
		const name = await this.inputName(directory ? localize('andenFolderName', 'New folder name') : localize('andenFileName', 'New file name'));
		if (!name || !this.visible || this._store.isDisposed) { return; }
		await this.requirePath(parent);
		const resource = joinPath(parent, name);
		if (await this.files.exists(resource)) { throw new Error(localize('andenFileExists', 'A file or folder already exists with that name.')); }
		if (!this.visible || this._store.isDisposed) { return; }
		const token = this.tokenSource.token;
		if (directory) { await this.workingFiles.createFolder([{ resource }], token); }
		else { await this.workingFiles.create([{ resource, overwrite: false }], token); await this.open(resource); }
	}

	private async rename(item: IFileStat): Promise<void> {
		const name = await this.inputName(localize('andenRenameFile', 'Rename…'), item.name);
		if (!name || name === item.name || !this.visible || this._store.isDisposed) { return; }
		await this.requirePath(item.resource);
		const target = joinPath(dirname(item.resource), name);
		const allowed = await this.files.canMove(item.resource, target, false);
		if (allowed !== true) { throw allowed; }
		if (!this.visible || this._store.isDisposed) { return; }
		this.requireSaved(item.resource);
		await this.workingFiles.move([{ file: { source: item.resource, target }, overwrite: false }], this.tokenSource.token);
	}

	private async delete(item: IFileStat): Promise<void> {
		const useTrash = this.files.hasCapability(item.resource, FileSystemProviderCapabilities.Trash);
		const answer = await this.dialogs.confirm({
			message: useTrash ? localize('andenTrashConfirm', 'Move {0} to the Trash?', item.name) : localize('andenDeleteConfirm', 'Permanently delete {0}?', item.name),
			detail: item.resource.fsPath,
			primaryButton: useTrash ? localize('andenTrash', 'Move to Trash') : localize('andenDelete', 'Delete'),
		});
		if (!answer.confirmed || !this.visible || this._store.isDisposed) { return; }
		await this.requirePath(item.resource);
		if (!this.visible || this._store.isDisposed) { return; }
		this.requireSaved(item.resource);
		await this.workingFiles.delete([{ resource: item.resource, useTrash, recursive: item.isDirectory }], this.tokenSource.token);
	}

	private requireSaved(resource: URI): void {
		if (this.workingFiles.getDirty(resource).length) { throw new Error(localize('andenSaveBeforeFileAction', 'Save or close the unsaved files before renaming or deleting them.')); }
	}

	private report(error: unknown): void {
		if (!this._store.isDisposed) { this.notifications.error(error instanceof Error ? error.message : localize('andenFileActionFailed', 'The file operation could not be completed.')); }
	}

	override dispose(): void {
		this.tokenSource.dispose(true);
		this.part?.forceClose();
		this.container.remove();
		super.dispose();
	}
}
