/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Incremental JSONL framing. The caller must decode bytes with a streaming UTF-8 decoder. */
export class AndenJsonLines {
	private pending = '';

	constructor(private readonly maximum = 8 * 1024 * 1024) { }

	accept(chunk: string, receive: (value: unknown) => void): void {
		let start = 0;
		for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
			this.append(chunk.slice(start, end));
			const line = this.pending;
			this.pending = '';
			if (line.trim()) { receive(JSON.parse(line)); }
			start = end + 1;
		}
		this.append(chunk.slice(start));
	}

	private append(chunk: string): void {
		if (this.pending.length + chunk.length > this.maximum) {
			throw new Error('Anden agent record exceeded the framing limit');
		}
		this.pending += chunk;
	}
}
