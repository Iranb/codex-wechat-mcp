import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { Bridge, MAX_AGE } from '../src/bridge.mjs';
import { LocalQueue } from '../src/local-queue.mjs';
import { startLocalServer } from '../src/local-ipc.mjs';
import { receiveOnce, respondFromClaim } from '../src/receive-client.mjs';
import { NativeJournal } from '../src/native-journal.mjs';
import { NativeController } from '../src/native-controller.mjs';
import { splitReply, MAX_MESSAGE_CHARS, MAX_REPLY_CHARS } from '../src/reply.mjs';

const body = parts => parts.map(part => part.replace(/^\(\d+\/\d+\)\n/, '')).join('');

test('long text is numbered, bounded and lossless, including paragraphs, whitespace and emoji', () => {
  assert.deepEqual(splitReply('short reply'), ['short reply']);
  assert.deepEqual(splitReply('字'.repeat(800)), ['字'.repeat(800)]);
  const examples = ['字'.repeat(801), '字'.repeat(2717), '字'.repeat(MAX_REPLY_CHARS),
    '段落内容'.repeat(140) + '\n\n' + '下一段内容\n'.repeat(150),
    'x'.repeat(779) + '😀'.repeat(700), '  code\n\tvalue = 123;\n'.repeat(200) + '  '];
  for (const text of examples) {
    const parts = splitReply(text);
    assert.ok(parts.length > 1);
    assert.equal(body(parts), text);
    parts.forEach((part, index) => {
      assert.ok(part.startsWith(`(${index + 1}/${parts.length})\n`));
      assert.ok(part.length <= MAX_MESSAGE_CHARS);
      assert.ok(part.isWellFormed());
    });
  }
  const paragraphs = splitReply('a'.repeat(600) + '\n\n' + 'b'.repeat(700));
  assert.ok(paragraphs[0].endsWith('\n\n'));
});

async function fixture(t) {
  const dir = await mkdtemp('/tmp/wx-parts-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = await new JsonStore(path).load();
  await store.update(state => { state.account = { token: 'fake-only', accountId: 'fake-bot', boundUserId: 'owner' }; });
  const sent = [];
  const client = { sendText: async (_account, request, text) => { sent.push({ text, id: request.sendClientId, context: request.contextToken }); } };
  let now = Date.now();
  const options = { mode: 'local-queue', client, clock: () => now };
  const bridge = new Bridge({ store, ...options });
  const queue = new LocalQueue(bridge);
  await queue.activate({ activationAt: 'now' });
  const incoming = await bridge.incoming({ userId: 'owner', messageId: 'm1', contextToken: 'fake-context', text: 'question', timestamp: new Date(now).toISOString() });
  return { dir, path, store, client, sent, options, bridge, queue, id: incoming.requestId, advance: ms => { now += ms; } };
}

test('parts are sent serially under the original context and accepted parts are never duplicated', async t => {
  const f = await fixture(t);
  const claim = await f.queue.claim();
  const text = '内容'.repeat(1400);
  const parts = splitReply(text);
  const original = f.client.sendText;
  f.client.sendText = async (...args) => {
    const request = f.store.data.requests[f.id];
    assert.equal(request.status, 'sending');
    assert.equal(request.replyParts.filter(p => p.status === 'sending').length, 1);
    assert.equal(request.replyParts.filter(p => p.status === 'accepted').length, f.sent.length);
    await assert.rejects(f.queue.reply({ ...claim, text }), /sending.*manual reconciliation/);
    await original(...args);
  };
  assert.equal((await f.queue.reply({ ...claim, text })).status, 'accepted');
  assert.deepEqual(f.sent.map(s => s.text), parts);
  assert.equal(new Set(f.sent.map(s => s.id)).size, parts.length);
  assert.ok(f.sent.every(s => s.context === 'fake-context'));
  assert.equal(f.store.data.requests[f.id].contextToken, undefined);
  assert.ok(f.store.data.requests[f.id].replyParts.every(p => p.status === 'accepted' && p.text === undefined));
  assert.equal((await f.queue.reply({ ...claim, text })).duplicate, true);
  await assert.rejects(f.queue.reply({ ...claim, text: text + 'changed' }), /different reply/);
  assert.equal(f.sent.length, parts.length);
});

test('an uncertain second part stops the remaining parts and stays blocked after restart', async t => {
  const f = await fixture(t);
  const claim = await f.queue.claim();
  const text = '字'.repeat(2717);
  const original = f.client.sendText;
  f.client.sendText = async (...args) => {
    await original(...args);
    if (f.sent.length === 2) throw new Error('fake response loss');
  };
  await assert.rejects(f.queue.reply({ ...claim, text }), /unconfirmed/);
  const store = await new JsonStore(f.path).load();
  const bridge = new Bridge({ store, ...f.options });
  await bridge.recover();
  const queue = new LocalQueue(bridge);
  assert.deepEqual(store.data.requests[f.id].replyParts.map(p => p.status), ['accepted', 'unconfirmed', 'pending', 'pending']);
  assert.deepEqual(queue.requestStatus({ ...claim, text }).replyProgress, { total: 4, accepted: 1 });
  await assert.rejects(queue.reply({ ...claim, text }), /unconfirmed/);
  assert.equal(f.sent.length, 2);
});

test('a restart between confirmed parts resumes only unsent parts without a model invocation', async t => {
  const f = await fixture(t);
  const socketPath = join(f.dir, 'queue.sock');
  let server = await startLocalServer(f.queue, { socketPath });
  t.after(() => server.close());
  const claim = await receiveOnce(socketPath, { emit: () => {} });
  t.after(() => rm(join(claim.claimFile, '..'), { recursive: true, force: true }));
  const text = '字'.repeat(2717);
  const journal = await new NativeJournal(join(f.dir, 'native-codex.json')).load();
  await journal.update(data => {
    data.active = { requestId: f.id, claimFile: claim.claimFile, reply: text, stage: 'prepared' };
    data.receiveDir = join(claim.claimFile, '..');
  });
  const controller = new NativeController({ client: { request: () => { throw new Error('model must not run'); } },
    journal, socketPath, statePath: f.path, cwd: f.dir });
  const update = f.store.update.bind(f.store);
  let crash = true;
  f.store.update = fn => update(state => {
    fn(state);
    if (crash && state.requests[f.id].replyParts?.[1]?.status === 'sending') {
      crash = false;
      throw new Error('simulated crash before the next send');
    }
  });
  await assert.rejects(controller.processActive(), /wechat_send_unconfirmed/);
  assert.equal(f.sent.length, 1);
  await server.close();
  const store = await new JsonStore(f.path).load();
  const bridge = new Bridge({ store, ...f.options });
  await bridge.recover();
  assert.equal(store.data.requests[f.id].status, 'pending');
  server = await startLocalServer(new LocalQueue(bridge), { socketPath });
  controller.journal = await new NativeJournal(journal.path).load();
  await controller.processActive();
  assert.deepEqual(f.sent.map(s => s.text), splitReply(text));
  assert.equal(controller.journal.data.active, null);
  assert.equal(controller.journal.data.completed, 1);
  assert.equal((await respondFromClaim(socketPath, { ...claim, text })).duplicate, true);
  assert.equal(f.sent.length, 4);
});

test('a recorded in-flight part is unconfirmed after a crash and cannot be retried', async t => {
  const f = await fixture(t);
  const claim = await f.queue.claim();
  await f.store.update(state => {
    const request = state.requests[f.id];
    request.status = 'sending';
    request.replyParts = [{ status: 'accepted', sendClientId: 'first' },
      { status: 'sending', sendClientId: 'second', text: 'second part' },
      { status: 'pending', sendClientId: 'third', text: 'third part' }];
  });
  await f.bridge.recover();
  assert.equal(f.store.data.requests[f.id].replyParts[1].status, 'unconfirmed');
  await assert.rejects(f.queue.reply({ ...claim, text: 'reply' }), /unconfirmed/);
  assert.equal(f.sent.length, 0);
});

test('long Unicode replies cross IPC and a lost final response is reconciled without resending', async t => {
  const f = await fixture(t);
  const socketPath = join(f.dir, 'queue.sock');
  const server = await startLocalServer(f.queue, { socketPath });
  t.after(() => server.close());
  const claim = await receiveOnce(socketPath, { emit: () => {} });
  t.after(() => rm(join(claim.claimFile, '..'), { recursive: true, force: true }));
  const text = '中文😀\n'.repeat(3600);
  assert.ok(Buffer.byteLength(text) > 32_768);
  const original = f.queue.reply.bind(f.queue);
  f.queue.reply = async args => { await original(args); throw new Error('fake lost final response'); };
  const result = await respondFromClaim(socketPath, { ...claim, text });
  assert.equal(result.responseLost, true);
  assert.equal(body(f.sent.map(s => s.text)), text);
  assert.equal(JSON.parse(await readFile(join(claim.claimFile, '..', 'outbox.json'), 'utf8')).outcome, 'accepted');
  const count = f.sent.length;
  assert.equal((await respondFromClaim(socketPath, { ...claim, text })).status, 'accepted');
  assert.equal(f.sent.length, count);
});

test('expiry removes saved unsent text and prevents continuing a multipart reply', async t => {
  const f = await fixture(t);
  const claim = await f.queue.claim();
  await f.store.update(state => {
    state.requests[f.id].status = 'sending';
    state.requests[f.id].replyParts = [{ status: 'accepted' }, { status: 'pending', text: 'old private reply' }];
  });
  f.advance(MAX_AGE);
  await f.bridge.recover();
  assert.equal(f.store.data.requests[f.id].status, 'expired');
  assert.equal(f.store.data.requests[f.id].replyParts[1].text, undefined);
  await assert.rejects(f.queue.reply({ ...claim, text: 'old reply' }), /expired/);
  assert.equal(f.sent.length, 0);
});
