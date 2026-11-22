/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface IAndenRepositoryObservation extends IDisposable {
	readonly whenWatching: Promise<unknown>;
}

export interface IAndenRepositorySummary {
	readonly branch?: string;
	readonly commit?: string;
	readonly lines?: { readonly added: number; readonly deleted: number };
}

/** Routes Git extension updates back to the session that leased the repository. */
export class AndenRepositoryContext extends Disposable {
	private readonly listeners = new Map<string, (summary: IAndenRepositorySummary | undefined) => void>();

	constructor(
		@ICommandService private readonly commands: ICommandService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand('_anden.repositoryChanged', (_accessor, sessionId: string, summary: IAndenRepositorySummary | null) => {
			this.listeners.get(sessionId)?.(summary ?? undefined);
		}));
	}

	watch(sessionId: string, folder: URI, listener: (summary: IAndenRepositorySummary | undefined) => void): IAndenRepositoryObservation {
		this.listeners.set(sessionId, listener);
		const watching = this.commands.executeCommand('_git.anden.watchRepository', sessionId, folder).catch(error => {
			this.log.debug('Anden: could not observe the session repository', error);
		});
		const disposable = toDisposable(() => {
			this.listeners.delete(sessionId);
			void watching.then(() => this.commands.executeCommand('_git.anden.unwatchRepository', sessionId)).catch(error => {
				this.log.debug('Anden: could not release the session repository', error);
			});
		});
		return { whenWatching: watching, dispose: () => disposable.dispose() };
	}
}
