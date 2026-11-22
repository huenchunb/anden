/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AndenActivity, AndenAgentKind, AndenAgentState, AndenAgentUpdate, AndenAnswer, AndenRequest, AndenTool, AndenToolKind } from './andenAgent.js';

type Wire = Record<string, unknown>;
const record = (value: unknown): Wire => value && typeof value === 'object' && !Array.isArray(value) ? value as Wire : {};
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const bounded = (value: string, max = 8192): string => value.length > max ? `${value.slice(0, max)}…` : value;
const requestId = (value: unknown): value is number | string => typeof value === 'number' || typeof value === 'string';
const requestKey = (value: number | string): string => `${typeof value}:${value}`;
const maxOutput = 32768;

interface PendingRequest {
	readonly request: AndenRequest;
	readonly reply: (answer: AndenAnswer) => Wire;
}

export class AndenAgentProtocol {
	private sequence = 0;
	private state: AndenAgentState = 'starting';
	private activity: AndenActivity | undefined;
	private threadId = '';
	private turnId = '';
	private piMessageId = '';
	private piFailure = '';
	private piRunActive = false;
	private interruptedTurn = '';
	private readonly tools = new Map<string, AndenTool>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly callbacks = new Map<number, { timer: ReturnType<typeof setTimeout>; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();

	constructor(private readonly agent: AndenAgentKind, private readonly cwd: string, private readonly write: (value: Wire) => void, private readonly emit: (update: AndenAgentUpdate) => void) { }

	async start(): Promise<void> {
		if (this.agent === 'pi') {
			const data = record(await this.call('get_state'));
			if (typeof data.isStreaming !== 'boolean') {
				throw new Error(localize('piProtocol', 'The installed Pi does not provide a compatible RPC state.'));
			}
		} else {
			await this.call('initialize', { clientInfo: { name: 'anden', title: 'Anden', version: '1.0.0' } });
			this.write({ method: 'initialized' });
			const data = record(await this.call('thread/start', { cwd: this.cwd, ephemeral: true }));
			this.threadId = text(record(data.thread).id);
			if (!this.threadId) {
				throw new Error(localize('codexProtocol', 'The installed Codex did not return a compatible conversation.'));
			}
		}
		this.setState('ready');
	}

	async send(message: string): Promise<void> {
		if (!['ready', 'interrupted', 'error'].includes(this.state) || this.requests.size) {
			throw new Error(localize('agentBusy', 'The session is not ready to receive a new message.'));
		}
		this.piFailure = '';
		this.turnId = '';
		this.interruptedTurn = '';
		this.piMessageId = '';
		this.setState('working');
		const id = `user-${++this.sequence}`;
		this.emit({ kind: 'user', id, text: message });
		try {
			if (this.agent === 'pi') {
				const response = record(await this.call('prompt', { message }));
				if (response.disposition === 'handled' && !this.piRunActive && (this.state === 'working' || this.state === 'stopping')) {
					this.finish(this.state === 'stopping' ? 'interrupted' : 'ready');
				}
			} else {
				const result = record(await this.call('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: message, text_elements: [] }] }));
				const turn = text(record(result.turn).id);
				if (this.state === 'working' || this.state === 'stopping') {
					this.turnId ||= turn;
					if (this.state === 'stopping' && turn) {
						await this.interruptCodex(turn);
					}
				}
			}
		} catch (error) {
			this.finish('error', error instanceof Error ? error.message : undefined);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.state !== 'working') {
			return;
		}
		this.setState('stopping');
		for (const id of this.requests.keys()) {
			this.answer(id, { kind: 'cancel' });
		}
		if (this.agent === 'pi') {
			try {
				await this.call('abort');
			} catch (error) {
				this.restoreWorkingAfterInterruptError();
				throw error;
			}
		} else if (this.turnId) {
			await this.interruptCodex(this.turnId);
		}
	}

	private restoreWorkingAfterInterruptError(): void {
		if (this.state === 'stopping') { this.setState('working'); }
	}

	private async interruptCodex(turnId: string): Promise<void> {
		if (this.interruptedTurn === turnId) { return; }
		this.interruptedTurn = turnId;
		try {
			await this.call('turn/interrupt', { threadId: this.threadId, turnId });
		} catch (error) {
			this.interruptedTurn = '';
			if (this.state === 'stopping') { this.setState('working'); }
			throw error;
		}
	}

	answer(id: string, answer: AndenAnswer): void {
		const pending = this.requests.get(id);
		if (!pending) {
			return;
		}
		const { request } = pending;
		if (answer.kind === 'answers') {
			if (request.kind !== 'questions' || !request.questions?.every(question => {
				const value = answer.values.find(entry => entry.id === question.id)?.value;
				return value !== undefined && value.length <= 65536 && (!question.options?.length || question.other || question.options.some(option => option.label === value));
			})) {
				throw new Error(localize('invalidAnswer', 'Answer all the questions before submitting.'));
			}
		} else if (answer.kind === 'allow' && request.kind === 'questions') {
			throw new Error(localize('invalidApproval', 'This request needs an answer, not an approval.'));
		}
		this.write(pending.reply(answer));
		this.resolve(id);
	}

	receive(value: unknown): void {
		const data = record(value);
		const id = typeof data.id === 'string' && this.agent === 'pi' ? Number(data.id) : data.id;
		const response = this.agent === 'pi' ? data.type === 'response' : !data.method && (Object.hasOwn(data, 'result') || Object.hasOwn(data, 'error'));
		if (response && typeof id === 'number') {
			const callback = this.callbacks.get(id);
			if (callback) {
				clearTimeout(callback.timer);
				this.callbacks.delete(id);
				if (data.success === false || data.error) {
					callback.reject(new Error(bounded(text(data.error) || text(record(data.error).message) || localize('rejectedRequest', 'The agent rejected the request.'))));
				} else {
					callback.resolve(this.agent === 'pi' ? data.data : data.result);
				}
			}
			return;
		}
		if (this.agent === 'pi') {
			this.receivePi(data);
		} else {
			this.receiveCodex(data);
		}
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
				if (this.agent === 'pi' && method === 'prompt' && this.requests.size) {
					pending.timer = setTimeout(onTimeout, 30000);
					return;
				}
				this.callbacks.delete(id);
				reject(new Error(localize('agentTimeout', 'The agent did not respond to {0}.', method)));
			};
			const timer = setTimeout(onTimeout, 30000);
			this.callbacks.set(id, { resolve, reject, timer });
			try {
				this.write(this.agent === 'pi' ? { type: method, id: String(id), ...params } : { method, id, params });
			} catch (error) {
				clearTimeout(timer);
				this.callbacks.delete(id);
				reject(error);
			}
		});
	}

	private setState(state: AndenAgentState, activity?: AndenActivity, error?: string): void {
		if (this.state === 'disconnected' || (this.state === state && this.activity === activity && !error)) {
			return;
		}
		this.state = state;
		this.activity = activity;
		this.emit({ kind: 'state', state, activity, error: error && bounded(error) });
	}

	private work(activity?: AndenActivity): void {
		if (this.state !== 'stopping' && this.state !== 'starting') {
			this.setState('working', activity);
		}
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

	private receivePi(data: Wire): void {
		const message = record(data.message);
		switch (data.type) {
			case 'agent_start': this.piRunActive = true; this.piFailure = ''; this.work(); break;
			case 'turn_start': this.work('model'); break;
			case 'auto_retry_start': this.work('retry'); break;
			case 'auto_compaction_start': this.work('compaction'); break;
			case 'agent_settled':
				this.piRunActive = false;
				this.finish(data.aborted ? 'interrupted' : this.piFailure ? 'error' : 'ready', this.piFailure);
				break;
			case 'message_start':
				if (message.role === 'assistant') { this.piMessageId = `pi-${++this.sequence}`; }
				break;
			case 'message_update': {
				const delta = record(data.assistantMessageEvent);
				if (delta.type === 'text_delta' && this.piMessageId) {
					this.emit({ kind: 'text', id: this.piMessageId, text: text(delta.delta), append: true });
				}
				break;
			}
			case 'message_end':
				if (message.role === 'assistant') {
					this.piFailure = message.stopReason === 'error' ? text(message.errorMessage) || localize('piFailed', 'Pi reported a model error.') : '';
					const content = array(message.content).map(record).filter(part => part.type === 'text').map(part => text(part.text)).join('\n\n');
					if (this.piMessageId && (content || message.stopReason !== 'aborted')) {
						this.emit({ kind: 'text', id: this.piMessageId, text: content, append: false });
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
			case 'extension_ui_request': this.piRequest(data); break;
		}
	}

	private piRequest(data: Wire): void {
		if (!requestId(data.id)) { return; }
		const id = requestKey(data.id);
		const method = text(data.method);
		const title = bounded(text(data.title));
		if (method === 'confirm') {
			this.addRequest({ id, kind: 'confirm', title, detail: bounded(text(data.message)) }, answer => ({ type: 'extension_ui_response', id: data.id, ...(answer.kind === 'cancel' ? { cancelled: true } : { confirmed: answer.kind === 'allow' }) }));
		} else if (method === 'select' || method === 'input' || method === 'editor') {
			const question = { id: 'value', label: title, options: array(data.options).filter((option): option is string => typeof option === 'string').map(option => ({ label: option })), value: text(data.prefill ?? data.placeholder) || undefined };
			this.addRequest({ id, kind: 'questions', questions: [question] }, answer => ({ type: 'extension_ui_response', id: data.id, ...(answer.kind === 'answers' ? { value: answer.values.find(entry => entry.id === 'value')?.value } : { cancelled: true }) }));
		} else if (method === 'notify' && text(data.message)) {
			this.emit({ kind: 'notice', text: bounded(text(data.message)) });
		}
	}

	private receiveCodex(data: Wire): void {
		const params = record(data.params);
		if (requestId(data.id) && typeof data.method === 'string') {
			this.codexRequest(data.id, data.method, params);
			return;
		}
		if (params.threadId !== this.threadId || !this.threadId) { return; }
		const turn = record(params.turn);
		switch (data.method) {
			case 'turn/started': this.turnId = text(turn.id); this.work(); break;
			case 'turn/completed':
				this.turnId = '';
				this.finish(turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'error' : 'ready', text(record(turn.error).message));
				break;
			case 'thread/status/changed':
				if (record(params.status).type === 'active') { this.work(this.activity); }
				break;
			case 'item/agentMessage/delta':
				this.emit({ kind: 'text', id: text(params.itemId), text: text(params.delta), append: true });
				break;
			case 'item/started':
			case 'item/completed': this.codexItem(record(params.item), data.method === 'item/completed'); break;
			case 'item/commandExecution/outputDelta': {
				const tool = this.tools.get(text(params.itemId));
				if (tool && (tool.output?.length ?? 0) < maxOutput) {
					this.updateTool({ ...tool, output: bounded((tool.output ?? '') + text(params.delta), maxOutput) });
				}
				break;
			}
			case 'serverRequest/resolved': if (requestId(params.requestId)) { this.resolve(requestKey(params.requestId)); } break;
		}
	}

	private codexItem(item: Wire, complete: boolean): void {
		const id = text(item.id);
		const type = text(item.type);
		if (!id) { return; }
		if (type === 'agentMessage') {
			if (complete && text(item.text)) { this.emit({ kind: 'text', id, text: text(item.text), append: false }); }
			return;
		}
		if (type === 'contextCompaction') { if (!complete) { this.work('compaction'); } return; }
		if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall'].includes(type)) { return; }
		const paths = array(item.changes).map(change => text(record(change).path)).filter(Boolean);
		const command = text(item.command);
		const name = bounded(text(item.tool), 128) || type;
		const kind = type === 'commandExecution' ? classify('shell', command) : type === 'fileChange' ? 'edit' : type === 'webSearch' ? 'search' : 'other';
		const status = !complete ? 'running' : item.status === 'declined' || item.status === 'interrupted' ? 'interrupted' : item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'failed' : 'completed';
		this.updateTool({ id, name, kind, target: bounded(command || paths.join(', ') || text(item.query)), path: paths.length === 1 ? paths[0] : undefined, status, output: bounded(text(item.aggregatedOutput) || this.tools.get(id)?.output || '', maxOutput) });
	}

	private codexRequest(wireId: number | string, method: string, params: Wire): void {
		const id = requestKey(wireId);
		const reply = (result: Wire): Wire => ({ id: wireId, result });
		if ((this.threadId && params.threadId !== this.threadId) || (!this.threadId && this.state !== 'starting')) {
			this.write({ id: wireId, error: { code: -32602, message: 'Request does not belong to the active Anden thread' } });
			return;
		}
		const reason = text(params.reason);
		switch (method) {
			case 'item/commandExecution/requestApproval':
			case 'item/fileChange/requestApproval': {
				const kind = method.includes('commandExecution') ? 'command' : 'files';
				const network = record(params.networkApprovalContext);
				const tool = this.tools.get(text(params.itemId));
				const target = text(params.command) || text(network.host) || text(params.grantRoot) || tool?.target;
				const detail = [target, text(params.cwd), network.host && network.host !== target ? text(network.host) : '', text(network.protocol), reason].filter(Boolean).join('\n');
				if (!target || detail.length > 8192 || target.endsWith('…')) {
					this.emit({ kind: 'notice', text: localize('approvalScopeMissing', 'An approval was declined because Anden could not display its full scope.') });
					this.write(reply({ decision: 'decline' }));
					break;
				}
				this.addRequest({ id, kind, detail }, answer => reply({ decision: answer.kind === 'allow' ? 'accept' : answer.kind === 'cancel' ? 'cancel' : 'decline' }));
				break;
			}
			case 'item/permissions/requestApproval': {
				const permissions = record(params.permissions);
				const detail = [text(params.cwd), reason, JSON.stringify(permissions, null, 2)].filter(Boolean).join('\n');
				if (detail.length > 8192) {
					this.emit({ kind: 'notice', text: localize('approvalScopeMissing', 'An approval was declined because Anden could not display its full scope.') });
					this.write(reply({ permissions: {}, scope: 'turn' }));
					break;
				}
				this.addRequest({ id, kind: 'permissions', detail }, answer => reply({ permissions: answer.kind === 'allow' ? permissions : {}, scope: 'turn' }));
				break;
			}
			case 'item/tool/requestUserInput': {
				const questions = array(params.questions).map(record).map(q => ({ id: text(q.id), label: bounded(text(q.question)), other: q.isOther === true, secret: q.isSecret === true, options: array(q.options).map(record).map(option => ({ label: text(option.label), description: bounded(text(option.description)) })) })).filter(q => q.id);
				if (!questions.length) { this.write(reply({ answers: {} })); break; }
				this.addRequest({ id, kind: 'questions', questions }, answer => reply({ answers: answer.kind === 'answers' ? Object.fromEntries(answer.values.filter(value => questions.some(question => question.id === value.id)).map(value => [value.id, { answers: [value.value] }])) : {} }));
				break;
			}
			case 'mcpServer/elicitation/request':
				this.emit({ kind: 'notice', text: localize('unsupportedMcp', 'An MCP input form is not supported in Anden and was cancelled.') });
				this.write(reply({ action: 'cancel', content: null }));
				break;
			default:
				this.emit({ kind: 'notice', text: localize('unsupportedRequest', 'Anden does not support the agent request {0}.', bounded(method, 128)) });
				this.write({ id: wireId, error: { code: -32601, message: 'Request is not supported by Anden' } });
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
