/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AndenAgentKind, AndenAgentUpdate } from '../../common/andenAgent.js';
import { AndenAgentProtocol } from '../../common/andenAgentProtocol.js';
import { AndenJsonLines } from '../../common/andenJsonLines.js';

suite('Anden agent protocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function create(agent: AndenAgentKind) {
		const sent: Record<string, unknown>[] = [];
		const events: AndenAgentUpdate[] = [];
		const protocol = new AndenAgentProtocol(agent, '/example', value => sent.push(value), event => events.push(event));
		const receive = (value: unknown) => protocol.receive(value);
		const last = () => sent.at(-1);
		const reply = (result: unknown) => receive(agent === 'pi' ? { id: last()?.id, type: 'response', success: true, data: result } : { id: last()?.id, result });
		const start = async () => {
			const starting = protocol.start();
			if (agent === 'pi') { reply({ isStreaming: false }); }
			else {
				assert.strictEqual(last()?.method, 'initialize');
				reply({});
				await Promise.resolve();
				assert.deepStrictEqual(last()?.params, { cwd: '/example', ephemeral: true });
				reply({ thread: { id: 'thread' } });
			}
			await starting;
		};
		return { protocol, receive, reply, events, sent, last, start };
	}

	test('frames split, empty, and oversized JSONL records', () => {
		const data: unknown[] = [];
		const framer = new AndenJsonLines(16);
		framer.accept('{"x":', x => data.push(x));
		framer.accept('"años"}\r\n\n[]\n  ', x => data.push(x));
		assert.deepStrictEqual(data, [{ x: 'años' }, []]);
		assert.throws(() => framer.accept(' '.repeat(16), () => { }), /framing limit/);
	});

	test('keeps Pi busy until settled, records tool results and reconciles final text', async () => {
		const p = create('pi');
		await p.start();
		const sending = p.protocol.send('hello');
		p.reply({});
		await sending;
		p.receive({ type: 'message_start', message: { role: 'assistant' } });
		p.receive({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hel' } });
		p.receive({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private' } });
		p.receive({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
		p.receive({ type: 'tool_execution_start', toolCallId: 'read-a', toolName: 'read', args: { path: 'foo.ts' } });
		p.receive({ type: 'tool_execution_end', toolCallId: 'read-a', toolName: 'read', result: { content: [{ type: 'text', text: 'file' }] } });
		p.receive({ type: 'agent_end' });
		p.receive({ type: 'auto_retry_start' });
		await assert.rejects(p.protocol.send('too soon'));
		p.receive({ type: 'agent_settled', aborted: false });
		assert.deepStrictEqual(p.events.filter(e => e.kind === 'text').map(e => [e.text, e.append]), [['hel', true], ['hello', false]]);
		assert.deepStrictEqual(p.events.filter(e => e.kind === 'tool').map(e => [e.tool.id, e.tool.status]), [['read-a', 'running'], ['read-a', 'completed']]);
		assert.strictEqual(p.events.at(-1)?.kind, 'state');
		assert.strictEqual(p.events.filter(event => event.kind === 'state').at(-1)?.state, 'ready');
	});

	test('Pi confirmation can be declined or cancelled and only answers once', async () => {
		const p = create('pi');
		await p.start();
		p.receive({ type: 'extension_ui_request', id: 'a', method: 'confirm', title: 'Proceed?' });
		p.protocol.answer('string:a', { kind: 'decline' });
		assert.deepStrictEqual(p.last(), { type: 'extension_ui_response', id: 'a', confirmed: false });
		const count = p.sent.length;
		p.protocol.answer('string:a', { kind: 'allow' });
		assert.strictEqual(p.sent.length, count);
		p.receive({ type: 'extension_ui_request', id: 'b', method: 'select', title: 'Pick', options: ['yes', 'no'] });
		assert.throws(() => p.protocol.answer('string:b', { kind: 'answers', values: [{ id: 'value', value: 'not an option' }] }));
		p.protocol.answer('string:b', { kind: 'cancel' });
		assert.deepStrictEqual(p.last(), { type: 'extension_ui_response', id: 'b', cancelled: true });
	});

	test('Codex approval is correlated, bounded, and never grants ongoing permissions', async () => {
		const c = create('codex');
		await c.start();
		const send = c.protocol.send('test');
		c.reply({ turn: { id: 'turn' } });
		await send;
		c.receive({ id: 5, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'pwd' } });
		assert.strictEqual(c.events.at(-1)?.kind, 'request');
		c.protocol.answer('number:5', { kind: 'allow' });
		assert.deepStrictEqual(c.last(), { id: 5, result: { decision: 'accept' } });
		c.receive({ id: 6, method: 'item/permissions/requestApproval', params: { threadId: 'thread', permissions: { network: { enabled: true } } } });
		c.protocol.answer('number:6', { kind: 'allow' });
		assert.deepStrictEqual(c.last(), { id: 6, result: { permissions: { network: { enabled: true } }, scope: 'turn' } });
		c.receive({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'x'.repeat(9000) } });
		assert.deepStrictEqual(c.last(), { id: 7, result: { decision: 'decline' } });
		c.receive({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'unrelated', command: 'pwd' } });
		assert.ok(c.last()?.error);
		const stopping = c.protocol.stop();
		assert.deepStrictEqual(c.last()?.params, { threadId: 'thread', turnId: 'turn' });
		c.reply({});
		await stopping;
		c.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
		assert.strictEqual(c.events.filter(event => event.kind === 'state').at(-1)?.state, 'interrupted');
	});
});
