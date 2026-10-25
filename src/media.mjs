import { createDecipheriv, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { mkdir, lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { publicIp, pinnedLookup } from './webhook.mjs';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c/download';
const extKinds = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.pdf': 'pdf', '.docx': 'word', '.xlsx': 'excel',
  '.txt': 'text', '.md': 'text', '.csv': 'text', '.tsv': 'text',
};
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values' };
export class MediaError extends Error { constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; } }
const fail = (code, retryable = false) => { throw new MediaError(code, retryable); };
const sizeMismatch = (details) => { throw Object.assign(new MediaError('size_mismatch'), { sizeDetails: details }); };
const validSize = (value) => ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)))) ? Number(value) : null;
function safeName(value) {
  if (typeof value !== 'string') return 'attachment';
  const name = value.normalize('NFC').replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return name || 'attachment';
}
function extension(name) { return /\.[a-z0-9]{1,8}$/i.exec(name)?.[0].toLowerCase() || ''; }
function source(item, image) {
  const media = item?.media;
  if (!media || (media.encrypt_type !== undefined && media.encrypt_type !== 1)) return null;
  const query = media.encrypt_query_param;
  const fullUrl = media.full_url;
  if ((!query || typeof query !== 'string') && (!fullUrl || typeof fullUrl !== 'string')) return null;
  if (query && query.length > 4096 || fullUrl && fullUrl.length > 8192) return null;
  const key = image && typeof item.aeskey === 'string' ? item.aeskey : media.aes_key;
  if (!image && !key) return null;
  return { query, fullUrl, key, hexKey: Boolean(image && item.aeskey) };
}
export function normalizeAttachments(raw) {
  if (raw?.message_type !== 1 || !Array.isArray(raw.item_list)) return [];
  const entries = [];
  for (const item of raw.item_list.slice(0, 32)) {
    if (entries.length >= 8) break;
    if (item?.type !== 2 && item?.type !== 4) continue;
    const image = item.type === 2;
    const field = image ? item.image_item : item.file_item;
    const name = safeName(image ? 'image' : field?.file_name);
    const ext = image ? '' : extension(name);
    const kind = image ? 'image' : extKinds[ext];
    const declaredSize = validSize(image ? field?.mid_size : field?.len);
    const imageSizes = image ? Object.fromEntries(['mid_size', 'hd_size', 'thumb_size']
      .map(name => [name, validSize(field?.[name])]).filter(([, size]) => size !== null)) : null;
    // Image variant metadata does not identify the bytes returned by media.
    // Enforce the image limit on the actual download and decrypted content.
    const oversized = !image && declaredSize > MAX_ATTACHMENT_BYTES;
    const ref = source(field, image);
    const hasRef = Boolean(field?.media?.encrypt_query_param || field?.media?.full_url);
    if (!ref && !hasRef) continue;
    entries.push({ id: `att_${entries.length}`, name, kind: kind || 'unsupported', extension: ext, declaredSize,
      declaredSizeKind: image ? 'variant_metadata' : 'plaintext',
      ...(image ? { imageSizes } : {}),
      status: !kind || oversized || !ref ? 'failed' : 'pending',
      ...(!kind || oversized || !ref ? { failure: !kind ? 'unsupported_type' : oversized ? 'size_limit' : 'invalid_media_reference' } : { source: ref }),
      attempts: 0, nextAt: 0 });
  }
  if (raw.item_list.filter((item) => item?.type === 2 || item?.type === 4).length > 8) {
    entries.push({ id: 'att_overflow', name: 'additional attachments', kind: 'unsupported', status: 'failed',
      failure: 'too_many_attachments', attempts: 0, nextAt: 0 });
  }
  return entries;
}
export function publicAttachment(value, includePath = false) {
  return { id: value.id, name: value.name, kind: value.kind, status: value.status,
    ...(value.quoteId ? { quoteId: value.quoteId } : {}),
    ...(value.mime ? { mime: value.mime } : {}), ...(value.size ? { size: value.size } : {}),
    ...(value.failure ? { failure: value.failure } : {}), ...(includePath && value.status === 'ready' ? { path: value.path, sha256: value.sha256,
      ...(value.sourceRequestId ? { sourceRequestId: value.sourceRequestId, sourceAttachmentId: value.sourceAttachmentId } : {}) } : {}) };
}
function mediaUrl(ref) {
  const raw = ref.fullUrl || (ref.query ? `${CDN}?encrypted_query_param=${encodeURIComponent(ref.query)}` : '');
  let url;
  try { url = new URL(raw); } catch { fail('invalid_media_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'cdn.weixin.qq.com' || url.hostname.endsWith('.cdn.weixin.qq.com')) ||
      url.hash || !url.pathname.startsWith('/c2c/')) fail('untrusted_media_url');
  return url;
}
function parseKey(ref) {
  if (!ref.key) return null;
  if (ref.hexKey) {
    if (!/^[a-f0-9]{32}$/i.test(ref.key)) fail('invalid_media_key');
    return Buffer.from(ref.key, 'hex');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ref.key)) fail('invalid_media_key');
  const decoded = Buffer.from(ref.key, 'base64');
  if (decoded.toString('base64') !== ref.key) fail('invalid_media_key');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f0-9]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  fail('invalid_media_key');
}
const dnsCache = new Map();
export async function publicMediaDns(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached?.until > Date.now()) return cached.addresses;
  // Fixed public resolver, normal local routing and verified HTTPS certificate.
  // Only the validated CDN hostname is sent; never a media URL or its secrets.
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname); url.searchParams.set('type', 'A');
  const value = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', timeout: 12_000, headers: { Accept: 'application/dns-json' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new MediaError('media_dns_unavailable', true)); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 65_536) req.destroy(new MediaError('media_dns_invalid')); else chunks.push(chunk); });
      response.on('error', () => reject(new MediaError('media_dns_unavailable', true)));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new MediaError('media_dns_invalid')); }
      });
    });
    req.on('timeout', () => req.destroy(new MediaError('media_dns_unavailable', true)));
    req.on('error', error => reject(error instanceof MediaError ? error : new MediaError('media_dns_unavailable', true)));
    req.end();
  });
  if (value.Status !== 0 || value.TC || !value.Question?.some(q => q.type === 1 && q.name.replace(/\.$/, '') === hostname) ||
      !Array.isArray(value.Answer) || value.Answer.length > 64) fail('media_dns_invalid');
  const answers = value.Answer.filter(a => a.type === 1);
  const addresses = answers.map(a => ({ address: a.data, family: 4 }));
  if (!addresses.length || addresses.some(a => !publicIp(a.address))) fail('unsafe_media_host');
  const ttl = Math.max(1, Math.min(300, ...answers.map(a => Number(a.TTL) || 1)));
  dnsCache.set(hostname, { addresses, until: Date.now() + ttl * 1000 });
  return addresses;
}
export async function resolveMediaHost(raw, { resolver = lookup, publicResolver = publicMediaDns } = {}) {
  const url = mediaUrl({ fullUrl: raw });
  let addresses;
  try { addresses = await resolver(url.hostname, { all: true }); }
  catch { fail('media_dns_unavailable', true); }
  if (Array.isArray(addresses) && addresses.length && addresses.every(a => /^198\.(18|19)\./.test(a.address))) {
    addresses = await publicResolver(url.hostname);
  }
  // Keep private/loopback rejection and address pinning. Fake-IP addresses
  // themselves are never accepted as a CDN destination.
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => !publicIp(a.address))) fail('unsafe_media_host');
  return { url, address: addresses[0] };
}
export async function fetchCdn(ref, maxBytes, { resolver = lookup, publicResolver = publicMediaDns } = {}) {
  const url = mediaUrl(ref);
  const { address } = await resolveMediaHost(url.toString(), { resolver, publicResolver });
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', timeout: 30_000, servername: url.hostname,
      lookup: pinnedLookup(address) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new MediaError('media_http_error', response.statusCode >= 500 || response.statusCode === 429)); return; }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { req.destroy(new MediaError('size_limit')); return; }
      const chunks = []; let total = 0;
      response.on('data', (chunk) => { total += chunk.length; if (total > maxBytes) req.destroy(new MediaError('size_limit')); else chunks.push(chunk); });
      response.on('end', () => {
        if (!response.complete || Number.isFinite(declared) && declared !== total) reject(new MediaError('incomplete_media_download', true));
        else resolve(Buffer.concat(chunks));
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new MediaError('media_timeout', true)));
    req.on('error', (error) => reject(error instanceof MediaError ? error : new MediaError('media_transport_error', true)));
    req.end();
  });
}
function zipEntries(bytes) {
  let at = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  }
  if (at < 0 || at + 22 > bytes.length) fail('invalid_document_signature');
  const count = bytes.readUInt16LE(at + 10), size = bytes.readUInt32LE(at + 12), offset = bytes.readUInt32LE(at + 16);
  if (count > 5000 || offset + size > at) fail('invalid_document_signature');
  const names = new Set(); let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > at || bytes.readUInt32LE(p) !== 0x02014b50) fail('invalid_document_signature');
    const len = bytes.readUInt16LE(p + 28), extra = bytes.readUInt16LE(p + 30), comment = bytes.readUInt16LE(p + 32);
    if (p + 46 + len + extra + comment > at) fail('invalid_document_signature');
    const local = bytes.readUInt32LE(p + 42);
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) fail('invalid_document_signature');
    const localLen = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    if (local + 30 + localLen + localExtra > offset || localLen !== len ||
        !bytes.subarray(local + 30, local + 30 + localLen).equals(bytes.subarray(p + 46, p + 46 + len))) fail('invalid_document_signature');
    names.add(bytes.toString('utf8', p + 46, p + 46 + len)); p += 46 + len + extra + comment;
  }
  return names;
}
export function inspectContent(bytes, attachment) {
  const max = attachment.kind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  if (!bytes.length || bytes.length > max) fail('size_limit');
  const declared = attachment.declaredSize;
  if (declared && (attachment.kind !== 'image' || attachment.declaredSizeKind === 'plaintext') && bytes.length !== declared) {
    sizeMismatch({ stage: 'plaintext', declaredSize: declared, plaintextSize: bytes.length });
  }
  let ext = attachment.extension;
  if (attachment.kind === 'image') {
    // Inbound JPEGs may carry data after EOI. The content reader fully decodes
    // pixels before model submission, so EOI need not be the final two bytes.
    ext = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png' :
      bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) && bytes.lastIndexOf(Buffer.from('ffd9', 'hex')) >= 3 ? '.jpg' :
      bytes.toString('ascii', 0, 6).match(/^GIF8[79]a$/) ? '.gif' :
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? '.webp' : '';
    if (!ext) fail('invalid_image_signature');
  } else if (ext === '.pdf') {
    if (bytes.toString('ascii', 0, 5) !== '%PDF-' || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'))) fail('invalid_document_signature');
  } else if (ext === '.docx' || ext === '.xlsx') {
    const names = zipEntries(bytes);
    if (!names.has('[Content_Types].xml') || !names.has(ext === '.docx' ? 'word/document.xml' : 'xl/workbook.xml') ||
        [...names].some((name) => /(^|\/)vbaProject\.bin$/i.test(name))) fail('invalid_document_signature');
  } else if (ext === '.doc' || ext === '.xls') {
    if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) ||
        !bytes.includes(Buffer.from(ext === '.doc' ? 'WordDocument' : 'Workbook', 'utf16le'))) fail('invalid_document_signature');
  } else if (attachment.kind === 'text') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid_text_encoding'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('invalid_text_content');
  } else fail('unsupported_type');
  if (attachment.extension && attachment.kind === 'image' && attachment.extension !== ext && !(attachment.extension === '.jpeg' && ext === '.jpg')) fail('type_mismatch');
  return { extension: ext, mime: mime[ext] };
}
export async function downloadAttachment(attachment, { fetchImpl = fetchCdn } = {}) {
  const max = attachment.kind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  const ref = attachment.source;
  const ciphertext = await fetchImpl(ref, max + (ref.key ? 16 : 0));
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length > max + 16) fail('size_limit');
  const key = parseKey(ref);
  let bytes = ciphertext;
  if (key) {
    if (!ciphertext.length || ciphertext.length % 16) fail('invalid_ciphertext');
    try { const cipher = createDecipheriv('aes-128-ecb', key, null); bytes = Buffer.concat([cipher.update(ciphertext), cipher.final()]); }
    catch { fail('decryption_failed'); }
  }
  const type = inspectContent(bytes, attachment);
  return { bytes, ...type, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) fail('unsafe_storage_directory');
}
export async function saveAttachment(statePath, requestId, attachment, result) {
  if (!/^wx_[a-f0-9]{32}$/.test(requestId) || !/^att_[0-7]$/.test(attachment.id)) fail('invalid_storage_id');
  await privateDirectory(dirname(statePath));
  const root = join(dirname(statePath), 'attachments');
  await privateDirectory(root);
  const dir = join(root, requestId);
  await privateDirectory(dir);
  const path = join(dir, `${attachment.id}${result.extension}`);
  let file;
  let created = false;
  try {
    file = await open(path, 'wx', 0o600);
    created = true;
    await file.writeFile(result.bytes); await file.sync(); await file.close(); file = null;
  } catch (error) {
    await file?.close().catch(() => {});
    if (error.code !== 'EEXIST') { if (created) await unlink(path).catch(() => {}); throw error; }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size !== result.bytes.length ||
        createHash('sha256').update(await readFile(path)).digest('hex') !== result.sha256) fail('storage_collision');
  }
  return path;
}

