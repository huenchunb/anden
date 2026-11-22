/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor, isFullscreen, onDidChangeFullscreen, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { $, append, clearNode, getWindow, getWindowId } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { toAction } from '../../../../base/common/actions.js';
import { raceTimeout } from '../../../../base/common/async.js';
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
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
import { AndenAgentClient } from './andenAgentClient.js';
import { AndenChat } from '../browser/andenChat.js';
import { andenButton, andenIcon } from '../browser/andenIcons.js';
import { SessionList } from '../common/sessionList.js';
import { suggestSessionName } from '../common/sessionName.js';
import { AndenRepositoryContext, IAndenRepositorySummary } from '../browser/andenRepositoryContext.js';
import { AndenRepositoryReview, IAndenReviewState } from '../browser/andenRepositoryReview.js';
import { loadAndenCodeFont } from '../browser/andenTypography.js';
import '../browser/media/andenWorkbench.css';

const agents = [
	{ id: 'pi', label: 'Pi' },
	{ id: 'codex', label: 'Codex' },
] as const;
type Agent = typeof agents[number];

const switchSessionCommand = 'anden.switchSession';

if (product.andenSessionWorkbench) {
	KeybindingsRegistry.registerKeybindingRule({
		id: switchSessionCommand, weight: KeybindingWeight.WorkbenchContrib, when: undefined,
		primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ,
	});
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	configuration.registerConfiguration({
		id: 'anden', title: 'Anden', type: 'object', scope: ConfigurationScope.MACHINE,
		properties: Object.fromEntries(agents.map(agent => [`anden.${agent.id}.executablePath`, {
			type: 'string', default: '', description: localize('executablePath', "Absolute path to the {0} executable. Leave empty to use the shell PATH.", agent.label),
		}])),
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
	readonly row: HTMLElement;
	readonly status: HTMLElement;
	label: string;
	readonly agent: Agent;
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
	) {
		super();
		this.repositoryContext = this._register(instantiation.createInstance(AndenRepositoryContext));
		this.agentClient = this._register(instantiation.createInstance(AndenAgentClient));
		this._register(lifecycle.onWillShutdown(event => event.join(raceTimeout(this.agentClient.closeAll(), 2500).then(() => { }), {
			id: 'join.andenAgents', label: localize('closeAgents', 'Stopping Anden agents'),
		})));
		this._register(this.agentClient.onDidUpdate(({ sessionId, update }) => {
			const session = this.sessionById.get(sessionId);
			if (!session) { return; }
			session.chat.update(update);
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
		const reviewContainer = append(this.content, $('div.anden-review'));
		reviewContainer.hidden = true;
		this.review = this._register(instantiation.createInstance(AndenRepositoryReview, reviewContainer));
		this.empty = append(this.content, $('div.anden-empty'));
		append(this.empty, andenIcon('chat'));
		append(this.empty, $('h2', {}, localize('noSession', "No open session")));
		append(this.empty, $('p', {}, localize('startSession', "Start Pi or Codex in a folder of your choice.")));
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
	}

	focus(): void {
		if (this.selected?.showReview) {
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

	private async newSession(): Promise<void> {
		if (this.creating) {
			return;
		}
		if (this.environment.remoteAuthority) {
			this.notifications.warn(localize('localOnly', "Anden sessions are only available in local windows."));
			return;
		}
		this.creating = true;
		try {
			const agent = await this.quickInput.pick<Agent>([...agents], { placeHolder: localize('pickAgent', "Select an agent") });
			if (!agent) {
				return;
			}
			const folder = await this.pickFolder();
			if (!folder) {
				return;
			}
			const suggested = suggestSessionName(basename(folder) || folder.fsPath, agent.label, [...this.sessions.values()].map(session => session.label));
			const label = await this.inputSessionName(suggested, false);
			if (!label || !await this.trust.requestResourcesTrust({ uri: folder })) {
				return;
			}
			const env = await this.shellEnvironment.getShellEnv().catch(() => ({}));
			const executable = await this.findExecutable(agent, env);
			if (!executable) {
				this.notifications.error(localize('missingExecutable', "Could not find an executable for {0}. Install it or set {1} to an absolute executable path in User Settings.", agent.label, `anden.${agent.id}.executablePath`));
				return;
			}
			await loadAndenCodeFont(this.content.ownerDocument);
			if (this._store.isDisposed) {
				return;
			}
			if (!(await this.trustManagement.getUriTrustInfo(folder)).trusted || this._store.isDisposed) { return; }
			const session = this.addSession(label, agent, folder);
			void this.agentClient.start({ sessionId: session.id, agent: agent.id, executable, cwd: folder.fsPath, env });
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

	private async findExecutable(agent: Agent, env: IProcessEnvironment): Promise<string | undefined> {
		const configured = this.configuration.inspect<string>(`anden.${agent.id}.executablePath`).userLocalValue?.trim();
		const path = getCaseInsensitive(env, 'PATH');
		const name = isWindows ? `${agent.id}.exe` : agent.id;
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
			validateInput: async input => input.trim() ? undefined : localize('emptySessionName', 'Enter a non-empty session name.'),
		}))?.trim();
	}

	private addSession(label: string, agent: Agent, folder: URI): Session {
		const row = append(this.list, $('li.anden-session-row'));
		const selectButton = append(row, $<HTMLButtonElement>('button.anden-session-select', { type: 'button', title: folder.fsPath }));
		append(selectButton, andenIcon(agent.id === 'pi' ? 'agent-pi' : 'agent-codex'));
		const labels = append(selectButton, $('span.anden-session-labels'));
		const nameLabel = append(labels, $('span.anden-session-name'));
		append(labels, $('span.anden-folder', {}, localize('sessionAgentFolder', '{0} · {1}', agent.label, basename(folder) || folder.fsPath)));
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
		const id = generateUuid();
		const chat = disposables.add(this.instantiation.createInstance(AndenChat, surface, agent.id, agent.label, {
			send: text => this.agentClient.send(id, text),
			stop: () => this.agentClient.stop(id),
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
			id, chat, row, status, label, agent, folder, surface, selectButton, nameLabel, branchLabel, menuButton, closeButton, disposables,
			review: { folder, sessionId: id, whenWatching: observation.whenWatching }, showReview: false,
		};
		this.sessionById.set(id, session);
		this.sessions.add(session);
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
		if (session.chat.active) {
			const answer = await this.confirm.confirm({ message: localize('closeActiveChat', 'Close {0} and stop its agent?', session.label), primaryButton: localize('confirmCloseChat', 'Close Session') });
			if (!answer.confirmed) { return; }
		}
		if (!this.sessionById.has(session.id)) { return; }
		this.removeSession(session);
		await this.agentClient.close(session.id);
	}

	private async renameSession(session: Session): Promise<void> {
		const label = await this.inputSessionName(session.label, true);
		if (!label || label === session.label || session.disposables.isDisposed) {
			return;
		}
		session.label = label;
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
		this.empty.hidden = !!this.selected;
		this.header.hidden = !this.selected;
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
		if (session) { append(this.heading, andenIcon(session.agent.id === 'pi' ? 'agent-pi' : 'agent-codex')); append(this.heading, $('span', {}, session.label)); }
		this.folderLabel.textContent = session ? localize('sessionAgentFolder', '{0} · {1}', session.agent.label, session.folder.fsPath) : '';
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


	private async pickSession(): Promise<void> {
		const sessions: (IQuickPickItem & { session: Session })[] = [...this.sessions.values()].map(session => ({ label: session.label, description: localize('sessionAgentFolder', '{0} · {1}', session.agent.label, session.folder.fsPath), detail: session.repository?.branch, session }));
		const picked = sessions.length === 1 ? sessions[0] : sessions.length ? await this.quickInput.pick(sessions, { placeHolder: localize('pickSession', "Select a session"), matchOnDescription: true }) : undefined;
		if (picked) {
			this.selectSession(picked.session);
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
