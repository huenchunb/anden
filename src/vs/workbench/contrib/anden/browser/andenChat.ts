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
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { AndenActivity, AndenAgentKind, AndenAgentState, AndenAgentUpdate, AndenAnswer, AndenRequest, AndenTool } from '../common/andenAgent.js';
import { andenButton, andenIcon, AndenIcon } from './andenIcons.js';
import './media/andenChat.css';

interface AndenChatActions {
	send(text: string): Promise<void>;
	stop(): Promise<void>;
	answer(id: string, answer: AndenAnswer): Promise<void>;
	showFile(path: string): boolean;
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
	private following = true;
	private state: AndenAgentState = 'starting';
	private activity: AndenActivity | undefined;
	private statusLabel = '';

	get pending(): boolean { return this.requests.size !== 0; }
	get active(): boolean { return this.state === 'working' || this.state === 'stopping' || this.pending; }
	get statusInfo(): ReturnType<typeof andenStatus> { return andenStatus(this.state, this.pending); }

	constructor(
		private readonly root: HTMLElement,
		private readonly agent: AndenAgentKind,
		private readonly agentLabel: string,
		private readonly actions: AndenChatActions,
		@IMarkdownRendererService private readonly markdown: IMarkdownRendererService,
		@IOpenerService private readonly opener: IOpenerService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
	) {
		super();
		this.code = instantiation.createInstance(EditorMarkdownCodeBlockRenderer);
		this.transcript = append(root, $('div.anden-transcript', { role: 'region', 'aria-label': localize('conversation', 'Conversation'), tabindex: '0' }));
		this.messages = append(this.transcript, $('div.anden-messages'));
		this.empty = append(this.messages, $('div.anden-chat-empty'));
		append(this.empty, andenIcon('chat'));
		append(this.empty, $('h3', {}, localize('chatEmpty', 'Start a conversation with {0}', agentLabel)));
		const panel = append(root, $('div.anden-composer'));
		this.latest = append(panel, andenButton(localize('chatLatest', 'Go to latest'), 'latest'));
		this.latest.hidden = true;
		const activity = append(panel, $('div.anden-chat-activity'));
		this.status = append(activity, $('span.anden-status', { role: 'status' }));
		const activityControls = append(activity, $('div.anden-activity-controls'));
		this.requestButton = append(activityControls, andenButton(localize('chatReviewRequest', 'Go to request'), 'question'));
		this.requestButton.onclick = () => this.focus(true);
		this.stopButton = append(activityControls, andenButton(localize('chatStop', 'Stop'), 'stop'));
		this.input = append(panel, $<HTMLTextAreaElement>('textarea.anden-chat-input', { rows: '3', maxlength: '65536', placeholder: localize('chatPlaceholder', 'Message {0}…', agentLabel), 'aria-label': localize('chatMessage', 'Message for {0}', agentLabel) }));
		const actionsBar = append(panel, $('div.anden-composer-actions'));
		this.sendButton = append(actionsBar, andenButton(localize('chatSend', 'Send'), 'send'));
		this.sendButton.classList.add('anden-primary');
		this.input.oninput = () => this.renderStatus();
		this.input.onkeydown = event => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				void this.send();
			}
		};
		this.sendButton.onclick = () => void this.send();
		this.stopButton.onclick = () => void this.actions.stop().catch(error => this.showError(error));
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
		} else if (this.input.disabled) {
			this.transcript.focus();
		} else {
			this.input.focus();
		}
	}

	update(update: AndenAgentUpdate): void {
		if (this._store.isDisposed) { return; }
		switch (update.kind) {
			case 'user': {
				const article = this.article(localize('chatYou', 'You'));
				append(article, $('div.anden-chat-user-text', {}, update.text));
				break;
			}
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
		const title = request.title || (request.kind === 'command' ? localize('approveCommand', 'Approve command') : request.kind === 'files' ? localize('approveFiles', 'Approve file changes') : request.kind === 'permissions' ? localize('approvePermissions', 'Approve additional permissions') : request.kind === 'questions' ? localize('agentQuestions', 'The agent has a question') : localize('agentConfirmation', 'Confirmation required'));
		const card = append(this.messages, $('section.anden-request', { tabindex: '-1', 'aria-label': title }));
		const heading = append(card, $('h3.anden-chat-label'));
		append(heading, andenIcon(request.kind === 'questions' ? 'question' : 'shield'));
		append(heading, $('span', {}, title));
		if (request.detail) { append(card, $('pre.anden-request-detail', {}, request.detail)); }
		const form = append(card, $('div.anden-request-form'));
		const fields = request.questions?.map(question => {
			const label = append(form, $('label.anden-request-field'));
			append(label, $('span', {}, question.label));
			if (question.options?.length && !question.secret) {
				const select = append(label, $<HTMLSelectElement>('select'));
				append(select, $('option', { value: '' }, localize('selectOption', 'Select an option')));
				question.options.forEach((option, index) => append(select, $('option', { value: String(index), title: option.description }, option.description ? `${option.label} — ${option.description}` : option.label)));
				const other = question.other ? append(label, $<HTMLInputElement>('input', { type: 'text', maxlength: '65536', 'aria-label': localize('otherAnswer', 'Other answer') })) : undefined;
				if (other) {
					append(select, $('option', { value: 'other' }, localize('otherOption', 'Other…')));
					other.hidden = true;
					select.onchange = () => { other.hidden = select.value !== 'other'; };
				}
				return { id: question.id, read: () => select.value === 'other' ? other?.value : select.value === '' ? undefined : question.options?.[Number(select.value)]?.label };
			}
			const input = question.secret ? append(label, $<HTMLInputElement>('input', { type: 'password', autocomplete: 'off', maxlength: '65536' })) : append(label, $<HTMLTextAreaElement>('textarea', { rows: '2', maxlength: '65536' }));
			input.value = question.secret ? '' : question.value ?? '';
			return { id: question.id, read: () => input.value };
		});
		const feedback = append(form, $('div.anden-request-feedback', { role: 'status' }));
		const buttons = append(form, $('div.anden-request-actions'));
		const reply = async (answer: AndenAnswer) => {
			decline.disabled = allow.disabled = true;
			try { await this.actions.answer(request.id, answer); }
			catch (error) {
				feedback.textContent = error instanceof Error ? error.message : localize('answerFailed', 'The answer could not be sent.');
				decline.disabled = allow.disabled = false;
			}
		};
		const decline = append(buttons, andenButton(request.kind === 'questions' ? localize('cancelRequest', 'Cancel') : localize('denyRequest', 'Decline'), 'close'));
		const allowLabel = request.kind === 'questions' ? localize('answerRequest', 'Submit answer') : request.kind === 'confirm' ? localize('confirmRequest', 'Confirm') : request.kind === 'permissions' ? localize('allowTurn', 'Allow for this turn') : localize('allowOnce', 'Allow once');
		const allow = append(buttons, andenButton(allowLabel, 'status-completed'));
		decline.onclick = () => void reply({ kind: request.kind === 'questions' ? 'cancel' : 'decline' });
		allow.onclick = () => {
			if (!fields) { void reply({ kind: 'allow' }); return; }
			const values = fields.map(field => ({ id: field.id, value: field.read() }));
			if (values.some(entry => entry.value === undefined)) { feedback.textContent = localize('answerRequired', 'Select an answer for each question.'); return; }
			void reply({ kind: 'answers', values: values.map(entry => ({ id: entry.id, value: entry.value ?? '' })) });
		};
		this.requests.set(request.id, { element: card, form });
	}

	private async send(): Promise<void> {
		if (this.sendButton.disabled) { return; }
		const value = this.input.value;
		this.input.value = '';
		this.busySending = true;
		this.following = true;
		this.renderStatus();
		try { await this.actions.send(value); }
		catch (error) { if (!this.input.value) { this.input.value = value; } this.showError(error); }
		finally { this.busySending = false; this.renderStatus(); }
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
		this.sendButton.disabled = this.busySending || this.pending || !['ready', 'interrupted', 'error'].includes(this.state) || !this.input.value.trim();
	}

	private updateText(id: string, value: string, incremental: boolean): void {
		if (!id) { return; }
		let block = this.blocks.get(id);
		if (!block) {
			if (!value) { return; }
			const article = this.article(this.agentLabel, this.agent === 'pi' ? 'agent-pi' : 'agent-codex');
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
						if (!current.path || !this.actions.showFile(current.path)) { targetMessage.textContent = localize('toolNoChange', 'No reviewable change for this file.'); }
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
