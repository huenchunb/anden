/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ITerminalFontOverride } from '../../../../platform/terminal/common/terminal.js';

export const andenCodeFont = {
	fontFamily: 'Agave Nerd Font Mono',
	fontSize: 14,
	fontWeight: 500,
	fontWeightBold: 700,
} satisfies ITerminalFontOverride;

const loads = new WeakMap<Document, Promise<unknown>>();

export async function loadAndenCodeFont(document: Document): Promise<void> {
	let load = loads.get(document);
	if (!load) {
		const { fontFamily, fontSize, fontWeight, fontWeightBold } = andenCodeFont;
		// Measure only after the local faces load. A missing face can use the monospace fallback.
		load = Promise.allSettled([fontWeight, fontWeightBold].map(weight => document.fonts.load(`${weight} ${fontSize}px "${fontFamily}"`)));
		loads.set(document, load);
	}
	await load;
}
