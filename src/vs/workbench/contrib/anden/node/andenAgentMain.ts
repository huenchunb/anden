/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server } from '../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { andenAgentChannel } from '../common/andenAgent.js';
import { AndenAgentProcess } from './andenAgentProcess.js';

if (!isUtilityProcess(process)) {
	throw new Error('andenAgentMain must run in a utility process');
}

const disposables = new DisposableStore();
const service = disposables.add(new AndenAgentProcess());
const server = disposables.add(new Server({
	handledClientConnection(event) {
		event.ports[0]?.on('close', () => disposables.dispose());
		return false;
	}
}));
server.registerChannel(andenAgentChannel, ProxyChannel.fromService(service, disposables));
process.once('SIGTERM', () => {
	disposables.dispose();
	setTimeout(() => process.exit(0), 1000);
});
