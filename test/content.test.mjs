import { pythonExecutable } from '../src/settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { readAttachmentContent } from '../src/content-reader.mjs';
import { modelInput } from '../src/native-controller.mjs';
import { JsonStore } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { LocalQueue } from '../src/local-queue.mjs';
import { pollOnce } from '../src/wechat.mjs';
import { downloadAttachment, resolveMediaHost, inspectContent, normalizeAttachments } from '../src/media.mjs';
import { pinnedLookup } from '../src/webhook.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wx-content-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await run(pythonExecutable(), [fileURLToPath(new URL('./make-content-fixtures.py', import.meta.url)), dir]);
  return dir;
}
async function value(dir, name, kind) {
  const path = join(dir, name), bytes = await readFile(path);
  return { path, kind, name, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('real PDF, DOCX, XLSX and text are parsed as content; encryption, corruption and text budget fail explicitly', async t => {
  const dir = await fixture(t);
  for (const [name, kind, code] of [['sample.pdf','pdf','PDF-482'],['sample.docx','word','DOCX-593'],['sample.xlsx','excel','XLSX-264'],['sample.txt','text','TEXT-815']]) {
    const result = await readAttachmentContent(await value(dir, name, kind));
    assert.equal(result.status, 'ready'); assert.ok(result.text.includes(code));
    if (kind === 'excel') { assert.equal(result.formulasExecuted, false); assert.ok(result.text.includes('not executed')); }
  }
  assert.equal((await readAttachmentContent(await value(dir, 'encrypted.pdf','pdf'))).failure, 'encrypted_document');
  assert.equal((await readAttachmentContent(await value(dir, 'unsafe.docx','word'))).failure, 'unsafe_document_structure');
  const scan = await readAttachmentContent(await value(dir, 'scan.pdf','pdf'));
  assert.equal(scan.status, 'ready'); assert.equal(scan.contentSource,'rendered_pdf_pages');
  assert.equal(scan.images.length,1); assert.ok((await stat(scan.images[0])).size>1000);
  const large = await readAttachmentContent(await value(dir,'large.txt','text'));
  assert.equal(large.text.length, 30000); assert.equal(large.truncated, true);
  const original = await value(dir,'sample.txt','text'); await writeFile(original.path,'changed');
  assert.equal((await readAttachmentContent(original)).failure,'attachment_digest_mismatch');
  const bad = join(dir,'broken.docx'); await writeFile(bad,'not a zip',{mode:0o600});
  assert.equal((await readAttachmentContent(await value(dir,'broken.docx','word'))).status,'failed');
});

test('PNG/JPEG/WebP/GIF must decode into private real pixels; derived collisions are never overwritten', async t => {
  const dir = await fixture(t);
  for (const ext of ['png','jpg','webp','gif']) {
    const result = await readAttachmentContent(await value(dir,'sample.'+ext,'image'));
    assert.equal(result.status,'ready'); assert.equal(result.width,900); assert.equal(result.height,360);
    assert.equal((await stat(result.imagePath)).mode & 0o077,0);
    assert.equal(inspectContent(await readFile(result.imagePath),{kind:'image',extension:'.png'}).mime,'image/png');
  }
  const result = await readAttachmentContent(await value(dir,'sample.png','image'));
  await writeFile(result.imagePath,'collision');
  assert.equal((await readAttachmentContent(await value(dir,'sample.png','image'))).failure,'derived_storage_collision');
  assert.equal(await readFile(result.imagePath,'utf8'),'collision');
});

test('Fake-IP uses separate public DNS and pins real addresses; private destinations stay forbidden on Node 25', async () => {
  let called = 0;
  const url='https://novac2c.cdn.weixin.qq.com/c2c/download';
  const result=await resolveMediaHost(url,{resolver:async()=>[{address:'198.18.3.10',family:4}],publicResolver:async host=>{
    called++; assert.equal(host,'novac2c.cdn.weixin.qq.com'); return [{address:'8.8.8.8',family:4}];
  }});
  assert.equal(result.address.address,'8.8.8.8'); assert.equal(called,1);
  await assert.rejects(resolveMediaHost(url,{resolver:async()=>[{address:'127.0.0.1',family:4}],publicResolver:async()=>{throw new Error('must not bypass private DNS');}}),/unsafe_media_host/);
  await assert.rejects(resolveMediaHost(url,{resolver:async()=>[{address:'198.18.0.1',family:4}],publicResolver:async()=>[{address:'10.0.0.1',family:4}]}),/unsafe_media_host/);
  let all;
  pinnedLookup(result.address)('host',{all:true},(_error,addresses)=>{all=addresses;});
  assert.deepEqual(all,[result.address]);
});

test('encrypted attachment intake reaches actual model content and pixels; filename, keys and paths do not replace content', async t => {
  const dir=await fixture(t), statePath=join(dir,'state.json');
  const store=await new JsonStore(statePath).load();
  await store.update(s=>{s.account={token:'fake-only',accountId:'synthetic-bot',boundUserId:'owner',cursor:''};});
  const bridge=new Bridge({store,mode:'local-queue',client:{sendText:async()=>{throw new Error('no live sends');}}});
  const queue=new LocalQueue(bridge); await queue.activate({activationAt:'now'});
  const key=randomBytes(16), encrypted=new Map(), items=[];
  for(const [i,name] of ['sample.png','sample.pdf','sample.docx','sample.xlsx','sample.txt'].entries()) {
    const bytes=await readFile(join(dir,name)), cipher=createCipheriv('aes-128-ecb',key,null);
    encrypted.set(String(i),Buffer.concat([cipher.update(bytes),cipher.final()]));
    items.push({type:4,file_item:{file_name:'../../'+name,len:String(bytes.length),media:{encrypt_query_param:String(i),aes_key:key.toString('base64'),encrypt_type:1}}});
  }
  const imageBytes=await readFile(join(dir,'sample.png')), imageCiphertext=encrypted.get('0');
  for(const [id,mid_size] of [['inbound-plaintext',imageBytes.length],['inbound-ciphertext',imageCiphertext.length]]) {
    encrypted.set(id,imageCiphertext);
    items.push({type:2,image_item:{aeskey:key.toString('hex'),mid_size,media:{encrypt_query_param:id,encrypt_type:1}}});
  }
  const jpegBytes=Buffer.concat([await readFile(join(dir,'sample.jpg')),Buffer.alloc(24,0x42)]);
  const jpegCipher=createCipheriv('aes-128-ecb',key,null);
  encrypted.set('inbound-jpeg',Buffer.concat([jpegCipher.update(jpegBytes),jpegCipher.final()]));
  items.push({type:2,image_item:{aeskey:key.toString('hex'),mid_size:jpegBytes.length-100,thumb_size:1234,
    media:{encrypt_query_param:'inbound-jpeg',encrypt_type:1}}});
  const message={message_type:1,from_user_id:'owner',message_id:'synthetic-media',create_time_ms:Date.now(),context_token:'fake-context',item_list:items};
  const client={getUpdates:async()=>({msgs:[message],get_updates_buf:'next'}),downloadAttachment:a=>downloadAttachment(a,{fetchImpl:async ref=>encrypted.get(ref.query)})};
  assert.equal(await pollOnce(client,store,bridge),1); assert.equal(await pollOnce(client,store,bridge),0);
  const claim=await queue.claim(); assert.equal(claim.attachments.every(a=>a.status==='ready'),true);
  const receiveDir=await mkdtemp(join(tmpdir(),'codex-wechat-receive-content-')); t.after(()=>rm(receiveDir,{recursive:true,force:true}));
  claim.claimFile=join(receiveDir,'claim.json'); await writeFile(claim.claimFile,JSON.stringify({status:'claimed',request:claim}),{mode:0o600});
  const input=await modelInput(claim,{statePath});
  assert.equal(input.filter(item=>item.type==='localImage').length,4);
  assert.equal(input[1].type,'localImage'); assert.ok((await stat(input[1].path)).size>1000);
  const payload=JSON.parse(input[0].text.split('\n').slice(2).join('\n'));
  for(const code of ['PDF-482','DOCX-593','XLSX-264','TEXT-815'])assert.ok(payload.attachments.some(a=>a.content?.includes(code)));
  assert.ok(payload.text.length>0); assert.equal(payload.attachments[0].pixelsAttached,true);
  assert.equal(input[0].text.includes(dir),false); assert.equal(input[0].text.includes(key.toString('base64')),false);
  const unsupported=normalizeAttachments({...message,item_list:[{type:4,file_item:{file_name:'legacy.doc',media:{encrypt_query_param:'0',aes_key:key.toString('base64')}}}]});
  assert.equal(unsupported[0].failure,'unsupported_type');
});
