/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { AndenPiSession } from '../../../../platform/anden/common/andenHistory.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';

export const andenAgentChannel = 'andenAgent';
export type AndenAgentState = 'starting' | 'ready' | 'working' | 'stopping' | 'interrupted' | 'error' | 'disconnected';
export type AndenActivity = 'model' | 'tools' | 'retry' | 'compaction';
export type AndenToolKind = 'read' | 'edit' | 'search' | 'command' | 'test' | 'other';

export interface AndenLaunchOptions {
	readonly sessionId: string;
	readonly executable: string;
	readonly cwd: string;
	readonly env: IProcessEnvironment;
	readonly piResume?: AndenPiSession;
}

export type AndenRequest = { readonly id: string; readonly title: string } & (
	{ readonly kind: 'confirm'; readonly detail: string }
	| { readonly kind: 'input'; readonly options: readonly string[]; readonly value?: string }
);

export type AndenAnswer = { readonly kind: 'allow' | 'decline' | 'cancel' } | { readonly kind: 'value'; readonly value: string };

export interface AndenTool {
	readonly id: string;
	readonly name: string;
	readonly kind: AndenToolKind;
	readonly target?: string;
	readonly path?: string;
	readonly status: 'running' | 'completed' | 'failed' | 'interrupted';
	readonly output?: string;
}

export interface AndenModelRef {
	readonly id: string;
	readonly provider?: string;
}

export interface AndenModel extends AndenModelRef {
	readonly label: string;
}

export interface AndenReasoningOption {
	readonly id: string;
}

export interface AndenModelSettings {
	readonly model?: AndenModel;
	readonly reasoning?: string;
}

export interface AndenPiCommand {
	readonly name: string;
	readonly description: string;
	readonly source: 'extension' | 'prompt' | 'skill';
	readonly scope?: 'user' | 'project' | 'temporary';
	readonly supported: boolean;
}

export interface AndenSessionStats {
	readonly tokens?: number;
	readonly contextPercent?: number;
	readonly cost?: number;
}

export type AndenAgentUpdate =
	| { readonly kind: 'state'; readonly state: AndenAgentState; readonly activity?: AndenActivity; readonly error?: string }
	| { readonly kind: 'piSession'; readonly session: AndenPiSession }
	| { readonly kind: 'modelSettings'; readonly settings: AndenModelSettings }
	| { readonly kind: 'user'; readonly id: string; readonly text: string }
	| { readonly kind: 'userAccepted'; readonly id: string }
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
	listCommands(sessionId: string): Promise<readonly AndenPiCommand[]>;
	invokeCommand(sessionId: string, name: string, args: string): Promise<void>;
	setSessionName(sessionId: string, name: string): Promise<void>;
	getLastAssistantText(sessionId: string): Promise<string>;
	getSessionStats(sessionId: string): Promise<AndenSessionStats>;
	listModels(sessionId: string): Promise<readonly AndenModel[]>;
	selectModel(sessionId: string, model: AndenModelRef): Promise<void>;
	listReasoning(sessionId: string): Promise<readonly AndenReasoningOption[]>;
	selectReasoning(sessionId: string, level: string): Promise<void>;
	answer(sessionId: string, requestId: string, answer: AndenAnswer): Promise<void>;
	close(sessionId: string): Promise<void>;
}
