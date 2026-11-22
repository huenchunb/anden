/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AndenPiSession } from '../../../../../platform/anden/common/andenHistory.js';
import { AndenAgentUpdate } from '../../common/andenAgent.js';
import { AndenAgentProtocol } from '../../common/andenAgentProtocol.js';
import { AndenJsonLines } from '../../common/andenJsonLines.js';

suite('Anden agent protocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function create(resume?: AndenPiSession) {
		const sent: Record<string, unknown>[] = [];
		const events: AndenAgentUpdate[] = [];
		const protocol = new AndenAgentProtocol('/example', value => sent.push(value), event => events.push(event), resume);
		const receive = (value: unknown) => protocol.receive(value);
		const last = () => sent.at(-1);
		const reply = (result: unknown) => receive({ id: last()?.id, type: 'response', success: true, data: result });
		const settings = () => events.filter(event => event.kind === 'modelSettings').at(-1)?.settings;
		const start = async (state: Record<string, unknown> = {}) => {
			const starting = protocol.start();
			reply({ isStreaming: false, ...state });
			await starting;
		};
		return { protocol, receive, reply, events, sent, last, start, settings };
	}

	test('frames split, empty, and oversized JSONL records', () => {
		const data: unknown[] = [];
		const framer = new AndenJsonLines(16);
		framer.accept('{"x":', x => data.push(x));
		framer.accept('"años"}\r\n\n[]\n  ', x => data.push(x));
		assert.deepStrictEqual(data, [{ x: 'años' }, []]);
		assert.throws(() => framer.accept(' '.repeat(16), () => { }), /framing limit/);
	});

	test('accepts only the exact idle Pi session on resume and does not replay a turn', async () => {
		const native = { sessionId: '00000000-0000-4000-8000-000000000001', sessionFile: '/example/test.jsonl', cwd: '/example' };
		const p = create(native);
		await p.start(native);
		assert.deepStrictEqual(p.events.find(event => event.kind === 'piSession'), { kind: 'piSession', session: native });
		assert.deepStrictEqual(p.sent.map(message => message.type), ['get_state']);
		const other = create(native);
		await assert.rejects(other.start({ ...native, sessionId: '00000000-0000-4000-8000-000000000002' }), /expected idle session/);
		assert.ok(!other.events.some(event => event.kind === 'state' && event.state === 'ready'));
	});

	test('keeps Pi busy until settled, records tool results and reconciles final text', async () => {
		const p = create();
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
		const p = create();
		await p.start();
		p.receive({ type: 'extension_ui_request', id: 'a', method: 'confirm', title: 'Proceed?' });
		p.protocol.answer('string:a', { kind: 'decline' });
		assert.deepStrictEqual(p.last(), { type: 'extension_ui_response', id: 'a', confirmed: false });
		const count = p.sent.length;
		p.protocol.answer('string:a', { kind: 'allow' });
		assert.strictEqual(p.sent.length, count);
		p.receive({ type: 'extension_ui_request', id: 'b', method: 'select', title: 'Pick', options: ['yes', 'no'] });
		assert.throws(() => p.protocol.answer('string:b', { kind: 'value', value: 'not an option' }));
		p.protocol.answer('string:b', { kind: 'cancel' });
		assert.deepStrictEqual(p.last(), { type: 'extension_ui_response', id: 'b', cancelled: true });
	});

	test('Pi reads and changes model and reasoning without starting a turn', async () => {
		const p = create();
		const oldModel = { id: 'old', provider: 'test', name: 'Old' };
		const newModel = { id: 'new', provider: 'test', name: 'New' };
		await p.start({ model: oldModel, thinkingLevel: 'low' });
		assert.strictEqual(p.settings()?.model?.id, 'old');
		const listing = p.protocol.listModels();
		assert.strictEqual(p.last()?.type, 'get_available_models');
		p.reply({ models: [oldModel, newModel] });
		await Promise.resolve();
		p.reply({ model: oldModel, thinkingLevel: 'low' });
		assert.deepStrictEqual((await listing).map(model => model.id), ['old', 'new']);
		const changing = p.protocol.selectModel({ id: 'new', provider: 'test' });
		assert.strictEqual(p.last()?.type, 'set_model');
		assert.strictEqual(p.last()?.modelId, 'new');
		await assert.rejects(p.protocol.send('too early'));
		p.reply(newModel);
		await Promise.resolve();
		p.reply({ model: newModel, thinkingLevel: 'medium' });
		await changing;
		assert.strictEqual(p.settings()?.model?.id, 'new');
		const thinking = p.protocol.selectReasoning('high');
		assert.strictEqual(p.last()?.type, 'get_available_thinking_levels');
		p.reply({ levels: ['medium', 'high'] });
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(p.last()?.type, 'set_thinking_level');
		p.reply({});
		await Promise.resolve();
		p.reply({ model: newModel, thinkingLevel: 'high' });
		await thinking;
		assert.strictEqual(p.settings()?.reasoning, 'high');
		assert.ok(!p.sent.some(message => message.type === 'prompt'));
	});

	test('validates a Pi extension selection before responding', async () => {
		const p = create();
		await p.start();
		p.receive({ type: 'extension_ui_request', id: 'choice', method: 'select', title: 'Choose', options: ['One', 'Two'] });
		assert.throws(() => p.protocol.answer('string:choice', { kind: 'value', value: 'Three' }), /valid answer/);
		p.protocol.answer('string:choice', { kind: 'value', value: 'Two' });
		assert.deepStrictEqual(p.last(), { type: 'extension_ui_response', id: 'choice', value: 'Two' });
	});
});
