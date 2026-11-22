/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import './media/andenIcons.css';

export type AndenIcon = 'agent-pi' | 'agent-codex' | 'git' | 'branch' | 'sessions' | 'chat' | 'folder'
	| 'status-ready' | 'status-working' | 'status-waiting' | 'status-interrupted' | 'status-error' | 'status-disconnected' | 'status-completed'
	| 'new' | 'more' | 'rename' | 'close' | 'back' | 'expand' | 'send' | 'stop' | 'latest' | 'copy' | 'refresh'
	| 'read' | 'edit' | 'search' | 'command' | 'test' | 'tool' | 'shield' | 'question'
	| 'diff' | 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict';

export function andenIcon(icon: AndenIcon): HTMLElement {
	return $(`span.anden-icon.anden-icon-${icon}`, { 'aria-hidden': 'true' });
}

export function andenButton(label: string, icon: AndenIcon, iconOnly = false): HTMLButtonElement {
	const button = $<HTMLButtonElement>('button.anden-icon-button', { type: 'button', 'aria-label': label, title: label });
	append(button, andenIcon(icon));
	if (!iconOnly) { append(button, $('span', {}, label)); }
	return button;
}
