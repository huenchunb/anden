/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { resolveExecutable } from './executable';
import { agents, getPreferredFolder, Session, SessionRegistry } from './sessions';

type TerminalSession = Session<vscode.Terminal, vscode.WorkspaceFolder>;

export function activate(context: vscode.ExtensionContext): void {
	const sessions = new SessionRegistry<vscode.Terminal, vscode.WorkspaceFolder>();
	const changed = new vscode.EventEmitter<void>();
	const focusSession = 'anden.focusSession';

	function refreshSessions(): void {
		void vscode.commands.executeCommand('setContext', 'anden.hasSessions', sessions.all.length > 0);
		changed.fire();
	}

	function focus(terminal: vscode.Terminal): void {
		if (sessions.has(terminal)) {
			terminal.show();
		}
	}

	context.subscriptions.push(
		changed,
		vscode.window.registerTreeDataProvider<TerminalSession>('anden.sessions', {
			onDidChangeTreeData: changed.event,
			getChildren: element => element ? [] : [...sessions.all],
			getTreeItem: session => {
				const item = new vscode.TreeItem(session.label);
				const active = vscode.window.activeTerminal === session.terminal;
				item.id = session.label;
				item.description = session.folder.name;
				item.tooltip = session.folder.uri.fsPath;
				item.iconPath = new vscode.ThemeIcon(active ? 'circle-filled' : 'terminal');
				item.accessibilityInformation = {
					label: active ? vscode.l10n.t('{0}, {1}, active terminal', session.label, session.folder.name) : vscode.l10n.t('{0}, {1}', session.label, session.folder.name),
				};
				item.command = { command: focusSession, title: vscode.l10n.t('Focus Session'), arguments: [session.terminal] };
				return item;
			},
		}),
		vscode.window.onDidChangeActiveTerminal(() => changed.fire()),
		vscode.window.onDidCloseTerminal(terminal => {
			if (sessions.remove(terminal)) {
				refreshSessions();
			}
		}),
		vscode.commands.registerCommand(focusSession, focus),
		vscode.commands.registerCommand('anden.switchSession', async () => {
			const open = sessions.all;
			if (open.length === 0) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No Anden sessions are open. Run Anden: New Session to start one.'));
				return;
			}
			if (open.length === 1) {
				focus(open[0].terminal);
				return;
			}
			const picked = await vscode.window.showQuickPick(open.map(session => ({
				label: session.label,
				description: session.folder.uri.fsPath,
				terminal: session.terminal,
			})), { placeHolder: vscode.l10n.t('Select an Anden session'), matchOnDescription: true });
			if (picked) {
				focus(picked.terminal);
			}
		}),
		vscode.commands.registerCommand('anden.newSession', async () => {
			if (!vscode.workspace.isTrusted) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before starting an Anden session.'));
				return;
			}
			if (vscode.env.remoteName) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Anden sessions are only available in local workspaces.'));
				return;
			}
			if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file')) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Open a local folder before starting an Anden session.'));
				return;
			}
			const agent = await vscode.window.showQuickPick(agents, { placeHolder: vscode.l10n.t('Select an agent') });
			if (!agent) {
				return;
			}
			const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
			if (folders.length === 0) {
				return;
			}
			const activeFile = vscode.window.activeTextEditor?.document.uri;
			const activeFolder = activeFile && vscode.workspace.getWorkspaceFolder(activeFile);
			const folder = getPreferredFolder(folders, activeFolder) ?? (await vscode.window.showWorkspaceFolderPick({
				placeHolder: vscode.l10n.t('Select the working folder for this session'),
				ignoreFocusOut: true,
			}));
			if (!folder) {
				return;
			}
			if (folder.uri.scheme !== 'file') {
				void vscode.window.showWarningMessage(vscode.l10n.t('Select a local folder to start an Anden session.'));
				return;
			}
			const key = `${agent.id}.executablePath`;
			const configuredPath = vscode.workspace.getConfiguration('anden').inspect<string>(key)?.globalValue?.trim();
			if (configuredPath && !isAbsolute(configuredPath)) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Set {0} to an absolute path in User Settings, or leave it empty to use the terminal PATH.', `anden.${key}`));
				return;
			}
			const executable = await resolveExecutable(agent.id, configuredPath);
			if (!executable) {
				void vscode.window.showErrorMessage(configuredPath
					? vscode.l10n.t('Cannot run {0} at {1}. Check {2} in User Settings.', agent.label, configuredPath, `anden.${key}`)
					: vscode.l10n.t('{0} was not found on the application PATH. Install it or set {1} to its absolute path in User Settings.', agent.label, `anden.${key}`));
				return;
			}
			const terminal = sessions.create(agent, folder, name => vscode.window.createTerminal({
				name,
				cwd: folder.uri,
				shellPath: executable,
				shellArgs: [],
				location: vscode.TerminalLocation.Panel,
				isTransient: true,
			}));
			refreshSessions();
			focus(terminal);
		}),
	);
	refreshSessions();
}
