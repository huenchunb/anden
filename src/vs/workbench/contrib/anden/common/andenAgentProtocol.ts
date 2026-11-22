/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AndenPiSession, parsePiSession } from '../../../../platform/anden/common/andenHistory.js';
import { AndenActivity, AndenAgentState, AndenAgentUpdate, AndenAnswer, AndenModel, AndenModelRef, AndenReasoningOption, AndenRequest, AndenTool, AndenToolKind } from './andenAgent.js';

type Wire = Record<string, unknown>;
const record = (value: unknown): Wire => value && typeof value === 'object' && !Array.isArray(value) ? value as Wire : {};
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const bounded = (value: string, max = 8192): string => value.length > max ? `${value.slice(0, max)}…` : value;
const maxOutput = 32768;

interface PendingRequest {
	readonly request: AndenRequest;
	readonly reply: (answer: AndenAnswer) => Wire;
}

/** Pi RPC over JSON lines. */
export class AndenAgentProtocol {
	private sequence = 0;
	private state: AndenAgentState = 'starting';
	private activity: AndenActivity | undefined;
	private messageId = '';
	private failure = '';
	private runActive = false;
	private model: AndenModel | undefined;
	private changingSettings = false;
	private sending = false;
	private readonly tools = new Map<string, AndenTool>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly callbacks = new Map<number, { timer: ReturnType<typeof setTimeout>; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();

	constructor(private readonly cwd: string, private readonly write: (value: Wire) => void, private readonly emit: (update: AndenAgentUpdate) => void, private readonly piResume?: AndenPiSession) { }

	async start(): Promise<void> {
		const data = record(await this.call('get_state'));
		if (typeof data.isStreaming !== 'boolean') {
			throw new Error(localize('piProtocol', 'The installed Pi does not provide a compatible RPC state.'));
		}
		const session = parsePiSession({ sessionId: data.sessionId, sessionFile: data.sessionFile, cwd: this.cwd });
		if (this.piResume && (!session || session.sessionId !== this.piResume.sessionId || session.sessionFile !== this.piResume.sessionFile || data.isStreaming || data.isCompacting)) {
			throw new Error(localize('piResumeMismatch', 'Pi did not restore the expected idle session.'));
		}
		if (session) { this.emit({ kind: 'piSession', session }); }
		this.updateSettings(data);
		this.setState('ready');
	}

	private requireIdle(): void {
		if (!['ready', 'interrupted', 'error'].includes(this.state) || this.requests.size || this.changingSettings || this.sending) {
			throw new Error(localize('settingsBusy', 'Wait for the current turn to finish.'));
		}
	}

	private async changeSettings(action: () => Promise<void>): Promise<void> {
		this.requireIdle();
		this.changingSettings = true;
		try { await action(); } finally { this.changingSettings = false; }
	}

	async listModels(): Promise<readonly AndenModel[]> {
		this.requireIdle();
		const models = record(await this.call('get_available_models'));
		await this.refreshSettings();
		return array(models.models).map(value => this.parseModel(record(value))).filter((model): model is AndenModel => !!model);
	}

	async selectModel(model: AndenModelRef): Promise<void> {
		await this.changeSettings(async () => {
			await this.call('set_model', { provider: model.provider, modelId: model.id });
			await this.refreshSettings();
		});
	}

	async listReasoning(): Promise<readonly AndenReasoningOption[]> {
		this.requireIdle();
		await this.refreshSettings();
		return this.getReasoning();
	}

	async selectReasoning(level: string): Promise<void> {
		await this.changeSettings(async () => {
			const levels = await this.getReasoning();
			if (!levels.some(option => option.id === level)) { throw new Error(localize('reasoningNotAvailable', 'This reasoning level is not available for the current model.')); }
			await this.call('set_thinking_level', { level });
			await this.refreshSettings();
		});
	}

	private async getReasoning(): Promise<readonly AndenReasoningOption[]> {
		if (!this.model) { return []; }
		const state = record(await this.call('get_available_thinking_levels'));
		return array(state.levels).map(text).filter(Boolean).map(id => ({ id }));
	}

	private parseModel(data: Wire): AndenModel | undefined {
		const id = text(data.id);
		const provider = text(data.provider);
		return id && provider ? { id, provider, label: bounded(text(data.name) || id, 160) } : undefined;
	}

	private updateSettings(data: Wire): void {
		this.model = this.parseModel(record(data.model));
		this.emit({ kind: 'modelSettings', settings: { model: this.model, reasoning: text(data.thinkingLevel) || undefined } });
	}

	private async refreshSettings(): Promise<void> { this.updateSettings(record(await this.call('get_state'))); }

	async send(message: string): Promise<void> {
		if (!['ready', 'interrupted', 'error'].includes(this.state) || this.requests.size || this.changingSettings || this.sending) {
			throw new Error(localize('agentBusy', 'The session is not ready to receive a message.'));
		}
		this.sending = true;
		this.failure = '';
		this.messageId = '';
		this.setState('working');
		const id = `user-${++this.sequence}`;
		this.emit({ kind: 'user', id, text: message });
		try {
			const response = record(await this.call('prompt', { message }));
			this.emit({ kind: 'userAccepted', id });
			if (response.disposition === 'handled' && !this.runActive && (this.state === 'working' || this.state === 'stopping')) {
				this.finish(this.state === 'stopping' ? 'interrupted' : 'ready');
			}
		} catch (error) {
			this.finish('error', error instanceof Error ? error.message : undefined);
			throw error;
		} finally {
			this.sending = false;
		}
	}

	async stop(): Promise<void> {
		if (this.state !== 'working') { return; }
		this.setState('stopping');
		for (const id of this.requests.keys()) { this.answer(id, { kind: 'cancel' }); }
		try {
			await this.call('abort');
		} catch (error) {
			this.restoreWorkingAfterInterruptError();
			throw error;
		}
	}

	private restoreWorkingAfterInterruptError(): void {
		if (this.state === 'stopping') { this.setState('working'); }
	}

	answer(id: string, answer: AndenAnswer): void {
		const pending = this.requests.get(id);
		if (!pending) { return; }
		const { request } = pending;
		if (answer.kind === 'value') {
			if (request.kind !== 'input' || answer.value.length > 65536 || (request.options?.length && !request.options.includes(answer.value))) {
				throw new Error(localize('invalidAnswer', 'Enter a valid answer before submitting.'));
			}
		} else if (answer.kind === 'allow' && request.kind === 'input') {
			throw new Error(localize('invalidApproval', 'This request needs an answer, not a confirmation.'));
		}
		this.write(pending.reply(answer));
		this.resolve(id);
	}

	receive(value: unknown): void {
		const data = record(value);
		if (data.type === 'response') {
			const id = typeof data.id === 'string' ? Number(data.id) : data.id;
			const callback = typeof id === 'number' ? this.callbacks.get(id) : undefined;
			if (callback && typeof id === 'number') {
				clearTimeout(callback.timer);
				this.callbacks.delete(id);
				if (data.success === false || data.error) {
					callback.reject(new Error(bounded(text(data.error) || localize('rejectedRequest', 'Pi rejected the request.'))));
				} else {
					callback.resolve(data.data);
				}
			}
			return;
		}
		this.receiveEvent(data);
	}

	disconnect(message: string): void {
		this.finish('disconnected', message);
		for (const callback of this.callbacks.values()) {
			clearTimeout(callback.timer);
			callback.reject(new Error(message));
		}
		this.callbacks.clear();
	}

	private call(method: string, params: Wire = {}): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			const onTimeout = () => {
				const pending = this.callbacks.get(id);
				if (!pending) { return; }
				// Pi extension commands can await human input before acknowledging the prompt.
				if (method === 'prompt' && this.requests.size) {
					pending.timer = setTimeout(onTimeout, 30000);
					return;
				}
				this.callbacks.delete(id);
				reject(new Error(localize('agentTimeout', 'Pi did not respond to {0}.', method)));
			};
			const timer = setTimeout(onTimeout, 30000);
			this.callbacks.set(id, { resolve, reject, timer });
			try {
				this.write({ type: method, id: String(id), ...params });
			} catch (error) {
				clearTimeout(timer);
				this.callbacks.delete(id);
				reject(error);
			}
		});
	}

	private setState(state: AndenAgentState, activity?: AndenActivity, error?: string): void {
		if (this.state === 'disconnected' || (this.state === state && this.activity === activity && !error)) { return; }
		this.state = state;
		this.activity = activity;
		this.emit({ kind: 'state', state, activity, error: error && bounded(error) });
	}

	private work(activity?: AndenActivity): void {
		if (this.state !== 'stopping' && this.state !== 'starting') { this.setState('working', activity); }
	}

	private finish(state: AndenAgentState, error?: string): void {
		for (const id of this.requests.keys()) { this.resolve(id); }
		for (const tool of this.tools.values()) {
			this.emit({ kind: 'tool', tool: { ...tool, status: 'interrupted' } });
		}
		this.tools.clear();
		this.setState(state, undefined, error);
	}

	private resolve(id: string): void {
		if (this.requests.delete(id)) { this.emit({ kind: 'resolved', id }); }
	}

	private addRequest(request: AndenRequest, reply: PendingRequest['reply']): void {
		if (!this.requests.has(request.id)) {
			this.requests.set(request.id, { request, reply });
			this.emit({ kind: 'request', request });
		}
	}

	private updateTool(tool: AndenTool): void {
		if (tool.status === 'running') {
			this.tools.set(tool.id, tool);
			this.work('tools');
		} else {
			this.tools.delete(tool.id);
		}
		this.emit({ kind: 'tool', tool });
	}

	private receiveEvent(data: Wire): void {
		const message = record(data.message);
		switch (data.type) {
			case 'agent_start': this.runActive = true; this.failure = ''; this.work(); break;
			case 'turn_start': this.work('model'); break;
			case 'auto_retry_start': this.work('retry'); break;
			case 'auto_compaction_start': this.work('compaction'); break;
			case 'agent_settled':
				this.runActive = false;
				this.finish(data.aborted ? 'interrupted' : this.failure ? 'error' : 'ready', this.failure);
				break;
			case 'message_start':
				if (message.role === 'assistant') { this.messageId = `pi-${++this.sequence}`; }
				break;
			case 'message_update': {
				const delta = record(data.assistantMessageEvent);
				if (delta.type === 'text_delta' && this.messageId) {
					this.emit({ kind: 'text', id: this.messageId, text: text(delta.delta), append: true });
				}
				break;
			}
			case 'message_end':
				if (message.role === 'assistant') {
					this.failure = message.stopReason === 'error' ? text(message.errorMessage) || localize('piFailed', 'Pi reported a model error.') : '';
					const content = array(message.content).map(record).filter(part => part.type === 'text').map(part => text(part.text)).join('\n\n');
					if (this.messageId && (content || message.stopReason !== 'aborted')) {
						this.emit({ kind: 'text', id: this.messageId, text: content, append: false });
					}
				}
				break;
			case 'tool_execution_start':
			case 'tool_execution_update':
			case 'tool_execution_end': {
				const id = text(data.toolCallId);
				if (!id) { break; }
				const name = bounded(text(data.toolName), 128);
				const args = record(data.args);
				const path = text(args.path);
				const target = path || text(args.command) || text(args.pattern);
				const old = this.tools.get(id);
				const output = array(record(data.result ?? data.partialResult).content).map(record).filter(part => part.type === 'text').map(part => text(part.text)).join('\n');
				this.updateTool({ id, name, kind: classify(name, text(args.command)), path: path || old?.path, target: bounded(target) || old?.target, status: data.type !== 'tool_execution_end' ? 'running' : data.isError ? 'failed' : 'completed', output: bounded(output, maxOutput) || old?.output });
				break;
			}
			case 'extension_ui_request': this.receiveRequest(data); break;
		}
	}

	private receiveRequest(data: Wire): void {
		if (typeof data.id !== 'string' && typeof data.id !== 'number') { return; }
		const id = `${typeof data.id}:${data.id}`;
		const method = text(data.method);
		const title = bounded(text(data.title));
		if (method === 'confirm') {
			this.addRequest({ id, kind: 'confirm', title, detail: bounded(text(data.message)) }, answer => ({ type: 'extension_ui_response', id: data.id, ...(answer.kind === 'cancel' ? { cancelled: true } : { confirmed: answer.kind === 'allow' }) }));
		} else if (method === 'select' || method === 'input' || method === 'editor') {
			const options = array(data.options).filter((option): option is string => typeof option === 'string');
			this.addRequest({ id, kind: 'input', title, options, value: text(data.prefill ?? data.placeholder) || undefined }, answer => ({ type: 'extension_ui_response', id: data.id, ...(answer.kind === 'value' ? { value: answer.value } : { cancelled: true }) }));
		} else if (method === 'notify' && text(data.message)) {
			this.emit({ kind: 'notice', text: bounded(text(data.message)) });
		}
	}
}

function classify(name: string, command: string): AndenToolKind {
	switch (name) {
		case 'read': return 'read';
		case 'write': case 'edit': case 'apply_patch': return 'edit';
		case 'grep': case 'find': case 'ls': return 'search';
		case 'bash': case 'shell': case 'powershell': return /^(?:pnpm|npm|yarn|bun|cargo|go)\s+test\b|^pytest\b/.test(command.trim()) ? 'test' : 'command';
		default: return 'other';
	}
}
