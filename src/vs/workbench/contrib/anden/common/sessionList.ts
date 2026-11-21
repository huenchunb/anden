/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Tracks window-local sessions independently of their terminal processes and DOM surfaces. */
export class SessionList<T extends object> {
	private readonly entries = new Set<T>();
	private selected: T | undefined;

	get active(): T | undefined {
		return this.selected;
	}

	values(): IterableIterator<T> {
		return this.entries.values();
	}

	add(session: T): void {
		this.entries.add(session);
	}

	/** Ignore stale selections from a picker that was open when the session closed. */
	select(session: T | undefined): boolean {
		if (session && !this.entries.has(session)) {
			return false;
		}
		this.selected = session;
		return true;
	}

	/** Returns whether the active session changed. */
	remove(session: T): boolean {
		if (!this.entries.delete(session) || this.selected !== session) {
			return false;
		}
		this.selected = this.entries.values().next().value;
		return true;
	}

	clear(): void {
		this.entries.clear();
		this.selected = undefined;
	}
}
