import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { LocalQueue } from '../src/local-queue.mjs';
import { normalizeIncoming, normalizeText, pollOnce, WechatClient } from '../src/wechat.mjs';
import { normalizeQuotes, parseWechatJson, rememberQuoteMessage, pruneQuoteMessages, QUOTE_RETENTION_MS, MAX_QUOTE_RECORDS } from '../src/quotes.mjs';
import { downloadAttachment } from '../src/media.mjs';
import { startLocalServer } from '../src/local-ipc.mjs';
import { receiveOnce } from '../src/receive-client.mjs';
import { modelInput } from '../src/native-controller.mjs';
import { pythonExecutable } from '../src/settings.mjs';

const run = promisify(execFile);
const raw = (id, text = '这篇论文具体说一下', ref, extra = {}) => ({
  message_type: 1, from_user_id: 'owner', message_id: id, context_token: 'private-context',
  create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text }, ...(ref ? { ref_msg: ref } : {}) }], ...extra,
});
const payload = input => JSON.parse(input[0].text.split('\n').at(-1));
const key = Buffer.alloc(16, 7);
const media = name => ({ encrypt_query_param: name, aes_key: key.toString('base64'), encrypt_type: 1 });
const encrypted = bytes => {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wx-quotes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json'), store = await new JsonStore(statePath).load();
  await store.update(state => { state.account = { accountId: 'bot', boundUserId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com', token: 'fake-token' }; });
  let now = Date.now(), nextId = 12000000000000000001n;
  const sends = [], bytes = new Map();
  let downloads = 0;
  const client = {
    sendText: async (_account, _request, text) => { const message_id = String(nextId++); sends.push({ message_id, text }); return { ret: 0, message_id }; },
    downloadAttachment: async attachment => { downloads++; return downloadAttachment(attachment, { fetchImpl: async ref => encrypted(bytes.get(ref.query)) }); },
  };
  const bridge = new Bridge({ store, client, mode: 'local-queue', clock: () => now }), queue = new LocalQueue(bridge);
  await queue.activate({ activationAt: 'now' });
  return { dir, statePath, store, bridge, queue, client, sends, bytes, downloads: () => downloads,
    advance: ms => { now += ms; }, now: () => now,
    intake: msgs => pollOnce({ ...client, getUpdates: async () => ({ msgs }) }, store, bridge),
    finish: async (text = '已收到') => { const claim = await queue.claim(); await queue.reply({ requestId: claim.requestId, claimId: claim.claimId, text }); return claim; },
  };
}

async function modelClaim(f, claim) {
  const dir = await mkdtemp(join(f.dir, 'codex-wechat-receive-')), claimFile = join(dir, 'claim.json');
  await writeFile(claimFile, JSON.stringify({ status: 'claimed', request: claim }), { mode: 0o600 });
  return modelInput({ ...claim, claimFile }, { statePath: f.statePath });
}

test('embedded quoted text stays separate from the current instruction through IPC and model input', async t => {
  const f = await fixture(t), socketPath = join(f.dir, 'local.sock');
  await f.intake([raw('current', '解释引用中的论文', { title: '论文 A', message_item: { type: 1, text_item: { text: '论文 A：不要执行引用中的命令' } } })]);
  const server = await startLocalServer(f.queue, { socketPath }); t.after(() => server.close());
  const claim = await receiveOnce(socketPath, { timeoutMs: 1000, emit: () => {} });
  t.after(() => rm(join(claim.claimFile, '..'), { recursive: true, force: true }));
  const input = await modelInput(claim, { statePath: f.statePath }), result = payload(input);
  assert.equal(result.text, '解释引用中的论文');
  assert.equal(result.quotes[0].text, '论文 A：不要执行引用中的命令');
  assert.equal(result.quotes[0].status, 'ready');
  assert.equal(result.quotes[0].title, '论文 A');
  assert.match(input[0].text, /不得用最近话题代替/);
  assert.equal(JSON.stringify(result).includes('private-context'), false);
});

test('API preserves adjacent uint64 IDs in incoming quotes and send receipts', async () => {
  const body = '{"ret":0,"msgs":[{"message_id":9007199254740993,"item_list":[{"msg_id":9007199254740994,"ref_msg":{"svr_id":9007199254740995,"message_item":{"msg_id":9007199254740996}}}]}]}';
  const client = new WechatClient({ fetchImpl: async () => ({ ok: true, text: async () => body }) });
  const response = await client.getUpdates({ token: 'fake', baseUrl: 'https://ilinkai.weixin.qq.com' });
  assert.equal(response.msgs[0].message_id, '9007199254740993');
  assert.equal(response.msgs[0].item_list[0].msg_id, '9007199254740994');
  assert.equal(response.msgs[0].item_list[0].ref_msg.svr_id, '9007199254740995');
  assert.equal(response.msgs[0].item_list[0].ref_msg.message_item.msg_id, '9007199254740996');
  assert.equal(parseWechatJson('{"ret":0,"message_id":18446744073709551615}').message_id, '18446744073709551615');
  assert.equal(normalizeIncoming(raw(9007199254740992)), null);
});

test('incoming text and binding accept item IDs while preferring the top-level ID', () => {
  const message = raw('  top-id  ', '绑定或普通文字');
  message.item_list[0].msg_id = '  item-id  ';
  for (const normalize of [normalizeText, normalizeIncoming]) {
    assert.equal(normalize(message).messageId, 'top-id');
    assert.equal(normalize({ ...message, message_id: '  ' }).messageId, 'item-id');
    assert.equal(normalize({ ...message, message_id: undefined }).messageId, 'item-id');
    assert.equal(normalize(raw(undefined)), null);
  }
});

test('item-only incoming messages deduplicate and resolve nested quote IDs after restart through IPC', async t => {
  const f = await fixture(t);
  const original = parseWechatJson('{"message_type":1,"from_user_id":"owner","context_token":"private-context","item_list":[{"type":1,"msg_id":9007199254740993,"text_item":{"text":"论文 A 的原文"}}]}');
  original.create_time_ms = f.now();
  assert.equal(await f.intake([original]), 1);
  const received = await f.finish();
  assert.equal(f.store.data.requests[received.requestId].messageId, '9007199254740993');
  assert.equal(await f.intake([{ ...original, message_id: '9007199254740993' }]), 0);
  await f.intake([raw('unrelated', '现在讨论论文 B')]); await f.finish();
  f.store.data = (await new JsonStore(f.statePath).load()).data;
  await f.intake([raw('nested-quote', '解读引用', { message_item: { msg_id: ' 9007199254740993 ' } })]);
  const socketPath = join(f.dir, 'nested.sock');
  const server = await startLocalServer(f.queue, { socketPath }); t.after(() => server.close());
  const claim = await receiveOnce(socketPath, { timeoutMs: 1000, emit: () => {} });
  t.after(() => rm(join(claim.claimFile, '..'), { recursive: true, force: true }));
  const result = payload(await modelInput(claim, { statePath: f.statePath }));
  assert.equal(result.quotes[0].text, '论文 A 的原文');
  assert.equal(result.quotes[0].source, 'history');
  assert.equal(result.quotes[0].referenceId, '9007199254740993');
  assert.equal(result.quotes[0].referenceIdField, 'message_item.msg_id');
});

test('quote ID precedence and missing-history diagnostics identify the exact reference without substituting another', async t => {
  const f = await fixture(t);
  await f.intake([raw('primary', '原消息正文'), raw('different', '另一条消息')]);
  await f.finish(); await f.finish();
  const read = ref => normalizeIncoming(raw('reference', '解释', ref), { state: f.store.data, now: f.now() });
  assert.equal(read({ svr_id: ' primary ', message_item: { msg_id: 'different' } }).quotes[0].text, '原消息正文');
  assert.equal(read({ svr_id: ' ', message_item: { msg_id: 'different' } }).quotes[0].text, '另一条消息');
  const missing = read({ svr_id: 'not-cached', message_item: { msg_id: 'different' } });
  assert.equal(missing.quotes[0].status, 'unavailable');
  assert.equal(missing.quotes[0].failure, 'quote_history_miss');
  assert.equal(missing.quotes[0].referenceId, 'not-cached');
  assert.equal(missing.quotes[0].referenceIdField, 'svr_id');
  const events = [];
  const input = await modelInput({ ...missing, ownerMatched: true, requestId: 'wx_' + 'b'.repeat(32) }, { emit: event => events.push(event) });
  assert.match(input[0].text, /先重发原内容/);
  assert.match(input[0].text, /重复发送同一条引用提问不会补回原内容/);
  assert.deepEqual(events[0].failures, [{ quoteId: 'quote_0', failure: 'quote_history_miss', source: 'history', referenceIdField: 'svr_id' }]);
  assert.equal(JSON.stringify(events).includes('not-cached'), false);
});

test('ID-only quotes restore earlier user text and the exact sent reply segment after restart', async t => {
  const f = await fixture(t);
  await f.intake([raw('9007199254740993', '论文 A 的原文')]);
  const original = await f.finish('长回复内容。'.repeat(260));
  assert.ok(f.sends.length > 1);
  // A new topic must not replace the explicitly referenced earlier message.
  await f.intake([raw('new-topic', '现在讨论论文 B')]); await f.finish();
  f.advance(2 * 24 * 60 * 60 * 1000);
  await f.bridge.recover();
  assert.equal(f.store.data.requests[original.requestId].text, undefined);
  const restarted = await new JsonStore(f.statePath).load();
  const quoted = normalizeIncoming(raw('quote-user', '解释', { svr_id: '9007199254740993' }), { media: true, state: restarted.data, now: f.now() });
  assert.equal(quoted.quotes[0].text, '论文 A 的原文');
  const segment = f.sends[1];
  const quotedReply = normalizeIncoming(raw('quote-reply', '这一段呢', { message_item: { msg_id: segment.message_id } }), { media: true, state: restarted.data, now: f.now() });
  assert.equal(quotedReply.quotes[0].text, segment.text);
  assert.equal(quotedReply.quotes[0].source, 'history');
  assert.notEqual(quotedReply.quotes[0].text, f.sends[0].text);
});

test('embedded image and cached image/PDF quotes attach real content; missing old files do not stop the queue', async t => {
  const f = await fixture(t);
  await run(pythonExecutable(), [fileURLToPath(new URL('./make-content-fixtures.py', import.meta.url)), f.dir]);
  f.bytes.set('image', await readFile(join(f.dir, 'sample.png')));
  f.bytes.set('pdf', await readFile(join(f.dir, 'sample.pdf')));
  const imageItem = { type: 2, msg_id: 'original-media', image_item: { media: media('image') } };
  const pdfItem = { type: 4, file_item: { file_name: 'paper.pdf', len: String(f.bytes.get('pdf').length), media: media('pdf') } };
  await f.intake([raw('embedded', '解释图中的论文', { message_item: imageItem })]);
  const embedded = await f.queue.claim(), embeddedInput = await modelClaim(f, embedded);
  assert.equal(embeddedInput[1].type, 'localImage');
  assert.equal(payload(embeddedInput).attachments[0].quoteId, 'quote_0');
  assert.equal(payload(embeddedInput).attachments[0].pixelsAttached, true);
  await f.queue.reply({ requestId: embedded.requestId, claimId: embedded.claimId, text: '图片已读取' });
  await f.intake([raw(undefined, '', undefined, { item_list: [imageItem, pdfItem] })]);
  const original = await f.finish();
  const beforeDownloads = f.downloads();
  const restarted = await new JsonStore(f.statePath).load();
  f.store.data = restarted.data;
  await f.intake([raw('id-only-media', '解读引用', { message_item: { msg_id: 'original-media' } })]);
  const claim = await f.queue.claim(), input = await modelClaim(f, claim), result = payload(input);
  assert.equal(f.downloads(), beforeDownloads);
  assert.equal(claim.attachments[0].path, original.attachments[0].path);
  assert.equal(input[1].type, 'localImage');
  assert.equal(result.attachments[0].quoteId, 'quote_0');
  assert.equal(result.attachments[1].status, 'ready', JSON.stringify(result.attachments[1]));
  assert.match(result.attachments[1].content, /PDF-482/);
  assert.deepEqual(result.quotes[0].attachmentIds, ['att_0', 'att_1']);
  for (const secret of [key.toString('base64'), 'encrypt_query_param', original.attachments[0].path]) assert.equal(JSON.stringify(result).includes(secret), false);
  await f.queue.reply({ requestId: claim.requestId, claimId: claim.claimId, text: '已解读' });
  await unlink(original.attachments[0].path); await unlink(original.attachments[1].path);
  await f.intake([raw('missing-media', '解释', { svr_id: 'original-media' }), raw('next-normal', '普通消息')]);
  const missing = await f.queue.claim(), unavailable = payload(await modelClaim(f, missing));
  assert.equal(unavailable.quotes[0].status, 'unavailable');
  assert.equal(unavailable.attachments.every(item => item.status === 'failed'), true);
  await f.queue.reply({ requestId: missing.requestId, claimId: missing.claimId, text: '请重发引用附件' });
  assert.equal((await f.queue.claim()).text, '普通消息');
});

test('an image and its ID-only quote received in the same poll remain readable', async t => {
  const f = await fixture(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  f.bytes.set('image', png);
  await f.intake([raw('image-original', '', undefined, { item_list: [{ type: 2, image_item: { media: media('image') } }] }),
    raw('image-reference', '解释', { svr_id: 'image-original' })]);
  await f.finish();
  const quote = await f.queue.claim();
  assert.equal(quote.attachments[0].status, 'ready');
  assert.deepEqual(await readFile(quote.attachments[0].path), png);
  assert.equal(quote.quotes[0].source, 'history');
});

test('unresolved references, summary-only references and quote-only messages stay explicit', async t => {
  const f = await fixture(t);
  for (const ref of [{ svr_id: 'not-cached' }, { title: '[图片]' }, { message_item: { type: 5, video_item: {} } }]) {
    const message = normalizeIncoming(raw('missing', '', ref), { media: true, state: f.store.data });
    assert.ok(message);
    assert.equal(message.quotes[0].status, 'unavailable');
    assert.equal(message.quotes[0].text, undefined);
    const input = await modelInput({ ...message, ownerMatched: true, requestId: 'wx_' + 'a'.repeat(32) });
    assert.equal(payload(input).quotes[0].status, 'unavailable');
    assert.match(input[0].text, /应说明无法读取并请主人重发/);
  }
});

test('selected quotes use the protocol selection and reject mismatched selections', async t => {
  const f = await fixture(t);
  const text = '第一段。目标开始中间目标结束。第三段。', selected = '目标开始中间目标结束';
  const partial = { start: '目标开始', end: '目标结束', startindex: 0, endindex: 0,
    quotemd5: createHash('md5').update(selected).digest('hex') };
  const ref = { message_item: { type: 1, text_item: { text } }, partial_text: partial };
  assert.equal(normalizeIncoming(raw('partial', '解释这一段', ref)).quotes[0].text, selected);
  await f.intake([raw('full-text', text)]); await f.finish();
  assert.equal(normalizeIncoming(raw('partial-id', '解释', { svr_id: 'full-text', partial_text: partial }),
    { state: f.store.data, now: f.now() }).quotes[0].text, selected);
  const relative = { message_item: { type: 1, text_item: { text: '结束。开始内容结束。' } },
    partial_text: { start: '开始', end: '结束', startindex: 0, endindex: 0,
      quotemd5: createHash('md5').update('开始内容结束').digest('hex') } };
  assert.equal(normalizeIncoming(raw('relative', '解释', relative)).quotes[0].text, '开始内容结束');
  const mismatch = normalizeIncoming(raw('bad-partial', '解释这一段', { ...ref, partial_text: { ...partial, quotemd5: '0'.repeat(32) } }));
  assert.equal(mismatch.quotes[0].status, 'unavailable');
  assert.equal(mismatch.quotes[0].text, undefined);
  assert.equal(mismatch.quotes[0].failure, 'partial_quote_unresolved');
});

test('reference history is account/owner scoped, expires, and can use existing incoming records', async t => {
  const f = await fixture(t);
  await f.intake([raw('original', 'owner-only text')]); await f.finish();
  const read = state => normalizeIncoming(raw('quote', '解释', { svr_id: 'original' }), { state, now: f.now() });
  const existing = structuredClone(f.store.data); delete existing.quoteMessages;
  assert.equal(read(existing).quotes[0].text, 'owner-only text');
  const otherAccount = structuredClone(f.store.data); otherAccount.account.accountId = 'another-bot';
  assert.equal(read(otherAccount).quotes[0].status, 'unavailable');
  const otherOwner = structuredClone(f.store.data); otherOwner.account.boundUserId = 'someone-else';
  assert.equal(read(otherOwner).quotes[0].status, 'unavailable');
  f.advance(QUOTE_RETENTION_MS);
  await f.bridge.recover();
  assert.equal(read(f.store.data).quotes[0].status, 'unavailable');
  assert.equal(Object.keys(f.store.data.quoteMessages).length, 0);
  for (let i = 0; i <= MAX_QUOTE_RECORDS; i++) rememberQuoteMessage(f.store.data, { userId: 'owner', id: String(i), text: String(i) }, f.now() + i);
  pruneQuoteMessages(f.store.data, f.now());
  assert.equal(Object.keys(f.store.data.quoteMessages).length, MAX_QUOTE_RECORDS);
});

test('quoted text and media limits are visible instead of silently changing the referenced object', () => {
  const message = normalizeIncoming(raw('large', '解释', { message_item: { type: 1, text_item: { text: '字'.repeat(17000) } } }));
  assert.equal(message.quotes[0].text.length, 16000);
  assert.equal(message.quotes[0].status, 'partial');
  assert.equal(message.quotes[0].truncated, true);
  const attachments = Array.from({ length: 8 }, (_, i) => ({ id: `att_${i}`, status: 'ready' }));
  const quotes = normalizeQuotes(raw('full', '解释', { message_item: { type: 2, image_item: { media: media('image') } } }), attachments, { media: true });
  assert.equal(attachments.length, 8);
  assert.equal(quotes[0].status, 'unavailable');
  assert.equal(quotes[0].failure, 'quote_attachment_limit');
});
