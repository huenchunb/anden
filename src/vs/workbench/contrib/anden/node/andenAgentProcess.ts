/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { stat, access, realpath } from 'fs/promises';
import { constants } from 'fs';
import { DeferredPromise, raceTimeout, timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { removeDangerousEnvVariables, sanitizeProcessEnvironment } from '../../../../base/common/processes.js';
import { killTree } from '../../../../base/node/processes.js';
import { localize } from '../../../../nls.js';
import { AndenPiSession } from '../../../../platform/anden/common/andenHistory.js';
import { resolvePiSession } from '../../../../platform/anden/node/andenPiSession.js';
import { AndenAgentUpdate, AndenAnswer, AndenLaunchOptions, AndenModelRef, IAndenAgentProcess } from '../common/andenAgent.js';
import { AndenAgentProtocol } from '../common/andenAgentProtocol.js';
import { AndenJsonLines } from '../common/andenJsonLines.js';

interface RunningSession {
	readonly protocol: AndenAgentProtocol;
	close(): Promise<void>;
}

export class AndenAgentProcess extends Disposable implements IAndenAgentProcess {
	private readonly sessions = new Map<string, RunningSession>();
	private readonly launching = new Set<string>();
	private readonly updates = this._register(new Emitter<{ sessionId: string; update: AndenAgentUpdate }>());
	readonly onDidUpdate = this.updates.event;

	async start(options: AndenLaunchOptions): Promise<void> {
		const { executable, cwd, sessionId } = options;
		if (!isAbsolute(executable) || !isAbsolute(cwd) || this.sessions.has(sessionId) || this.launching.has(sessionId)) {
			throw new Error(localize('invalidLaunch', 'Invalid Anden session launch.'));
		}
		this.launching.add(sessionId);
		let launchCwd = cwd;
		let resume: AndenPiSession | undefined;
		try {
			if (!(await stat(executable)).isFile() || !(await stat(cwd)).isDirectory()) {
				throw new Error(localize('invalidLocation', 'The agent executable or working folder is unavailable.'));
			}
			await access(executable, constants.X_OK);
			launchCwd = await realpath(cwd);
			if (options.piResume) {
				resume = await resolvePiSession(options.piResume, launchCwd);
				if (!resume) { throw new Error(localize('piSavedFileChanged', 'The saved Pi session or its working folder is no longer available.')); }
			}
			if (!this.launching.has(sessionId) || this._store.isDisposed) { return; }
		} finally {
			this.launching.delete(sessionId);
		}
		const env = { ...process.env, ...options.env };
		sanitizeProcessEnvironment(env);
		removeDangerousEnvVariables(env);
		// Leave Pi's session directory and configuration to the CLI, just as from a terminal.
		const args = ['--mode', 'rpc', ...(resume ? ['--session', resume.sessionFile] : [])];
		const child = spawn(executable, args, {
			cwd: launchCwd, env, shell: false, windowsHide: true, detached: !isWindows, stdio: ['pipe', 'pipe', 'pipe'],
		});
		const lines = new AndenJsonLines();
		let closing: Promise<void> | undefined;
		let closed = false;
		let stderr = '';
		const exited = new DeferredPromise<void>();
		const protocol = new AndenAgentProtocol(launchCwd, message => {
			if (closed || !child.stdin.writable || child.stdin.writableLength > 1024 * 1024) {
				throw new Error(localize('cannotWrite', 'The agent connection cannot accept another message.'));
			}
			child.stdin.write(`${JSON.stringify(message)}\n`);
		}, update => this.updates.fire({ sessionId, update }), resume);
		const stopProcess = (force: boolean) => {
			if (!child.pid) { return Promise.resolve(); }
			if (isWindows) {
				return killTree(child.pid, true, () => { }).catch(() => { child.kill(); });
			}
			try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ }
			return Promise.resolve();
		};
		const close = () => closing ??= (async () => {
			closed = true;
			protocol.disconnect(localize('connectionClosed', 'The agent connection was closed.'));
			child.stdin.end();
			try {
				await raceTimeout(exited.p, 600);
				if (!isWindows || !exited.isSettled) { await stopProcess(false); }
				if (!isWindows && child.pid) {
					// Give the entire process group a chance to exit, including its tool subprocesses.
					await timeout(800);
					await stopProcess(true);
				}
			} finally {
				this.sessions.delete(sessionId);
			}
		})();
		const fail = (message: string) => {
			if (!closed) {
				protocol.disconnect(message);
				void close();
			}
		};
		this.sessions.set(sessionId, { protocol, close });
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (closed) { return; }
			try { lines.accept(chunk, value => { if (!closed) { protocol.receive(value); } }); }
			catch { fail(localize('invalidProtocol', 'The agent returned an invalid or oversized JSON response. Check the installed agent version.')); }
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
		child.stdin.on('error', () => fail(localize('agentPipeFailed', 'The connection to the agent was lost.')));
		child.on('error', () => fail(localize('agentSpawnFailed', 'Could not launch the agent. Check the executable and working folder.')));
		child.on('close', (code, signal) => {
			void exited.complete();
			// Older builds often identify the unsupported subcommand on stderr. Never surface arbitrary stderr, which may contain secrets.
			if (/unknown (?:option|argument|command)|unrecognized (?:option|argument|subcommand)/i.test(stderr)) {
				fail(localize('unsupportedVersion', 'The installed agent does not support the required chat protocol.'));
			} else {
				fail(localize('agentExited', 'The agent process exited ({0}).', code ?? signal ?? '?'));
			}
		});
		try { await protocol.start(); }
		catch (error) {
			fail(error instanceof Error ? error.message : localize('agentStartFailed', 'The agent did not start.'));
			await close();
			throw error;
		}
	}

	async send(sessionId: string, text: string): Promise<void> {
		if (!text.trim() || text.length > 65536) {
			throw new Error(localize('invalidPrompt', 'Enter a message between 1 and 65,536 characters.'));
		}
		await this.requireSession(sessionId).protocol.send(text);
	}
	async stop(sessionId: string): Promise<void> { await this.requireSession(sessionId).protocol.stop(); }
	async listModels(sessionId: string) { return this.requireSession(sessionId).protocol.listModels(); }
	async selectModel(sessionId: string, model: AndenModelRef): Promise<void> { await this.requireSession(sessionId).protocol.selectModel(model); }
	async listReasoning(sessionId: string) { return this.requireSession(sessionId).protocol.listReasoning(); }
	async selectReasoning(sessionId: string, level: string): Promise<void> { await this.requireSession(sessionId).protocol.selectReasoning(level); }
	async answer(sessionId: string, requestId: string, answer: AndenAnswer): Promise<void> { this.requireSession(sessionId).protocol.answer(requestId, answer); }
	async close(sessionId: string): Promise<void> {
		this.launching.delete(sessionId);
		await this.sessions.get(sessionId)?.close();
	}

	private requireSession(id: string): RunningSession {
		const session = this.sessions.get(id);
		if (!session) { throw new Error(localize('missingAgentConnection', 'The agent is no longer connected.')); }
		return session;
	}

	override dispose(): void {
		this.launching.clear();
		for (const entry of this.sessions.values()) { void entry.close(); }
		super.dispose();
	}
}
