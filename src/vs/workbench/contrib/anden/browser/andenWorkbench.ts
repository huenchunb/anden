/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor, isFullscreen, onDidChangeFullscreen, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { $, append, clearNode, getWindow, getWindowId } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { toAction } from '../../../../base/common/actions.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { getCaseInsensitive } from '../../../../base/common/objects.js';
import { isAbsolute, delimiter, join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalLocation, TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { ANDEN_MAC_WINDOW_CONTROLS_INSET } from '../../../../platform/window/common/window.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../terminal/browser/terminal.js';
import { SessionList } from '../common/sessionList.js';
import { suggestSessionName } from '../common/sessionName.js';
import { AndenRepositoryContext, IAndenRepositorySummary } from './andenRepositoryContext.js';
import { AndenRepositoryReview, IAndenReviewState } from './andenRepositoryReview.js';
import { andenCodeFont, loadAndenCodeFont } from './andenTypography.js';
import './media/andenWorkbench.css';

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
			[TerminalSettingId.FontFamily]: andenCodeFont.fontFamily,
			[TerminalSettingId.FontSize]: andenCodeFont.fontSize,
			[TerminalSettingId.FontWeight]: andenCodeFont.fontWeight,
			[TerminalSettingId.FontWeightBold]: andenCodeFont.fontWeightBold,
		},
	}]);
}

interface Session {
	readonly terminal: ITerminalInstance;
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

/** Owns the session navigation and terminal surfaces for one Anden desktop window. */
export class AndenWorkbench extends Disposable {
	private readonly sessions = new SessionList<Session>();
	private readonly repositoryContext: AndenRepositoryContext;
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
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalInstanceService private readonly terminalInstances: ITerminalInstanceService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceTrustRequestService private readonly trust: IWorkspaceTrustRequestService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@INativeHostService private readonly nativeHost: INativeHostService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.repositoryContext = this._register(instantiation.createInstance(AndenRepositoryContext));
		const root = $('div.anden-workbench');
		container.classList.add('anden-session-window');
		container.prepend(root);
		const sidebar = append(root, $('nav.anden-sidebar', { 'aria-label': localize('sessions', "Sessions") }));
		const toolbar = append(sidebar, $('div.anden-sidebar-header'));
		const sessionsHeading = append(toolbar, $('h1', {}, localize('sessions', "Sessions")));
		this.newButton = append(toolbar, $('button.anden-primary', { type: 'button' }, localize('newSession', "New Session")));
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
		append(this.empty, $('h2', {}, localize('noSession', "No open session")));
		append(this.empty, $('p', {}, localize('startSession', "Start Pi or Codex in a folder of your choice.")));
		const startButton = append(this.empty, $('button.anden-primary', { type: 'button' }, localize('newSession', "New Session")));
		startButton.onclick = () => void this.newSession();
		this.renderSelection();
		if (integratedTitlebar) {
			this.integrateTitlebar(root, toolbar, sessionsHeading);
		}

		const observer = new ResizeObserver(() => this.layoutSession());
		observer.observe(this.content);
		this._register(toDisposable(() => {
			observer.disconnect();
			root.remove();
			container.classList.remove('anden-session-window');
		}));
		this._register(CommandsRegistry.registerCommand(switchSessionCommand, () => this.pickSession()));
	}

	focus(): void {
		if (this.selected?.showReview) {
			this.review.focus();
		} else if (this.selected) {
			this.selected.terminal.focus(true);
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
			const executable = await this.findExecutable(agent);
			if (!executable) {
				this.notifications.error(localize('missingExecutable', "Could not find an executable for {0}. Install it or set {1} to an absolute executable path in User Settings.", agent.label, `anden.${agent.id}.executablePath`));
				return;
			}
			await loadAndenCodeFont(this.content.ownerDocument);
			if (this._store.isDisposed) {
				return;
			}
			const terminal = await this.terminals.createTerminal({
				config: { executable, args: [], cwd: folder, name: label, hideFromUser: true, isTransient: true, useShellEnvironment: true, fontOverride: andenCodeFont },
				location: TerminalLocation.Panel,
			});
			if (this._store.isDisposed) {
				terminal.dispose();
				return;
			}
			this.addSession(terminal, label, agent, folder);
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

	private async findExecutable(agent: Agent): Promise<string | undefined> {
		const configured = this.configuration.inspect<string>(`anden.${agent.id}.executablePath`).userLocalValue?.trim();
		const backend = configured ? undefined : await this.terminalInstances.getBackend();
		const env = await backend?.getShellEnvironment() ?? await backend?.getEnvironment();
		const path = env && getCaseInsensitive(env, 'PATH');
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

	private addSession(terminal: ITerminalInstance, label: string, agent: Agent, folder: URI): void {
		const row = append(this.list, $('li.anden-session-row'));
		const selectButton = append(row, $<HTMLButtonElement>('button.anden-session-select', { type: 'button', title: folder.fsPath }));
		const nameLabel = append(selectButton, $('span.anden-session-name'));
		append(selectButton, $('span.anden-folder', {}, localize('sessionAgentFolder', '{0} · {1}', agent.label, basename(folder) || folder.fsPath)));
		const branchLabel = append(selectButton, $('span.anden-branch'));
		const menuButton = append(row, $<HTMLButtonElement>('button.anden-session-menu', { type: 'button', 'aria-haspopup': 'menu' }, '…'));
		const closeButton = append(row, $<HTMLButtonElement>('button.anden-session-close', { type: 'button' }, '×'));
		const surface = append(this.content, $('div.anden-terminal'));
		const disposables = new DisposableStore();
		const id = generateUuid();
		const observation = disposables.add(this.repositoryContext.watch(id, folder, summary => {
			session.repository = summary;
			this.renderSessionDetails(session);
			if (this.selected === session) {
				this.renderHeader();
			}
		}));
		const session: Session = {
			terminal, label, agent, folder, surface, selectButton, nameLabel, branchLabel, menuButton, closeButton, disposables,
			review: { folder, sessionId: id, whenWatching: observation.whenWatching }, showReview: false,
		};
		this.sessions.add(session);
		this.renderSessionDetails(session);
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
		disposables.add(terminal.onDisposed(() => this.removeSession(session)));
		disposables.add(terminal.onExit(exit => {
			if (typeof exit === 'number' && exit !== 0) {
				this.notifications.error(localize('sessionFailed', "{0} exited with code {1}.", session.label, exit));
			} else if (typeof exit === 'object') {
				this.notifications.error(exit.message);
			}
		}));
		selectButton.onclick = () => this.selectSession(session);
		closeButton.onclick = () => void this.terminals.safeDisposeTerminal(terminal);
		terminal.attachToElement(surface);
		this.selectSession(session, false);
		this.layoutSession();
		void terminal.focusWhenReady(true);
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
		await session.terminal.rename(label);
	}

	private renderSessionDetails(session: Session): void {
		session.nameLabel.textContent = session.label;
		session.menuButton.setAttribute('aria-label', localize('sessionActions', 'Actions for {0}', session.label));
		session.closeButton.setAttribute('aria-label', localize('closeSession', 'Close {0}', session.label));
		this.renderBranch(session.branchLabel, session.repository);
	}

	private renderBranch(element: HTMLElement, repository: IAndenRepositorySummary | undefined): void {
		const label = repository?.branch ?? (repository?.commit ? localize('detachedHead', 'Detached HEAD · {0}', repository.commit.slice(0, 8)) : '');
		element.textContent = label;
		element.title = label;
		element.hidden = !label;
	}

	private removeSession(session: Session): void {
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
		this.layoutSession();
		if (focus) {
			this.focus();
		}
	}

	private renderSelection(): void {
		for (const session of this.sessions.values()) {
			const active = session === this.selected;
			const terminalVisible = active && !session.showReview;
			session.surface.hidden = !terminalVisible;
			session.terminal.setVisible(terminalVisible);
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
		this.selected.showReview = !this.selected.showReview;
		this.renderSelection();
		this.layoutSession();
		this.focus();
	}

	private renderHeader(): void {
		const session = this.selected;
		this.heading.textContent = session?.label ?? '';
		this.folderLabel.textContent = session ? localize('sessionAgentFolder', '{0} · {1}', session.agent.label, session.folder.fsPath) : '';
		this.renderBranch(this.branchLabel, session?.repository);
		const button = this.changesButton;
		clearNode(button);
		const label = session?.showReview ? localize('backToTerminal', 'Back to Terminal') : localize('changes', 'Changes');
		append(button, $('span', {}, label));
		const lines = session?.showReview ? undefined : session?.repository?.lines;
		if (lines && (lines.added || lines.deleted)) {
			append(button, $('span.anden-lines-added', { 'aria-hidden': 'true' }, `+${lines.added}`));
			append(button, $('span.anden-lines-deleted', { 'aria-hidden': 'true' }, `\u2212${lines.deleted}`));
			button.setAttribute('aria-label', localize('changesLines', 'Changes: {0} lines added, {1} removed', lines.added, lines.deleted));
		} else {
			button.removeAttribute('aria-label');
		}
	}

	private layoutSession(): void {
		if (this.selected && !this.selected.showReview) {
			this.selected.terminal.layout({ width: this.content.clientWidth, height: this.content.clientHeight });
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
			session.disposables.dispose();
			session.terminal.dispose();
		}
		this.sessions.clear();
		super.dispose();
	}
}
