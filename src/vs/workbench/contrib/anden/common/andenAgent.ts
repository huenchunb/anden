/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';

export const andenAgentChannel = 'andenAgent';
export type AndenAgentKind = 'pi' | 'codex';
export type AndenAgentState = 'starting' | 'ready' | 'working' | 'stopping' | 'interrupted' | 'error' | 'disconnected';
export type AndenActivity = 'model' | 'tools' | 'retry' | 'compaction';
export type AndenToolKind = 'read' | 'edit' | 'search' | 'command' | 'test' | 'other';

export interface AndenLaunchOptions {
	readonly sessionId: string;
	readonly agent: AndenAgentKind;
	readonly executable: string;
	readonly cwd: string;
	readonly env: IProcessEnvironment;
}

export interface AndenQuestion {
	readonly id: string;
	readonly label: string;
	readonly value?: string;
	readonly options?: readonly { readonly label: string; readonly description?: string }[];
	readonly other?: boolean;
	readonly secret?: boolean;
}

export interface AndenRequest {
	readonly id: string;
	readonly kind: 'command' | 'files' | 'permissions' | 'confirm' | 'questions';
	readonly title?: string;
	readonly detail?: string;
	readonly questions?: readonly AndenQuestion[];
}

export type AndenAnswer = { readonly kind: 'allow' | 'decline' | 'cancel' } | { readonly kind: 'answers'; readonly values: readonly { readonly id: string; readonly value: string }[] };

export interface AndenTool {
	readonly id: string;
	readonly name: string;
	readonly kind: AndenToolKind;
	readonly target?: string;
	readonly path?: string;
	readonly status: 'running' | 'completed' | 'failed' | 'interrupted';
	readonly output?: string;
}

export type AndenAgentUpdate =
	| { readonly kind: 'state'; readonly state: AndenAgentState; readonly activity?: AndenActivity; readonly error?: string }
	| { readonly kind: 'user'; readonly id: string; readonly text: string }
	| { readonly kind: 'text'; readonly id: string; readonly text: string; readonly append: boolean }
	| { readonly kind: 'tool'; readonly tool: AndenTool }
	| { readonly kind: 'request'; readonly request: AndenRequest }
	| { readonly kind: 'resolved'; readonly id: string }
	| { readonly kind: 'notice'; readonly text: string };

export interface IAndenAgentProcess {
	readonly onDidUpdate: Event<{ readonly sessionId: string; readonly update: AndenAgentUpdate }>;
	start(options: AndenLaunchOptions): Promise<void>;
	send(sessionId: string, text: string): Promise<void>;
	stop(sessionId: string): Promise<void>;
	answer(sessionId: string, requestId: string, answer: AndenAnswer): Promise<void>;
	close(sessionId: string): Promise<void>;
}
