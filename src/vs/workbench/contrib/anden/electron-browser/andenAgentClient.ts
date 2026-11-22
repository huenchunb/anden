/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { andenAgentChannel, AndenAgentUpdate, AndenAnswer, AndenLaunchOptions, IAndenAgentProcess } from '../common/andenAgent.js';

export class AndenAgentClient extends Disposable {
	private connection: Promise<IAndenAgentProcess> | undefined;
	private readonly sessions = new Set<string>();
	private readonly closing = new Set<Promise<void>>();
	private readonly updates = this._register(new Emitter<{ sessionId: string; update: AndenAgentUpdate }>());
	readonly onDidUpdate = this.updates.event;

	constructor(@IUtilityProcessWorkerWorkbenchService private readonly workers: IUtilityProcessWorkerWorkbenchService) { super(); }

	private async connect(): Promise<IAndenAgentProcess> {
		const worker = await this.workers.createWorker({ moduleId: 'vs/workbench/contrib/anden/node/andenAgentMain', type: 'andenAgent', name: 'Anden Agents' });
		if (this._store.isDisposed) { worker.dispose(); throw new CancellationError(); }
		this._register(worker);
		const proxy = ProxyChannel.toService<IAndenAgentProcess>(worker.client.getChannel(andenAgentChannel), { disableMarshalling: true });
		const listener = this._register(proxy.onDidUpdate(event => {
			if (this.sessions.has(event.sessionId)) { this.updates.fire(event); }
		}));
		void worker.onDidTerminate.then(() => {
			this._store.delete(listener);
			this._store.delete(worker);
			this.connection = undefined;
			for (const sessionId of this.sessions) {
				this.updates.fire({ sessionId, update: { kind: 'state', state: 'disconnected', error: localize('workerTerminated', 'The local agent service disconnected.') } });
			}
			this.sessions.clear();
		});
		return proxy;
	}

	async start(options: AndenLaunchOptions): Promise<void> {
		this.sessions.add(options.sessionId);
		try {
			const connection = this.connection ??= this.connect().catch(error => { this.connection = undefined; throw error; });
			const proxy = await connection;
			if (this.sessions.has(options.sessionId)) { await proxy.start(options); }
		} catch (error) {
			if (this.sessions.delete(options.sessionId)) {
				this.updates.fire({ sessionId: options.sessionId, update: { kind: 'state', state: 'disconnected', error: error instanceof Error ? error.message : localize('launchFailed', 'Could not start the agent.') } });
			}
		}
	}

	private async requireConnection(id: string): Promise<IAndenAgentProcess> {
		const proxy = await this.connection;
		if (!proxy || !this.sessions.has(id)) { throw new Error(localize('noAgentConnection', 'The agent is no longer connected.')); }
		return proxy;
	}

	async send(id: string, text: string): Promise<void> { await (await this.requireConnection(id)).send(id, text); }
	async stop(id: string): Promise<void> { await (await this.requireConnection(id)).stop(id); }
	async answer(id: string, request: string, answer: AndenAnswer): Promise<void> { await (await this.requireConnection(id)).answer(id, request, answer); }
	async close(id: string): Promise<void> {
		if (!this.sessions.delete(id)) { return; }
		const closing = this.connection?.then(proxy => proxy.close(id));
		if (!closing) { return; }
		this.closing.add(closing);
		try { await closing; } finally { this.closing.delete(closing); }
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.closing, ...[...this.sessions].map(id => this.close(id))]);
	}
}
