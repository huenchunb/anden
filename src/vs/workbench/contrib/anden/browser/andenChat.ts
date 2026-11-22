/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { localize } from '../../../../nls.js';
import { AndenHistoryRecord } from '../../../../platform/anden/common/andenHistory.js';
import { safeIntl } from '../../../../base/common/date.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { AndenActivity, AndenAgentState, AndenAgentUpdate, AndenAnswer, AndenModel, AndenModelRef, AndenModelSettings, AndenPiCommand, AndenReasoningOption, AndenRequest, AndenSessionStats, AndenTool } from '../common/andenAgent.js';
import { andenSlashCommands, AndenLocalCommand, isAndenLocalCommand, isPiTerminalCommand, parseSlashCommand } from '../common/andenSlashCommands.js';
import { andenButton, andenIcon, AndenIcon } from './andenIcons.js';
import './media/andenChat.css';

interface AndenChatActions {
	onDraftChange(text: string): void;
	send(text: string): Promise<void>;
	stop(): Promise<void>;
	listCommands(): Promise<readonly AndenPiCommand[]>;
	invokeCommand(name: string, args: string): Promise<void>;
	newSession(): Promise<void>;
	browseHistory(): Promise<void>;
	rename(name: string): Promise<void>;
	sessionDetails(): { label: string; folder: string };
	hotkeys(): Promise<void>;
	getLastAssistantText(): Promise<string>;
	getSessionStats(): Promise<AndenSessionStats>;
	listModels(): Promise<readonly AndenModel[]>;
	selectModel(model: AndenModelRef): Promise<void>;
	listReasoning(): Promise<readonly AndenReasoningOption[]>;
	selectReasoning(level: string): Promise<void>;
	answer(id: string, answer: AndenAnswer): Promise<void>;
	showFile(path: string): boolean;
}

const numberFormatter = safeIntl.NumberFormat();
const percentFormatter = safeIntl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const costFormatter = safeIntl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

const commandGroups = {
	anden: 'Anden',
	extension: localize('slashExtensions', 'Extensions'),
	prompt: localize('slashTemplates', 'Templates'),
	skill: localize('slashSkills', 'Skills'),
} as const;

type CommandSuggestion = { readonly name: string; readonly description: string; readonly source: keyof typeof commandGroups; readonly supported: boolean; readonly scope?: AndenPiCommand['scope'] };

function reasoningLabel(level: string): string {
	switch (level) {
		case 'off': case 'none': return localize('reasoningOff', 'Off');
		case 'minimal': return localize('reasoningMinimal', 'Minimal');
		case 'low': return localize('reasoningLow', 'Low');
		case 'medium': return localize('reasoningMedium', 'Medium');
		case 'high': return localize('reasoningHigh', 'High');
		case 'xhigh': return localize('reasoningExtraHigh', 'Extra high');
		case 'max': return localize('reasoningMax', 'Maximum');
		default: return level;
	}
}

interface MarkdownBlock {
	readonly element: HTMLElement;
	readonly render: MutableDisposable<IDisposable>;
	text: string;
	complete: boolean;
}

export function andenStatus(state: AndenAgentState, pending: boolean, activity?: AndenActivity): { icon: AndenIcon; label: string } {
	if (pending) { return { icon: 'status-waiting', label: localize('agentWaiting', 'Needs your input') }; }
	switch (state) {
		case 'starting': return { icon: 'status-working', label: localize('agentStarting', 'Starting') };
		case 'working': return { icon: 'status-working', label: activity === 'model' ? localize('agentConsulting', 'Consulting model') : activity === 'tools' ? localize('agentTools', 'Running tools') : activity === 'retry' ? localize('agentRetrying', 'Retrying') : activity === 'compaction' ? localize('agentCompacting', 'Compacting context') : localize('agentWorking', 'Working') };
		case 'stopping': return { icon: 'status-working', label: localize('agentStopping', 'Stopping') };
		case 'interrupted': return { icon: 'status-interrupted', label: localize('agentInterrupted', 'Interrupted') };
		case 'error': return { icon: 'status-error', label: localize('agentError', 'Error') };
		case 'disconnected': return { icon: 'status-disconnected', label: localize('agentDisconnected', 'Disconnected') };
		default: return { icon: 'status-ready', label: localize('agentReady', 'Ready') };
	}
}

export class AndenChat extends Disposable {
	private readonly transcript: HTMLElement;
	private readonly messages: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly stopButton: HTMLButtonElement;
	private readonly modelButton: HTMLButtonElement;
	private readonly reasoningButton: HTMLButtonElement;
	private readonly commandSuggestions: HTMLElement;
	private readonly commandList: HTMLElement;
	private readonly commandFeedback: HTMLElement;
	private readonly commandListId = `anden-slash-${generateUuid()}`;
	private commandButtons: { command: CommandSuggestion; button: HTMLButtonElement }[] = [];
	private piCommands: readonly AndenPiCommand[] = [];
	private catalogPending = false;
	private catalogError = false;
	private catalogRequested = false;
	private renderedQuery: string | undefined;
	private activeSuggestion = -1;
	private modelSettings: AndenModelSettings = {};
	private settingsOpen = false;
	private commandSuggestionsDismissed = false;
	private readonly requestButton: HTMLButtonElement;
	private readonly latest: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly code: EditorMarkdownCodeBlockRenderer;
	private readonly blocks = new Map<string, MarkdownBlock>();
	private readonly dirty = new Set<MarkdownBlock>();
	private readonly tools = new Map<string, { element: HTMLDetailsElement; update(tool: AndenTool): void }>();
	private readonly requests = new Map<string, { element: HTMLElement; form: HTMLElement }>();
	private readonly renderPending = this._register(new RunOnceScheduler(() => this.renderMarkdown(), 50));
	private busySending = false;
	private draftInFlight = '';
	private following = true;
	private state: AndenAgentState = 'starting';
	private activity: AndenActivity | undefined;
	private statusLabel = '';

	get pending(): boolean { return this.requests.size !== 0; }
	get active(): boolean { return this.state === 'working' || this.state === 'stopping' || this.pending; }
	get statusInfo(): ReturnType<typeof andenStatus> { return andenStatus(this.state, this.pending); }

	constructor(
		private readonly root: HTMLElement,
		private readonly actions: AndenChatActions | undefined,
		@IMarkdownRendererService private readonly markdown: IMarkdownRendererService,
		@IOpenerService private readonly opener: IOpenerService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
	) {
		super();
		this.code = instantiation.createInstance(EditorMarkdownCodeBlockRenderer);
		this.transcript = append(root, $('div.anden-transcript', { role: 'region', 'aria-label': localize('conversation', 'Conversation'), tabindex: '0' }));
		this.messages = append(this.transcript, $('div.anden-messages'));
		this.empty = append(this.messages, $('div.anden-chat-empty'));
		append(this.empty, andenIcon('chat'));
		append(this.empty, $('h3', {}, actions ? localize('chatEmpty', 'Start a conversation with Pi') : localize('emptySavedChat', 'No saved messages')));
		const panel = append(root, $('div.anden-composer'));
		panel.hidden = !actions;
		this.latest = append(panel, andenButton(localize('chatLatest', 'Go to latest'), 'latest'));
		this.latest.hidden = true;
		const activity = append(panel, $('div.anden-chat-activity'));
		this.status = append(activity, $('span.anden-status', { role: 'status' }));
		const activityControls = append(activity, $('div.anden-activity-controls'));
		this.requestButton = append(activityControls, andenButton(localize('chatReviewRequest', 'Go to request'), 'question'));
		this.requestButton.onclick = () => this.focus(true);
		this.stopButton = append(activityControls, andenButton(localize('chatStop', 'Stop'), 'stop'));
		this.input = append(panel, $<HTMLTextAreaElement>('textarea.anden-chat-input', { rows: '3', maxlength: '65536', placeholder: localize('chatPlaceholder', 'Message Pi…'), 'aria-label': localize('chatMessage', 'Message for Pi') }));
		this.commandSuggestions = append(panel, $('div.anden-command-suggestions'));
		this.commandList = append(this.commandSuggestions, $('div', { id: this.commandListId, role: 'listbox', 'aria-label': localize('sessionCommands', 'Session commands') }));
		this.commandFeedback = append(this.commandSuggestions, $('div.anden-command-heading', { role: 'status' }));
		const actionsBar = append(panel, $('div.anden-composer-actions'));
		const modelActions = append(actionsBar, $('div.anden-model-actions'));
		this.modelButton = append(modelActions, $<HTMLButtonElement>('button.anden-model-button', { type: 'button', 'aria-haspopup': 'listbox' }));
		this.modelButton.onclick = () => void this.runCommand('model');
		this.reasoningButton = append(modelActions, $<HTMLButtonElement>('button.anden-reasoning-button', { type: 'button', 'aria-haspopup': 'listbox' }));
		this.reasoningButton.onclick = () => void this.runCommand('thinking');
		this.sendButton = append(actionsBar, andenButton(localize('chatSend', 'Send'), 'send'));
		this.sendButton.classList.add('anden-primary');
		this.input.oninput = () => { this.commandSuggestionsDismissed = false; this.publishDraft(); this.renderStatus(); };
		this.input.onkeydown = event => {
			if (event.isComposing || event.keyCode === 229) { return; }
			if (!this.commandSuggestions.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && this.commandButtons.length) {
				event.preventDefault();
				this.moveSuggestion(event.key === 'ArrowDown' ? 1 : -1);
				return;
			}
			if (event.key === 'Escape' && !this.commandSuggestions.hidden) {
				event.preventDefault();
				event.stopPropagation();
				this.commandSuggestionsDismissed = true;
				this.renderStatus();
				return;
			}
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				const suggestion = this.commandSuggestions.hidden ? undefined : this.commandButtons[this.activeSuggestion];
				if (suggestion) { this.chooseSuggestion(suggestion.command); }
				else { void this.send(); }
			}
		};
		this.sendButton.onclick = () => void this.send();
		this.stopButton.onclick = () => void this.actions?.stop().catch(error => this.showError(error));
		this.latest.onclick = () => { this.following = true; this.scrollToEnd(); };
		this.transcript.onscroll = () => {
			if (root.hidden) { return; }
			this.following = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 24;
			this.latest.hidden = this.following;
		};
		this._register(theme.onDidColorThemeChange(() => {
			for (const block of this.blocks.values()) { this.dirty.add(block); }
			this.scheduleMarkdown();
		}));
		this.renderStatus();
	}

	focus(showPending = false): void {
		const pending = showPending ? this.requests.values().next().value : undefined;
		if (pending) {
			this.following = false;
			pending.element.focus();
		} else if (!this.actions || this.input.disabled) {
			this.transcript.focus();
		} else {
			this.input.focus();
		}
	}

	setDraft(text: string): void {
		this.input.value = text;
		this.publishDraft();
		this.renderStatus();
	}

	private publishDraft(): void {
		this.actions?.onDraftChange(this.input.value || this.draftInFlight);
	}

	restoreHistory(record: AndenHistoryRecord): void {
		if (record.truncated) { this.notice(localize('limitedSavedChat', 'Some messages were shortened or omitted because the saved conversation exceeded its size limit.')); }
		for (const [index, message] of record.messages.entries()) {
			const id = `history:${index}`;
			this.update(message.role === 'user' ? { kind: 'user', id, text: message.text } : { kind: 'text', id, text: message.text, append: false });
			if (!message.complete) { this.notice(message.role === 'user' ? localize('unconfirmedSavedMessage', 'Send not confirmed') : localize('incompleteSavedMessage', 'Incomplete response')); }
		}
		if (this.actions) { this.setDraft(record.draft); }
	}

	update(update: AndenAgentUpdate): void {
		if (this._store.isDisposed) { return; }
		switch (update.kind) {
			case 'user': {
				const article = this.article(localize('chatYou', 'You'));
				append(article, $('div.anden-chat-user-text', {}, update.text));
				break;
			}
			case 'piSession':
			case 'userAccepted': return;
			case 'modelSettings':
				this.modelSettings = update.settings;
				this.renderStatus();
				return;
			case 'text': this.updateText(update.id, update.text, update.append); break;
			case 'notice': this.notice(update.text); break;
			case 'tool': this.updateTool(update.tool); break;
			case 'state':
				this.state = update.state;
				this.activity = update.activity;
				if (!['starting', 'working', 'stopping'].includes(update.state)) {
					for (const id of this.requests.keys()) { this.resolveRequest(id); }
				}
				if (update.error) { this.notice(update.error, true); }
				break;
			case 'request': this.addRequest(update.request); break;
			case 'resolved': this.resolveRequest(update.id); break;
		}
		this.renderStatus();
		this.scrollToEnd();
	}

	private resolveRequest(id: string): void {
		const request = this.requests.get(id);
		if (!request) { return; }
		this.requests.delete(id);
		const { element, form } = request;
		const hadFocus = element.contains(element.ownerDocument.activeElement);
		clearNode(form);
		append(form, $('span', {}, localize('requestResolved', 'Request closed')));
		if (hadFocus) { element.focus(); }
	}

	private addRequest(request: AndenRequest): void {
		if (this.requests.has(request.id)) { return; }
		this.empty.hidden = true;
		const title = request.title || (request.kind === 'input' ? localize('piInput', 'Pi needs an answer') : localize('agentConfirmation', 'Confirmation required'));
		const card = append(this.messages, $('section.anden-request', { tabindex: '-1', 'aria-label': title }));
		const heading = append(card, $('h3.anden-chat-label'));
		append(heading, andenIcon(request.kind === 'input' ? 'question' : 'shield'));
		append(heading, $('span', {}, title));
		if (request.kind === 'confirm' && request.detail) { append(card, $('pre.anden-request-detail', {}, request.detail)); }
		const form = append(card, $('div.anden-request-form'));
		let readValue: (() => string | undefined) | undefined;
		if (request.kind === 'input') {
			const label = append(form, $('label.anden-request-field'));
			append(label, $('span', {}, title));
			if (request.options.length) {
				const select = append(label, $<HTMLSelectElement>('select'));
				append(select, $('option', { value: '' }, localize('selectOption', 'Select an option')));
				request.options.forEach((option, index) => append(select, $('option', { value: String(index) }, option)));
				readValue = () => select.value === '' ? undefined : request.options[Number(select.value)];
			} else {
				const input = append(label, $<HTMLTextAreaElement>('textarea', { rows: '2', maxlength: '65536' }));
				input.value = request.value ?? '';
				readValue = () => input.value;
			}
		}
		const feedback = append(form, $('div.anden-request-feedback', { role: 'status' }));
		const buttons = append(form, $('div.anden-request-actions'));
		const reply = async (answer: AndenAnswer) => {
			decline.disabled = allow.disabled = true;
			try { await this.actions?.answer(request.id, answer); }
			catch (error) {
				feedback.textContent = error instanceof Error ? error.message : localize('answerFailed', 'The answer could not be sent.');
				decline.disabled = allow.disabled = false;
			}
		};
		const decline = append(buttons, andenButton(request.kind === 'input' ? localize('cancelRequest', 'Cancel') : localize('denyRequest', 'Decline'), 'close'));
		const allow = append(buttons, andenButton(request.kind === 'input' ? localize('answerRequest', 'Submit answer') : localize('confirmRequest', 'Confirm'), 'status-completed'));
		decline.onclick = () => void reply({ kind: request.kind === 'input' ? 'cancel' : 'decline' });
		allow.onclick = () => {
			if (!readValue) { void reply({ kind: 'allow' }); return; }
			const value = readValue();
			if (value === undefined) { feedback.textContent = localize('answerRequired', 'Select an answer.'); return; }
			void reply({ kind: 'value', value });
		};
		this.requests.set(request.id, { element: card, form });
	}

	private get canConfigure(): boolean {
		return !!this.actions && !this.busySending && !this.settingsOpen && !this.pending && ['ready', 'interrupted', 'error'].includes(this.state);
	}

	private async runCommand(command: AndenLocalCommand, fromInput = false, args = ''): Promise<void> {
		const actions = this.actions;
		if (!actions || !this.canConfigure) { return; }
		const draft = fromInput ? this.input.value : '';
		if (fromInput) { this.setDraft(''); }
		this.settingsOpen = true;
		this.renderStatus();
		try {
			if (args && !['model', 'thinking', 'reasoning', 'name'].includes(command)) {
				throw new Error(localize('slashNoArguments', '/{0} does not take arguments.', command));
			}
			switch (command) {
				case 'settings': {
					const current = this.modelSettings;
					const selection = await this.quickInput.pick([
						{ command: 'model', label: localize('sessionModelOption', 'Model'), description: current.model?.label },
						{ command: 'thinking', label: localize('sessionReasoningOption', 'Reasoning'), description: current.reasoning ? reasoningLabel(current.reasoning) : undefined },
					], { title: localize('chatSessionSettings', 'Session settings'), placeHolder: localize('chooseSessionSetting', 'Choose a setting for this session') });
					if (selection && !this._store.isDisposed && !this.root.hidden) {
						if (selection.command === 'model') { await this.pickModel(); }
						else { await this.pickReasoning(); }
					}
					break;
				}
				case 'model': await this.pickModel(args); break;
				case 'thinking': case 'reasoning':
					if (args) { await actions.selectReasoning(args); }
					else { await this.pickReasoning(); }
					break;
				case 'new': await actions.newSession(); break;
				case 'resume': await actions.browseHistory(); break;
				case 'name': await actions.rename(args); break;
				case 'copy': {
					const text = await actions.getLastAssistantText();
					if (!text) { throw new Error(localize('slashNothingToCopy', 'Pi has not replied in this session yet.')); }
					if (!this._store.isDisposed) {
						await this.clipboard.writeText(text);
						this.notifications.info(localize('slashCopied', 'Copied the last Pi response.'));
					}
					break;
				}
				case 'session': await this.showSessionDetails(actions); break;
				case 'hotkeys': await actions.hotkeys(); break;
			}
		} catch (error) {
			if (!this._store.isDisposed) {
				if (draft && !this.input.value) { this.setDraft(draft); }
				this.notifications.warn(error instanceof Error ? error.message : localize('slashFailed', 'The command could not be completed.'));
			}
		} finally {
			this.settingsOpen = false;
			if (!this._store.isDisposed) {
				this.renderStatus();
				if (!this.root.hidden) { this.focus(); }
			}
		}
	}

	private async showSessionDetails(actions: AndenChatActions): Promise<void> {
		const stats = await actions.getSessionStats();
		if (this._store.isDisposed || this.root.hidden) { return; }
		const { label, folder } = actions.sessionDetails();
		const model = this.modelSettings.model;
		const level = this.modelSettings.reasoning;
		await this.dialogs.info(label, [
			localize('detailsFolder', 'Folder: {0}', folder),
			localize('detailsModel', 'Model: {0}', model?.label ?? localize('defaultModel', 'Default model')),
			level ? localize('detailsReasoning', 'Reasoning: {0}', reasoningLabel(level)) : undefined,
			stats.tokens === undefined ? undefined : localize('detailsTokens', 'Total tokens: {0}', numberFormatter.value.format(stats.tokens)),
			stats.contextPercent === undefined ? undefined : localize('detailsContext', 'Context used: {0}', percentFormatter.value.format(stats.contextPercent / 100)),
			stats.cost === undefined ? undefined : localize('detailsCost', 'Estimated cost: {0}', costFormatter.value.format(stats.cost)),
		].filter(Boolean).join('\n'));
	}

	private async pickModel(args = ''): Promise<void> {
		const actions = this.actions;
		if (!actions) { return; }
		const models = await actions.listModels();
		if (this._store.isDisposed || this.root.hidden) { return; }
		if (!models.length) { throw new Error(localize('noSessionModels', 'The agent did not report any available models.')); }
		if (args) {
			const matches = models.filter(model => `${model.provider}/${model.id}` === args || model.id === args);
			if (matches.length !== 1) { throw new Error(localize('slashModelNotUnique', 'Choose an available model using /model or /model provider/model.')); }
			await actions.selectModel({ id: matches[0].id, provider: matches[0].provider });
			return;
		}
		const current = this.modelSettings.model;
		const selected = (model: AndenModel) => model.id === current?.id && model.provider === current.provider;
		const options = models.map(model => ({
			model,
			label: model.label,
			description: [model.provider, model.id !== model.label ? model.id : undefined, selected(model) ? localize('selectedModel', 'Selected') : undefined].filter(Boolean).join(' · '),
		}));
		const result = await this.quickInput.pick(options, { title: localize('chooseModel', 'Choose Model'), placeHolder: localize('searchModels', 'Search models for this session'), matchOnDescription: true, activeItem: options.find(option => selected(option.model)) });
		if (result && !this._store.isDisposed && !this.root.hidden) { await actions.selectModel({ id: result.model.id, provider: result.model.provider }); }
	}

	private async pickReasoning(): Promise<void> {
		const actions = this.actions;
		if (!actions) { return; }
		const levels = await actions.listReasoning();
		if (this._store.isDisposed || this.root.hidden) { return; }
		if (!levels.length) { throw new Error(localize('noSessionReasoning', 'The agent did not report reasoning levels for this model.')); }
		const options = levels.map(level => ({ level, label: reasoningLabel(level.id), description: level.id === this.modelSettings.reasoning ? localize('selectedReasoning', 'Selected') : undefined }));
		const result = await this.quickInput.pick(options, { title: localize('chooseReasoning', 'Choose Reasoning Level'), placeHolder: localize('searchReasoning', 'Choose a level for this session'), activeItem: options.find(option => option.level.id === this.modelSettings.reasoning) });
		if (result && !this._store.isDisposed && !this.root.hidden) { await actions.selectReasoning(result.level.id); }
	}

	private async send(): Promise<void> {
		if (!this.actions || this.sendButton.disabled) { return; }
		const value = this.input.value;
		const command = parseSlashCommand(value);
		if (command && isAndenLocalCommand(command.name)) { await this.runCommand(command.name, true, command.args); return; }
		if (command && isPiTerminalCommand(command.name)) {
			this.notifications.warn(localize('slashNotSupported', '/{0} is a Pi terminal command and is not available in Anden.', command.name));
			return;
		}
		if (value.trim() === '/') { return; }
		this.draftInFlight = value;
		this.input.value = '';
		this.busySending = true;
		this.following = true;
		this.renderStatus();
		try {
			if (command) { await this.actions.invokeCommand(command.name, command.args); }
			else { await this.actions.send(value); }
		} catch (error) {
			if (!this.input.value) { this.input.value = value; }
			if (command) { this.notifications.warn(error instanceof Error ? error.message : localize('slashFailed', 'The command could not be completed.')); }
			else { this.showError(error); }
		}
		finally { this.draftInFlight = ''; this.publishDraft(); this.busySending = false; this.renderStatus(); }
	}

	private chooseSuggestion(command: CommandSuggestion): void {
		if (!this.canConfigure || !command.supported) { return; }
		if (command.source === 'anden' && isAndenLocalCommand(command.name)) {
			void this.runCommand(command.name, true);
		} else {
			// Insert first so users can supply an argument or review what will be invoked.
			this.setDraft(`/${command.name} `);
			this.input.focus();
		}
	}

	private moveSuggestion(direction: number): void {
		const count = this.commandButtons.length;
		if (!count) { return; }
		let index = this.activeSuggestion < 0 ? (direction > 0 ? -1 : count) : this.activeSuggestion;
		for (let attempt = 0; attempt < count; attempt++) {
			index = (index + direction + count) % count;
			const { button, command } = this.commandButtons[index];
			if (!command.supported) { continue; }
			this.selectSuggestion(index);
			button.scrollIntoView({ block: 'nearest' });
			return;
		}
	}

	private selectSuggestion(index: number): void {
		this.commandButtons[this.activeSuggestion]?.button.setAttribute('aria-selected', 'false');
		this.activeSuggestion = index;
		const suggestion = this.commandButtons[index];
		if (suggestion) {
			suggestion.button.setAttribute('aria-selected', 'true');
			this.input.setAttribute('aria-activedescendant', suggestion.button.id);
		} else { this.input.removeAttribute('aria-activedescendant'); }
	}

	private renderCommandSuggestions(refresh = false): void {
		const actions = this.actions;
		const value = this.input.value.trimStart();
		const query = /^\/[\w.:-]{0,160}$/.test(value) ? value.slice(1).toLowerCase() : undefined;
		if (query === undefined) { this.catalogRequested = false; }
		if (!actions || !this.canConfigure || this.commandSuggestionsDismissed || query === undefined) {
			this.commandSuggestions.hidden = true;
			this.renderedQuery = undefined;
			this.input.removeAttribute('aria-controls');
			this.input.removeAttribute('aria-activedescendant');
			return;
		}
		if (!this.catalogRequested && !this.catalogPending) {
			this.catalogRequested = this.catalogPending = true;
			this.catalogError = false;
			this.piCommands = [];
			this.renderedQuery = undefined;
			void actions.listCommands().then(commands => { this.piCommands = commands; }, () => { this.catalogError = true; }).finally(() => {
				this.catalogPending = false;
				if (!this._store.isDisposed) { this.renderCommandSuggestions(true); }
			});
		}
		if (!refresh && this.renderedQuery === query) { return; }
		const previousSelection = refresh && this.renderedQuery === query ? this.commandButtons[this.activeSuggestion]?.command.name : undefined;
		this.renderedQuery = query;
		this.commandSuggestions.hidden = false;
		this.input.setAttribute('aria-controls', this.commandListId);
		this.activeSuggestion = -1;
		this.commandButtons = [];
		clearNode(this.commandList);
		const catalog: CommandSuggestion[] = [
			...Object.entries(andenSlashCommands).map(([name, description]): CommandSuggestion => ({ name, description, source: 'anden', supported: true })),
			...this.piCommands,
		];
		const nameMatches = catalog.filter(command => command.name.toLowerCase().includes(query));
		const commands = nameMatches.length ? nameMatches : catalog.filter(command => command.description.toLowerCase().includes(query));
		for (const [source, title] of Object.entries(commandGroups)) {
			const matches = commands.filter(command => command.source === source);
			if (!matches.length) { continue; }
			matches.sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)));
			const group = append(this.commandList, $('div.anden-command-group', { role: 'group', 'aria-label': title }));
			append(group, $('div.anden-command-heading', { 'aria-hidden': 'true' }, title));
			for (const command of matches) {
				const button = append(group, $<HTMLButtonElement>('button.anden-command-option', { type: 'button', role: 'option', id: `${this.commandListId}-${this.commandButtons.length}`, tabindex: '-1', 'aria-selected': 'false' }));
				button.disabled = !command.supported;
				append(button, $('span.anden-command-name', {}, `/${command.name}`));
				const description = command.supported ? command.description : localize('slashTerminalUI', "Requires Pi's terminal interface");
				const scope = command.scope === 'project' ? localize('slashProject', 'Project') : command.scope === 'user' ? localize('slashUser', 'User') : undefined;
				append(button, $('span.anden-command-description', {}, [scope, description].filter(Boolean).join(' · ')));
				button.onmousedown = event => event.preventDefault();
				button.onclick = () => this.chooseSuggestion(command);
				this.commandButtons.push({ button, command });
			}
		}
		const feedback = this.catalogPending ? localize('slashLoading', 'Loading Pi commands…') : this.catalogError ? localize('slashCatalogFailed', 'Pi commands could not be loaded.') : !this.commandButtons.length ? localize('slashNoResults', 'No matching commands') : undefined;
		this.selectSuggestion(this.commandButtons.findIndex(entry => entry.command.name === previousSelection));
		this.commandList.hidden = !this.commandButtons.length;
		this.commandFeedback.hidden = !feedback;
		this.commandFeedback.textContent = feedback ?? '';
	}

	private renderStatus(): void {
		const info = andenStatus(this.state, this.pending, this.activity);
		if (info.label !== this.statusLabel) {
			this.statusLabel = info.label;
			clearNode(this.status);
			append(this.status, andenIcon(info.icon));
			append(this.status, $('span', {}, info.label));
		}
		this.root.classList.toggle('anden-working', info.icon === 'status-working');
		this.requestButton.hidden = !this.pending;
		this.stopButton.hidden = !this.active || this.state === 'starting' || this.state === 'disconnected';
		this.stopButton.disabled = this.state !== 'working';
		this.input.disabled = this.state === 'disconnected';
		const model = this.modelSettings.model;
		const label = model?.label || localize('defaultModel', 'Default model');
		this.modelButton.textContent = label;
		this.modelButton.title = localize('changeModelLabel', 'Change model: {0}', label);
		this.modelButton.setAttribute('aria-label', this.modelButton.title);
		const level = this.modelSettings.reasoning;
		const reasoning = level ? reasoningLabel(level) : undefined;
		this.reasoningButton.textContent = reasoning ? localize('currentReasoning', 'Reasoning: {0}', reasoning) : localize('sessionReasoningOption', 'Reasoning');
		this.reasoningButton.title = reasoning ? localize('changeCurrentReasoning', 'Change reasoning level: {0}', reasoning) : localize('changeReasoning', 'Change reasoning level');
		this.reasoningButton.setAttribute('aria-label', this.reasoningButton.title);
		this.modelButton.disabled = this.reasoningButton.disabled = !this.canConfigure;
		this.renderCommandSuggestions();
		this.sendButton.disabled = !this.canConfigure || !this.input.value.trim();
	}

	private updateText(id: string, value: string, incremental: boolean): void {
		if (!id) { return; }
		let block = this.blocks.get(id);
		if (!block) {
			if (!value) { return; }
			const article = this.article('Pi', 'agent-pi');
			block = { text: '', complete: false, element: append(article, $('div.anden-markdown')), render: this._register(new MutableDisposable()) };
			this.blocks.set(id, block);
		}
		if (incremental && block.complete) { return; }
		const next = incremental ? block.text + value : value;
		block.text = next.length > 262144 ? `${next.slice(0, 262144)}\n\n${localize('responseTruncated', '[Response truncated for display]')}` : next;
		block.complete = !incremental;
		this.dirty.add(block);
		this.scheduleMarkdown();
	}

	private scheduleMarkdown(): void {
		if (!this.renderPending.isScheduled()) { this.renderPending.schedule(); }
	}

	private renderMarkdown(): void {
		for (const block of this.dirty) {
			const rendered = this.markdown.render(new MarkdownString(block.text, { isTrusted: false, supportHtml: false }), {
				fillInIncompleteTokens: !block.complete,
				sanitizerConfig: { remoteImageIsAllowed: () => false, allowedTags: { override: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul'] } },
				actionHandler: link => { if (/^https?:\/\//i.test(link)) { void this.opener.open(link, { openExternal: true, allowCommands: false, allowContributedOpeners: false, fromUserGesture: true }); } },
				codeBlockRenderer: (language, value) => this.renderCode(language, value),
				asyncRenderCallback: () => this.scrollToEnd(),
			});
			block.render.value = rendered;
			block.element.replaceChildren(rendered.element);
		}
		this.dirty.clear();
		this.scrollToEnd();
	}

	private async renderCode(language: string, value: string): Promise<HTMLElement> {
		const element = $('div.anden-code-block');
		const header = append(element, $('div.anden-code-toolbar'));
		append(header, $('span', {}, language || localize('plainText', 'Plain text')));
		const copy = append(header, andenButton(localize('copyCode', 'Copy'), 'copy'));
		copy.onclick = () => void this.clipboard.writeText(value).catch(error => this.showError(error));
		const fallback = () => append(element, $('pre', {}, value));
		if (value.length > 32768) { fallback(); return element; }
		try { append(element, await this.code.renderCodeBlock(language, value, {})); }
		catch { fallback(); }
		return element;
	}

	private updateTool(tool: AndenTool): void {
		let view = this.tools.get(tool.id);
		if (!view) {
			this.empty.hidden = true;
			const element = append(this.messages, $<HTMLDetailsElement>('details.anden-tool'));
			const summary = append(element, $('summary'));
			const output = append(element, $('pre.anden-tool-output'));
			const jump = append(element, andenButton(localize('toolReview', 'Show in Changes'), 'diff'));
			const targetMessage = append(element, $('span.anden-tool-feedback', { role: 'status' }));
			view = {
				element, update: current => {
					clearNode(summary);
					append(summary, andenIcon('expand'));
					append(summary, andenIcon(current.kind === 'other' ? 'tool' : current.kind));
					append(summary, $('span.anden-tool-label', {}, current.target ? `${current.name} · ${current.target}` : current.name));
					const status = current.status === 'completed' ? { icon: 'status-completed' as const, label: localize('toolDone', 'Done') } : current.status === 'failed' ? andenStatus('error', false) : current.status === 'interrupted' ? andenStatus('interrupted', false) : andenStatus('working', false);
					append(summary, andenIcon(status.icon));
					append(summary, $('span', {}, status.label));
					output.textContent = current.output || localize('toolNoOutput', 'No output');
					jump.hidden = current.kind !== 'edit' || !current.path;
					jump.onclick = () => {
						if (!current.path || !this.actions?.showFile(current.path)) { targetMessage.textContent = localize('toolNoChange', 'No reviewable change for this file.'); }
					};
				}
			};
			this.tools.set(tool.id, view);
		}
		view.update(tool);
	}

	private article(label: string, icon?: AndenIcon): HTMLElement {
		this.empty.hidden = true;
		const article = append(this.messages, $('article.anden-chat-message'));
		const heading = append(article, $('h3.anden-chat-label'));
		if (icon) { append(heading, andenIcon(icon)); }
		append(heading, $('span', {}, label));
		return article;
	}

	private scrollToEnd(): void {
		if (!this.root.hidden && this.following) { this.transcript.scrollTop = this.transcript.scrollHeight; this.latest.hidden = true; }
	}

	private notice(value: string, error = false): void {
		this.empty.hidden = true;
		const item = append(this.messages, $('div.anden-chat-notice'));
		if (error) { append(item, andenIcon('status-error')); }
		append(item, $('span', {}, value));
		this.scrollToEnd();
	}

	private showError(error: unknown): void {
		if (!this._store.isDisposed) { this.notice(error instanceof Error ? error.message : localize('agentActionError', 'The action could not be completed.'), true); }
	}
}
