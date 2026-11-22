/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor, isFullscreen, onDidChangeFullscreen, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { $, addDisposableListener, append, clearNode, getWindow, getWindowId } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { toAction } from '../../../../base/common/actions.js';
import { raceTimeout, RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { getCaseInsensitive } from '../../../../base/common/objects.js';
import { isAbsolute, delimiter, join } from '../../../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { andenHistoryChannel, AndenHistoryRecord, AndenHistoryResume, AndenHistorySummary, maxHistoryName } from '../../../../platform/anden/common/andenHistory.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ANDEN_MAC_WINDOW_CONTROLS_INSET } from '../../../../platform/window/common/window.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IShellEnvironmentService } from '../../../services/environment/electron-browser/shellEnvironmentService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { AndenHistoryRecorder } from '../common/andenHistoryRecorder.js';
import { AndenAgentClient } from './andenAgentClient.js';
import { AndenChat } from '../browser/andenChat.js';
import { andenButton, andenIcon } from '../browser/andenIcons.js';
import { SessionList } from '../common/sessionList.js';
import { suggestSessionName } from '../common/sessionName.js';
import { AndenRepositoryContext, IAndenRepositorySummary } from '../browser/andenRepositoryContext.js';
import { AndenRepositoryReview, IAndenReviewState } from '../browser/andenRepositoryReview.js';
import { loadAndenCodeFont } from '../browser/andenTypography.js';
import '../browser/media/andenWorkbench.css';

const piExecutableSetting = 'anden.pi.executablePath';

const switchSessionCommand = 'anden.switchSession';

if (product.andenSessionWorkbench) {
	KeybindingsRegistry.registerKeybindingRule({
		id: switchSessionCommand, weight: KeybindingWeight.WorkbenchContrib, when: undefined,
		primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ,
	});
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	configuration.registerConfiguration({
		id: 'anden', title: 'Anden', type: 'object', scope: ConfigurationScope.MACHINE,
		properties: {
			[piExecutableSetting]: { type: 'string', default: '', description: localize('executablePath', 'Absolute path to the Pi executable. Leave empty to use the shell PATH.') },
		},
	});
	configuration.registerDefaultConfigurations([{
		overrides: {
			'chat.disableAIFeatures': true,
			'onboarding.enabled': false,
			'workbench.startupEditor': 'none',
			'window.title': 'Anden',
		},
	}]);
}

interface Session {
	readonly id: string;
	readonly chat: AndenChat;
	readonly history: AndenHistoryRecorder;
	readonly profileId: string;
	closing?: boolean;
	restoring?: boolean;
	archive?: Promise<boolean>;
	readonly row: HTMLElement;
	readonly status: HTMLElement;
	label: string;
	readonly folder: URI;
	readonly surface: HTMLElement;
	readonly selectButton: HTMLButtonElement;
	readonly nameLabel: HTMLElement;
	readonly branchLabel: HTMLElement;
	readonly menuButton: HTMLButtonElement;
	readonly closeButton: HTMLButtonElement;
	readonly disposables: DisposableStore;
	readonly review: IAndenReviewState;
	showReview: boolean;
	repository?: IAndenRepositorySummary;
}

/** Owns the session navigation and chat surfaces for one Anden desktop window. */
export class AndenWorkbench extends Disposable {
	private readonly sessions = new SessionList<Session>();
	private readonly repositoryContext: AndenRepositoryContext;
	private readonly agentClient: AndenAgentClient;
	private readonly sessionById = new Map<string, Session>();
	private readonly list: HTMLElement;
	private readonly content: HTMLElement;
	private readonly header: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly folderLabel: HTMLElement;
	private readonly branchLabel: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly newButton: HTMLButtonElement;
	private readonly review: AndenRepositoryReview;
	private readonly changesButton: HTMLButtonElement;
	private readonly historyList: HTMLElement;
	private readonly historySurface: HTMLElement;
	private readonly historyView = this._register(new DisposableStore());
	private readonly historyQueue = new Sequencer();
	private readonly dirtyHistory = new Set<Session>();
	private readonly saveHistory = this._register(new RunOnceScheduler(() => void this.flushHistory(), 500));
	private readonly historyEntries = new Map<string, AndenHistorySummary>();
	private readonly historyButtons = new Map<string, HTMLButtonElement>();
	private savedSelection: AndenHistorySummary | undefined;
	private historyChat: AndenChat | undefined;
	private historyRequest = 0;
	private historyListRequest = 0;
	private historyWriteErrorShown = false;
	private shuttingDown = false;
	private creating = false;

	private get selected(): Session | undefined {
		return this.sessions.active;
	}

	constructor(
		container: HTMLElement,
		integratedTitlebar: boolean,
		@IShellEnvironmentService private readonly shellEnvironment: IShellEnvironmentService,
		@IDialogService private readonly confirm: IDialogService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceTrustRequestService private readonly trust: IWorkspaceTrustRequestService,
		@IWorkspaceTrustManagementService private readonly trustManagement: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@INativeHostService private readonly nativeHost: INativeHostService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ISharedProcessService private readonly sharedProcess: ISharedProcessService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super();
		this.repositoryContext = this._register(instantiation.createInstance(AndenRepositoryContext));
		this.agentClient = this._register(instantiation.createInstance(AndenAgentClient));
		this._register(lifecycle.onWillShutdown(event => {
			this.shuttingDown = true;
			event.join(raceTimeout(this.agentClient.closeAll(), 2500).then(() => { }), {
				id: 'join.andenAgents', label: localize('closeAgents', 'Stopping Anden agents'),
			});
			event.join(raceTimeout(this.flushHistory(), 2500).then(() => { }), {
				id: 'join.andenHistory', label: localize('saveHistory', 'Saving Anden history'),
			});
		}));
		this._register(this.agentClient.onDidUpdate(({ sessionId, update }) => {
			const session = this.sessionById.get(sessionId);
			if (!session) { return; }
			if (session.history.apply(update)) { this.markHistoryDirty(session); }
			session.chat.update(update);
			if (update.kind === 'state' && !['starting', 'working', 'stopping'].includes(update.state)) { void this.flushHistory(); }
			if (update.kind === 'state' || update.kind === 'request' || update.kind === 'resolved') {
				this.renderSessionStatus(session);
				if (this.selected === session && session.showReview) { this.renderHeader(); }
			}
		}));
		this._register(this.trustManagement.onDidChangeTrustedFolders(() => {
			for (const session of this.sessions.values()) {
				void this.trustManagement.getUriTrustInfo(session.folder).then(async ({ trusted }) => {
					if (!trusted && this.sessionById.has(session.id)) {
						try { await this.agentClient.close(session.id); }
						finally {
							session.chat.update({ kind: 'state', state: 'disconnected', error: localize('chatTrustRevoked', 'Folder trust was revoked. This agent session was stopped.') });
							this.renderSessionStatus(session);
						}
					}
				}).catch(onUnexpectedError);
			}
		}));
		const root = $('div.anden-workbench');
		container.classList.add('anden-session-window');
		container.prepend(root);
		const sidebar = append(root, $('nav.anden-sidebar', { 'aria-label': localize('sessions', "Sessions") }));
		const toolbar = append(sidebar, $('div.anden-sidebar-header'));
		const sessionsHeading = append(toolbar, $('h1.anden-icon-heading', {}, andenIcon('sessions'), $('span', {}, localize('sessions', "Sessions"))));
		this.newButton = append(toolbar, andenButton(localize('newSession', "New Session"), 'new'));
		this.newButton.classList.add('anden-primary');
		this.newButton.onclick = () => void this.newSession();
		this.list = append(sidebar, $('ul.anden-session-list'));
		const history = append(sidebar, $('section.anden-history-section', { 'aria-labelledby': 'anden-history-heading' }));
		append(history, $('h2#anden-history-heading', {}, localize('historyHeading', 'History')));
		append(history, $('p.anden-history-hint', {}, localize('historyLocalHint', 'Chats and drafts are saved locally in this profile.')));
		this.historyList = append(history, $('ul.anden-session-list'));

		const main = append(root, $('main.anden-main', { 'aria-label': localize('activeSession', "Active Session") }));
		this.header = append(main, $('header.anden-session-header'));
		const description = append(this.header, $('div.anden-session-description'));
		this.heading = append(description, $('h2'));
		this.folderLabel = append(description, $('div.anden-folder'));
		this.branchLabel = append(description, $('div.anden-branch'));
		this.branchLabel.hidden = true;
		this.changesButton = append(this.header, $<HTMLButtonElement>('button.anden-changes-button', { type: 'button' }));
		this.changesButton.onclick = () => this.toggleReview();
		this.content = append(main, $('div.anden-session-content'));
		this.historySurface = append(this.content, $('div.anden-chat.anden-history-surface', { tabindex: '-1' }));
		this.historySurface.hidden = true;
		const reviewContainer = append(this.content, $('div.anden-review'));
		reviewContainer.hidden = true;
		this.review = this._register(instantiation.createInstance(AndenRepositoryReview, reviewContainer));
		this.empty = append(this.content, $('div.anden-empty'));
		append(this.empty, andenIcon('chat'));
		append(this.empty, $('h2', {}, localize('noSession', "No open session")));
		append(this.empty, $('p', {}, localize('startSession', "Start Pi in a folder of your choice.")));
		const startButton = append(this.empty, andenButton(localize('newSession', "New Session"), 'new'));
		startButton.classList.add('anden-primary');
		startButton.onclick = () => void this.newSession();
		this.renderSelection();
		if (integratedTitlebar) {
			this.integrateTitlebar(root, toolbar, sessionsHeading);
		}

		this._register(toDisposable(() => {
			root.remove();
			container.classList.remove('anden-session-window');
		}));
		this._register(CommandsRegistry.registerCommand(switchSessionCommand, () => this.pickSession()));
		this._register(addDisposableListener(getWindow(root), 'focus', () => void this.refreshHistory()));
		this._register(this.profiles.onDidChangeCurrentProfile(event => {
			if (event.previous.id !== event.profile.id) { event.join(this.changeHistoryProfile()); }
		}));
		void this.refreshHistory();
	}

	focus(): void {
		if (this.savedSelection) {
			if (this.historyChat) { this.historyChat.focus(); }
			else { this.historySurface.focus(); }
		} else if (this.selected?.showReview) {
			this.review.focus();
		} else if (this.selected) {
			this.selected.chat.focus();
		} else {
			this.newButton.focus();
		}
	}

	private integrateTitlebar(root: HTMLElement, toolbar: HTMLElement, heading: HTMLElement): void {
		root.classList.add('anden-integrated-titlebar');
		const targetWindow = getWindow(root);
		const targetWindowId = getWindowId(targetWindow);
		let lastHeight: number | undefined;
		const update = () => {
			const fullscreen = isFullscreen(targetWindow);
			root.classList.toggle('anden-fullscreen', fullscreen);
			if (fullscreen) {
				lastHeight = undefined;
				return;
			}

			const zoom = getZoomFactor(targetWindow);
			// Native controls do not scale with the web contents.
			root.style.setProperty('--anden-window-controls-space', `${84 / zoom}px`);
			const bounds = heading.getBoundingClientRect();
			const center = bounds.top - root.getBoundingClientRect().top + bounds.height / 2;
			const height = Math.round(center * 2 * zoom);
			if (height > 0 && height !== lastHeight) {
				lastHeight = height;
				void this.nativeHost.updateWindowControls({ targetWindowId, height, horizontalInset: ANDEN_MAC_WINDOW_CONTROLS_INSET }).catch(onUnexpectedError);
			}
		};
		const onWindowChange = (windowId: number) => {
			if (windowId === targetWindowId) {
				update();
			}
		};
		this._register(onDidChangeFullscreen(onWindowChange));
		this._register(onDidChangeZoomLevel(onWindowChange));
		const observer = new ResizeObserver(update);
		observer.observe(toolbar);
		this._register(toDisposable(() => observer.disconnect()));
		update();
	}

	private async newSession(source?: AndenHistorySummary, savedDraft = ''): Promise<void> {
		if (this.creating || this.shuttingDown) {
			return;
		}
		if (this.environment.remoteAuthority) {
			this.notifications.warn(localize('localOnly', "Anden sessions are only available in local windows."));
			return;
		}
		this.creating = true;
		const profileId = this.profiles.currentProfile.id;
		try {
			const folder = source ? URI.file(source.folder) : await this.pickFolder();
			if (!folder) { return; }
			if (source && !(await this.files.stat(folder).catch(() => undefined))?.isDirectory) {
				this.notifications.warn(localize('savedFolderMissing', 'The saved session folder is no longer available. Use New Session to choose a different folder.'));
				return;
			}
			let draft = '';
			if (savedDraft) {
				const choice = await this.quickInput.pick([
					{ label: localize('useSavedDraft', 'Use Draft'), useDraft: true },
					{ label: localize('startWithEmptyDraft', 'Start with an Empty Draft'), useDraft: false },
				], { placeHolder: localize('savedDraftChoice', 'Choose what to put in the new composer. Nothing will be sent.') });
				if (!choice) { return; }
				if (choice.useDraft) { draft = savedDraft; }
			}
			const suggested = suggestSessionName(basename(folder) || folder.fsPath, 'Pi', [...this.sessions.values()].map(session => session.label));
			const label = await this.inputSessionName(suggested, false);
			if (!label || !await this.trust.requestResourcesTrust({ uri: folder })) {
				return;
			}
			const env = await this.shellEnvironment.getShellEnv().catch(() => ({}));
			const executable = await this.findExecutable(env);
			if (!executable) {
				this.notifications.error(localize('missingExecutable', 'Could not find Pi. Install it or set {0} to an absolute executable path in User Settings.', piExecutableSetting));
				return;
			}
			await loadAndenCodeFont(this.content.ownerDocument);
			if (this._store.isDisposed) {
				return;
			}
			if (!(await this.trustManagement.getUriTrustInfo(folder)).trusted || this._store.isDisposed || this.shuttingDown || this.profiles.currentProfile.id !== profileId) { return; }
			const session = this.addSession(label, folder, profileId);
			session.chat.setDraft(draft);
			void this.agentClient.start({ sessionId: session.id, executable, cwd: folder.fsPath, env });
		} catch (error) {
			this.notifications.error(error);
		} finally {
			this.creating = false;
		}
	}

	private async pickFolder(): Promise<URI | undefined> {
		const defaultUri = this.selected?.folder ?? this.workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
		const picked = await this.dialogs.showOpenDialog({
			title: localize('chooseFolder', "Choose Session Folder"), defaultUri,
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false, availableFileSystems: [Schemas.file],
		});
		return picked?.[0]?.scheme === Schemas.file ? picked[0] : undefined;
	}

	private async findExecutable(env: IProcessEnvironment): Promise<string | undefined> {
		const configured = this.configuration.inspect<string>(piExecutableSetting).userLocalValue?.trim();
		const path = getCaseInsensitive(env, 'PATH');
		const name = isWindows ? 'pi.exe' : 'pi';
		// An absolute path prevents the terminal backend from falling back to the session folder.
		const candidates = configured ? (isAbsolute(configured) ? [configured] : []) :
			typeof path === 'string' ? path.split(delimiter).filter(directory => isAbsolute(directory)).map(directory => join(directory, name)) : [];
		for (const candidate of candidates) {
			try {
				if ((await this.files.stat(URI.file(candidate))).isFile) {
					return candidate;
				}
			} catch {
				// The candidate does not exist or cannot be accessed.
			}
		}
		return undefined;
	}

	private async inputSessionName(value: string, renaming: boolean): Promise<string | undefined> {
		return (await this.quickInput.input({
			title: renaming ? localize('renameSessionTitle', 'Rename Session') : localize('sessionNameTitle', 'Session Name'),
			prompt: localize('sessionNamePrompt', 'Enter a name for this session.'),
			value,
			validateInput: async input => !input.trim() ? localize('emptySessionName', 'Enter a non-empty session name.') : input.trim().length > maxHistoryName ? localize('longSessionName', 'Use at most {0} characters.', maxHistoryName) : undefined,
		}))?.trim();
	}

	private addSession(label: string, folder: URI, profileId: string, restored?: AndenHistoryRecord): Session {
		const row = append(this.list, $('li.anden-session-row'));
		const selectButton = append(row, $<HTMLButtonElement>('button.anden-session-select', { type: 'button', title: folder.fsPath }));
		append(selectButton, andenIcon('agent-pi'));
		const labels = append(selectButton, $('span.anden-session-labels'));
		const nameLabel = append(labels, $('span.anden-session-name'));
		append(labels, $('span.anden-folder', {}, basename(folder) || folder.fsPath));
		const branchLabel = append(labels, $('span.anden-branch'));
		const status = append(labels, $('span.anden-status'));
		const menuButton = append(row, andenButton('', 'more', true));
		menuButton.classList.add('anden-session-menu');
		menuButton.setAttribute('aria-haspopup', 'menu');
		const closeButton = append(row, andenButton('', 'close', true));
		closeButton.classList.add('anden-session-close');
		const surface = append(this.content, $('div.anden-chat'));
		surface.hidden = true;
		const disposables = new DisposableStore();
		const id = restored?.id ?? generateUuid();
		const createdAt = Date.now();
		const history = new AndenHistoryRecorder(restored ?? { version: 1, id, label, agent: 'pi', folder: folder.fsPath, createdAt, updatedAt: createdAt }, restored);
		const chat = disposables.add(this.instantiation.createInstance(AndenChat, surface, {
			onDraftChange: text => { if (history.setDraft(text)) { this.markHistoryDirty(session); } },
			send: text => this.agentClient.send(id, text),
			stop: () => this.agentClient.stop(id),
			listModels: () => this.agentClient.listModels(id),
			selectModel: model => this.agentClient.selectModel(id, model),
			listReasoning: () => this.agentClient.listReasoning(id),
			selectReasoning: level => this.agentClient.selectReasoning(id, level),
			answer: (request, answer) => this.agentClient.answer(id, request, answer),
			showFile: path => this.showToolFile(session, path),
		}));
		const observation = disposables.add(this.repositoryContext.watch(id, folder, summary => {
			session.repository = summary;
			this.renderSessionDetails(session);
			if (this.selected === session) {
				this.renderHeader();
			}
		}));
		const session: Session = {
			id, chat, history, profileId, restoring: !!restored, row, status, label, folder, surface, selectButton, nameLabel, branchLabel, menuButton, closeButton, disposables,
			review: { folder, sessionId: id, whenWatching: observation.whenWatching }, showReview: false,
		};
		this.sessionById.set(id, session);
		this.sessions.add(session);
		if (restored) {
			closeButton.disabled = true;
			chat.restoreHistory(restored);
		} else {
			void this.historyQueue.queue(() => this.historyCall('claim', profileId, id)).catch(() => this.reportHistoryWriteError());
			this.markHistoryDirty(session);
		}
		this.renderSessionDetails(session);
		this.renderSessionStatus(session);
		const showMenu = (event?: MouseEvent) => {
			this.contextMenu.showContextMenu({
				getAnchor: () => event ? new StandardMouseEvent(getWindow(row), event) : menuButton,
				getActions: () => [toAction({ id: 'anden.renameSession', label: localize('renameSession', 'Rename Session…'), run: () => this.renameSession(session) })],
			});
		};
		menuButton.onclick = () => showMenu();
		row.oncontextmenu = event => {
			event.preventDefault();
			event.stopPropagation();
			showMenu(event);
		};
		disposables.add({ dispose: () => { surface.remove(); row.remove(); } });
		selectButton.onclick = () => this.selectSession(session);
		closeButton.onclick = () => void this.closeSession(session).catch(onUnexpectedError);
		this.selectSession(session);
		return session;
	}

	private showToolFile(session: Session, path: string): boolean {
		if (this.selected !== session || !path || /[\0\r\n]/.test(path)) { return false; }
		session.review.requestedFile = URI.file(isAbsolute(path) ? path : join(session.folder.fsPath, path));
		session.showReview = true;
		this.renderSelection();
		this.review.focus();
		return true;
	}

	private async closeSession(session: Session): Promise<void> {
		if (session.closing || session.restoring) { return; }
		if (session.chat.active) {
			const answer = await this.confirm.confirm({ message: localize('closeActiveChat', 'Close {0} and stop its agent?', session.label), primaryButton: localize('confirmCloseChat', 'Close Session') });
			if (!answer.confirmed) { return; }
		}
		if (!this.sessionById.has(session.id) || session.closing) { return; }
		session.closing = true;
		session.chat.update({ kind: 'state', state: 'disconnected' });
		this.renderSessionStatus(session);
		try {
			await this.agentClient.close(session.id);
		} finally {
			const saved = await this.archiveSession(session);
			if (saved) {
				if (this.sessionById.has(session.id)) { this.removeSession(session); }
				await this.refreshHistory();
			} else {
				session.closing = false;
				this.renderSessionStatus(session);
			}
		}
	}

	private async renameSession(session: Session): Promise<void> {
		const label = await this.inputSessionName(session.label, true);
		if (!label || label === session.label || session.disposables.isDisposed) {
			return;
		}
		session.label = label;
		this.markHistoryDirty(session);
		this.renderSessionDetails(session);
		if (this.selected === session) {
			this.renderHeader();
		}
	}

	private renderSessionStatus(session: Session): void {
		const info = session.chat.statusInfo;
		if (session.status.dataset.status === info.label) { return; }
		session.status.dataset.status = info.label;
		clearNode(session.status);
		append(session.status, andenIcon(info.icon));
		append(session.status, $('span', {}, info.label));
		session.row.classList.toggle('anden-working', info.icon === 'status-working');
	}

	private renderSessionDetails(session: Session): void {
		session.nameLabel.textContent = session.label;
		session.menuButton.setAttribute('aria-label', localize('sessionActions', 'Actions for {0}', session.label));
		session.closeButton.setAttribute('aria-label', localize('closeSession', 'Close {0}', session.label));
		session.menuButton.title = session.menuButton.getAttribute('aria-label') ?? '';
		session.closeButton.title = session.closeButton.getAttribute('aria-label') ?? '';
		this.renderBranch(session.branchLabel, session.repository);
	}

	private renderBranch(element: HTMLElement, repository: IAndenRepositorySummary | undefined): void {
		const label = repository?.branch ?? (repository?.commit ? localize('detachedHead', 'Detached HEAD · {0}', repository.commit.slice(0, 8)) : '');
		clearNode(element);
		if (label) { append(element, andenIcon('branch')); append(element, $('span', {}, label)); }
		element.title = label;
		element.hidden = !label;
	}

	private removeSession(session: Session): void {
		this.sessionById.delete(session.id);
		const selectionChanged = this.sessions.remove(session);
		session.disposables.dispose();
		if (selectionChanged) {
			this.selectSession(this.selected);
		}
	}

	private selectSession(session: Session | undefined, focus = true): void {
		if (!this.sessions.select(session)) {
			return;
		}
		this.clearHistorySelection();
		this.renderSelection();
		if (focus) {
			this.focus();
		}
	}

	private renderSelection(): void {
		for (const session of this.sessions.values()) {
			const active = session === this.selected;
			session.surface.hidden = !active || session.showReview;
			session.selectButton.setAttribute('aria-current', String(active));
		}
		this.historySurface.hidden = !this.savedSelection;
		this.empty.hidden = !!this.selected || !!this.savedSelection;
		this.header.hidden = !this.selected && !this.savedSelection;
		this.renderHeader();
		this.review.show(this.selected?.showReview ? this.selected.review : undefined);
	}

	private toggleReview(): void {
		if (!this.selected) {
			return;
		}
		const session = this.selected;
		session.showReview = !session.showReview;
		this.renderSelection();
		if (session.showReview) { this.review.focus(); } else { session.chat.focus(session.chat.pending); }
	}

	private renderHeader(): void {
		const session = this.selected;
		clearNode(this.heading);
		if (session) { append(this.heading, andenIcon('agent-pi')); append(this.heading, $('span', {}, session.label)); }
		if (this.savedSelection) { this.heading.textContent = this.savedSelection.label; }
		const saved = this.savedSelection;
		this.folderLabel.textContent = session?.folder.fsPath ?? saved?.folder ?? '';
		this.changesButton.hidden = !!saved;
		this.renderBranch(this.branchLabel, session?.repository);
		const button = this.changesButton;
		clearNode(button);
		const label = session?.showReview ? localize('backToChat', 'Back to Chat') : localize('changes', 'Changes');
		append(button, andenIcon(session?.showReview ? 'back' : 'git'));
		append(button, $('span', {}, label));
		if (session?.showReview && session.chat.pending) {
			append(button, andenIcon('status-waiting'));
			append(button, $('span', {}, localize('pendingChat', 'Input needed')));
		}
		const lines = session?.showReview ? undefined : session?.repository?.lines;
		if (lines && (lines.added || lines.deleted)) {
			append(button, $('span.anden-lines-added', { 'aria-hidden': 'true' }, `+${lines.added}`));
			append(button, $('span.anden-lines-deleted', { 'aria-hidden': 'true' }, `\u2212${lines.deleted}`));
			button.setAttribute('aria-label', localize('changesLines', 'Changes: {0} lines added, {1} removed', lines.added, lines.deleted));
		} else {
			button.removeAttribute('aria-label');
		}
	}


	private historyCall<T>(command: string, profileId: string, id?: string, record?: AndenHistoryRecord): Promise<T> {
		return this.sharedProcess.getChannel(andenHistoryChannel).call<T>(command, [profileId, id, record]);
	}

	private markHistoryDirty(session: Session): void {
		if (session.disposables.isDisposed || session.restoring) { return; }
		this.dirtyHistory.add(session);
		if (!this.shuttingDown && !this.saveHistory.isScheduled()) { this.saveHistory.schedule(); }
	}

	private reportHistoryWriteError(): void {
		if (this.historyWriteErrorShown || this.shuttingDown || this._store.isDisposed) { return; }
		this.historyWriteErrorShown = true;
		this.notifications.warn(localize('historySaveFailed', 'Anden could not save history. Recent messages or drafts may not be recoverable after closing the window.'));
	}

	private async writeHistory(session: Session): Promise<boolean> {
		this.dirtyHistory.delete(session);
		try {
			await this.historyCall('save', session.profileId, session.id, session.history.snapshot(session.label));
			return true;
		} catch {
			if (!session.disposables.isDisposed) { this.dirtyHistory.add(session); }
			this.reportHistoryWriteError();
			return false;
		}
	}

	private flushHistory(): Promise<void> {
		this.saveHistory.cancel();
		return this.historyQueue.queue(async () => {
			for (const session of [...this.dirtyHistory]) {
				if (!session.archive && !session.disposables.isDisposed) { await this.writeHistory(session); }
			}
		});
	}

	private archiveSession(session: Session): Promise<boolean> {
		return session.archive ??= this.historyQueue.queue(async () => {
			if (!session.restoring && !await this.writeHistory(session)) { return false; }
			try { await this.historyCall('release', session.profileId, session.id); }
			catch { this.reportHistoryWriteError(); return false; }
			return true;
		}).then(saved => {
			if (!saved) { session.archive = undefined; }
			return saved;
		});
	}

	private async changeHistoryProfile(): Promise<void> {
		this.clearHistorySelection();
		this.historyEntries.clear();
		this.renderHistoryList();
		const sessions = [...this.sessions.values()];
		for (const session of sessions) {
			session.closing = true;
			this.removeSession(session);
		}
		this.renderSelection();
		await Promise.all(sessions.map(async session => {
			try { await this.agentClient.close(session.id); }
			finally { await this.archiveSession(session); }
		})).catch(onUnexpectedError);
		await this.refreshHistory();
	}

	private async refreshHistory(): Promise<void> {
		if (this.shuttingDown || this.environment.remoteAuthority || this._store.isDisposed) { return; }
		const request = ++this.historyListRequest;
		const profileId = this.profiles.currentProfile.id;
		try {
			const records = await this.historyCall<AndenHistorySummary[]>('list', profileId);
			if (request !== this.historyListRequest || this._store.isDisposed || profileId !== this.profiles.currentProfile.id) { return; }
			const visible = records.filter(record => !this.sessionById.has(record.id));
			const previous = [...this.historyEntries.values()];
			if (visible.length === previous.length && visible.every((entry, index) => entry.id === previous[index].id && entry.label === previous[index].label)) { return; }
			this.historyEntries.clear();
			for (const record of visible) { this.historyEntries.set(record.id, record); }
			if (this.savedSelection && !this.historyEntries.has(this.savedSelection.id)) {
				this.clearHistorySelection();
				this.renderSelection();
			}
			this.renderHistoryList();
		} catch {
			if (request === this.historyListRequest && !this._store.isDisposed && !this.shuttingDown) { this.notifications.warn(localize('historyListFailed', 'Anden could not load the saved session list.')); }
		}
	}

	private renderHistoryList(): void {
		clearNode(this.historyList);
		this.historyButtons.clear();
		for (const entry of this.historyEntries.values()) {
			const row = append(this.historyList, $('li.anden-session-row.anden-history-row'));
			const select = append(row, $<HTMLButtonElement>('button.anden-session-select', { type: 'button', title: entry.folder, 'aria-current': String(entry.id === this.savedSelection?.id) }));
			append(select, andenIcon('agent-pi'));
			const labels = append(select, $('span.anden-session-labels'));
			append(labels, $('span.anden-session-name', {}, entry.label));
			append(labels, $('span.anden-folder', {}, basename(URI.file(entry.folder)) || entry.folder));
			this.historyButtons.set(entry.id, select);
			select.onclick = () => void this.openHistory(entry);
		}
	}

	private clearHistorySelection(): void {
		this.historyRequest++;
		this.savedSelection = undefined;
		this.historyChat = undefined;
		this.historyView.clear();
		clearNode(this.historySurface);
		this.updateHistorySelection();
	}

	private updateHistorySelection(): void {
		for (const [id, button] of this.historyButtons) {
			button.setAttribute('aria-current', String(id === this.savedSelection?.id));
		}
	}

	private async openHistory(entry: AndenHistorySummary): Promise<void> {
		if (!this.historyEntries.has(entry.id) || this.shuttingDown) { return; }
		this.clearHistorySelection();
		const request = this.historyRequest;
		const profileId = this.profiles.currentProfile.id;
		this.sessions.select(undefined);
		this.savedSelection = entry;
		this.updateHistorySelection();
		this.renderSelection();
		const panel = append(this.historySurface, $('div.anden-history-toolbar'));
		const status = append(panel, $('span.anden-status', { role: 'status' }, localize('loadingSavedChat', 'Loading saved session…')));
		const remove = append(panel, andenButton(localize('deleteSavedChat', 'Delete from History'), 'close'));
		remove.onclick = () => void this.deleteHistory(entry, profileId);
		const record = await this.historyCall<AndenHistoryRecord | undefined>('read', profileId, entry.id).catch(() => undefined);
		if (request !== this.historyRequest || this._store.isDisposed) { return; }
		status.textContent = record ? localize('savedReadOnly', 'Saved · Read only') : localize('unavailableSavedChat', 'Saved conversation is unavailable');
		const start = append(panel, andenButton(localize('newInSavedFolder', 'New Session in This Folder'), 'new'));
		start.onclick = () => void this.newSession(entry, record?.draft);
		if (!record) { return; }
		const surface = append(this.historySurface, $('div.anden-chat.anden-history-transcript'));
		const activeFocus = this.content.ownerDocument.activeElement;
		const shouldFocus = activeFocus === this.historyButtons.get(entry.id) || activeFocus === this.historySurface;
		const chat = this.historyChat = this.historyView.add(this.instantiation.createInstance(AndenChat, surface, undefined));
		chat.restoreHistory(record);
		if (record.piSession) {
			void this.historyCall<boolean>('canResume', profileId, entry.id).then(available => {
				if (!available || request !== this.historyRequest || this._store.isDisposed || this.shuttingDown) { return; }
				const resume = andenButton(localize('continueSavedSession', 'Continue Session'), 'chat');
				panel.insertBefore(resume, start);
				resume.onclick = () => void this.resumeHistory(entry, profileId, resume);
			}).catch(() => { });
		}
		if (record.draft) {
			const draft = append(this.historySurface, $('div.anden-history-draft'));
			append(draft, $('h3', {}, localize('savedDraft', 'Saved Draft')));
			const copy = append(draft, andenButton(localize('copySavedDraft', 'Copy Draft'), 'copy'));
			copy.onclick = () => void this.clipboard.writeText(record.draft).catch(() => this.notifications.warn(localize('copyDraftFailed', 'Anden could not copy the saved draft.')));
			append(draft, $('pre', { tabindex: '0', 'aria-label': localize('savedDraft', 'Saved Draft') }, record.draft));
		}
		if (shouldFocus) { chat.focus(); }
	}

	private async resumeHistory(entry: AndenHistorySummary, profileId: string, button: HTMLButtonElement): Promise<void> {
		const stillSelected = () => !this._store.isDisposed && !this.shuttingDown && this.profiles.currentProfile.id === profileId && this.savedSelection?.id === entry.id;
		if (this.creating || !stillSelected()) { return; }
		this.creating = true;
		button.disabled = true;
		let leased = false;
		let session: Session | undefined;
		try {
			const result = await this.historyCall<AndenHistoryResume>('resume', profileId, entry.id);
			leased = result.kind === 'ready';
			if (!stillSelected()) { return; }
			if (result.kind === 'busy') {
				this.notifications.warn(localize('resumePiBusy', 'This session is already open in another Anden window.'));
				return;
			}
			if (result.kind !== 'ready' || !result.record.piSession) {
				button.hidden = true;
				this.notifications.warn(localize('resumePiUnavailable', 'The saved Pi session or its original folder is no longer available.'));
				return;
			}
			const { record } = result;
			const native = result.record.piSession;
			const folder = URI.file(native.cwd);
			if (!await this.trust.requestResourcesTrust({ uri: folder }) || !stillSelected()) { return; }
			const env = await this.shellEnvironment.getShellEnv().catch(() => ({}));
			const executable = await this.findExecutable(env);
			if (!executable) {
				this.notifications.error(localize('resumePiMissing', 'Could not find Pi. Install it or set anden.pi.executablePath in User Settings.'));
				return;
			}
			await loadAndenCodeFont(this.content.ownerDocument);
			if (!(await this.trustManagement.getUriTrustInfo(folder)).trusted || !stillSelected()) { return; }
			session = this.addSession(record.label, folder, profileId, record);
			const started = await this.agentClient.start({ sessionId: session.id, executable, cwd: record.folder, env, piResume: native });
			if (!started || session.disposables.isDisposed || this.shuttingDown) {
				if (!this.shuttingDown && this.profiles.currentProfile.id === profileId) { this.notifications.warn(localize('resumePiFailed', 'Pi could not continue this session. The conversation and draft are still available in History.')); }
				return;
			}
			session.restoring = false;
			session.closeButton.disabled = false;
			this.markHistoryDirty(session);
			leased = false; // The live session now owns the record until it closes.
			void this.refreshHistory();
		} catch {
			if (!this._store.isDisposed && !this.shuttingDown && this.profiles.currentProfile.id === profileId) { this.notifications.warn(localize('resumePiFailed', 'Pi could not continue this session. The conversation and draft are still available in History.')); }
		} finally {
			const reopen = !!session && this.selected === session;
			if (leased) {
				if (session) {
					await this.agentClient.close(session.id).catch(() => { });
					if (this.sessionById.get(session.id) === session) { this.removeSession(session); }
				}
				await this.historyCall('release', profileId, entry.id).catch(() => { });
				if (reopen && !this._store.isDisposed && !this.shuttingDown && this.profiles.currentProfile.id === profileId) { await this.openHistory(entry); }
			}
			button.disabled = false;
			this.creating = false;
		}
	}

	private async deleteHistory(entry: AndenHistorySummary, profileId: string): Promise<void> {
		const { confirmed } = await this.confirm.confirm({ type: 'warning', message: localize('deleteSavedChatConfirm', 'Delete the saved conversation and draft for {0} from Anden? Any native agent session file will be kept.', entry.label), primaryButton: localize('deleteSavedChat', 'Delete from History') });
		if (!confirmed || this._store.isDisposed || this.profiles.currentProfile.id !== profileId || this.shuttingDown) { return; }
		try {
			if (!await this.historyCall<boolean>('delete', profileId, entry.id)) {
				this.notifications.warn(localize('historyOwned', 'This session is active in another window. Close it there before deleting its history.'));
				return;
			}
			await this.refreshHistory();
			if (!this.savedSelection && !this.selected) { this.newButton.focus(); }
		} catch {
			this.notifications.warn(localize('historyDeleteFailed', 'Anden could not delete this saved session.'));
		}
	}

	private async pickSession(): Promise<void> {
		const profileId = this.profiles.currentProfile.id;
		const sessions: (IQuickPickItem & ({ kind: 'live'; session: Session } | { kind: 'saved'; history: AndenHistorySummary }))[] = [...this.sessions.values()].map(session => ({ kind: 'live', label: session.label, description: session.folder.fsPath, detail: session.repository?.branch, session }));
		for (const history of this.historyEntries.values()) {
			sessions.push({ kind: 'saved', label: history.label, description: localize('savedPickerSession', 'Saved · {0}', history.folder), history });
		}
		const picked = sessions.length === 1 ? sessions[0] : sessions.length ? await this.quickInput.pick(sessions, { placeHolder: localize('pickSession', "Select a session"), matchOnDescription: true }) : undefined;
		if (picked && profileId === this.profiles.currentProfile.id) {
			if (picked.kind === 'live') { this.selectSession(picked.session); }
			else { await this.openHistory(picked.history); this.historyChat?.focus(); }
		}
	}

	override dispose(): void {
		for (const session of this.sessions.values()) {
			void this.agentClient.close(session.id).catch(() => { });
			session.disposables.dispose();
		}
		this.sessions.clear();
		this.sessionById.clear();
		super.dispose();
	}
}
