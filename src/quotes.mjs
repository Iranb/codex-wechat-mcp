import { createHash } from 'node:crypto';
import { normalizeAttachments } from './media.mjs';

export const QUOTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_QUOTE_RECORDS = 2000;
const MAX_QUOTE_CHARS = 16000;

export function messageId(value) {
  if (typeof value === 'string' && value.length <= 256) return value;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
}

// iLink sends uint64 identifiers as JSON numbers as well as strings.
export function parseWechatJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (!['message_id', 'msg_id', 'svr_id'].includes(key) || typeof value !== 'number') return value;
    if (context?.source && /^\d+$/.test(context.source)) return context.source;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    throw new Error('wechat_message_id_precision');
  });
}

const cacheKey = (state, userId, id) => JSON.stringify([state.account?.accountId, userId, id]);

export function pruneQuoteMessages(state, now) {
  const records = Object.entries(state.quoteMessages || {});
  for (const [key, record] of records) {
    if (now - record.at >= QUOTE_RETENTION_MS) delete state.quoteMessages[key];
  }
  const retained = Object.entries(state.quoteMessages || {});
  if (retained.length > MAX_QUOTE_RECORDS) {
    retained.sort((a, b) => a[1].at - b[1].at);
    for (const [key] of retained.slice(0, retained.length - MAX_QUOTE_RECORDS)) delete state.quoteMessages[key];
  }
}

export function rememberQuoteMessage(state, { userId, id, text = '', requestId }, now) {
  id = messageId(id);
  if (!id || userId !== state.account?.boundUserId) return;
  state.quoteMessages ||= {};
  state.quoteMessages[cacheKey(state, userId, id)] = { at: now, text, ...(requestId ? { requestId } : {}) };
  pruneQuoteMessages(state, now);
}

function historicalMessage(state, userId, id, now) {
  if (!state || userId !== state.account?.boundUserId || !id) return null;
  const cached = state.quoteMessages?.[cacheKey(state, userId, id)];
  // Existing incoming records use this account-scoped request key.
  const requestId = cached?.requestId || `wx_${createHash('sha256')
    .update(`${state.account.accountId}\0${userId}\0${id}`).digest('hex').slice(0, 32)}`;
  const request = state.requests?.[requestId];
  const validRequest = request?.userId === userId && request.messageId === id &&
    now - request.createdAt < QUOTE_RETENTION_MS && !request.skippedReason;
  const validCache = cached && now - cached.at < QUOTE_RETENTION_MS;
  if (!validRequest && !validCache) return null;
  return { requestId, text: validCache ? cached.text : request.text || '',
    attachments: validRequest ? (request.attachments || []).filter(item => !item.quoteId) : [] };
}

function occurrence(text, part, index, from = 0) {
  if (!part || !Number.isInteger(index) || index < 0) return -1;
  let found = from;
  for (let i = 0; i <= index; i++) {
    found = text.indexOf(part, found);
    if (found < 0) return -1;
    if (i < index) found += part.length;
  }
  return found;
}

function selectedText(text, partial) {
  if (typeof partial.start !== 'string' || typeof partial.end !== 'string') return null;
  const start = occurrence(text, partial.start, partial.startindex);
  if (start < 0) return null;
  // The protocol has global and start-relative end occurrence indexes.
  for (const from of [0, start + partial.start.length]) {
    const end = occurrence(text, partial.end, partial.endindex, from);
    if (end < start) continue;
    const selected = text.slice(start, end + partial.end.length);
    if (!partial.quotemd5 || (typeof partial.quotemd5 === 'string' &&
        createHash('md5').update(selected).digest('hex') === partial.quotemd5.toLowerCase())) return selected;
  }
  return null;
}

export function normalizeQuotes(raw, attachments, { media = false, state, now = Date.now() } = {}) {
  const quotes = [];
  let remaining = MAX_QUOTE_CHARS;
  for (const item of (raw.item_list || []).slice(0, 32)) {
    const ref = item?.ref_msg;
    if (!ref || typeof ref !== 'object') continue;
    const id = `quote_${quotes.length}`;
    const referenced = ref.message_item;
    let text = referenced?.type === 1 ? referenced.text_item?.text : referenced?.type === 3 ? referenced.voice_item?.text : '';
    if (typeof text !== 'string') text = '';
    let quotedAttachments = media && referenced ? normalizeAttachments({ message_type: 1, item_list: [referenced] }) : [];
    let source = 'embedded', origin;
    if (!text.trim() && !quotedAttachments.some(attachment => attachment.status !== 'failed')) {
      origin = historicalMessage(state, raw.from_user_id, messageId(ref.svr_id), now);
      if (origin) {
        source = 'history'; text = origin.text;
        quotedAttachments = media ? origin.attachments : [];
      }
    }
    const quote = { id, status: 'ready', source,
      ...(typeof ref.title === 'string' && ref.title ? { title: ref.title.slice(0, 512) } : {}) };
    if (ref.partial_text) {
      const selected = selectedText(text, ref.partial_text);
      quote.partial = true;
      if (selected === null) {
        text = ''; quotedAttachments = [];
        quote.failure = 'partial_quote_unresolved';
      } else text = selected;
    }
    if (text) {
      quote.text = text.slice(0, remaining);
      remaining -= quote.text.length;
      if (quote.text.length !== text.length) quote.truncated = true;
    }
    const attachmentIds = [];
    for (const attachment of quotedAttachments) {
      const next = attachments.filter(value => /^att_[0-7]$/.test(value.id)).length;
      if (next >= 8) { quote.failure = 'quote_attachment_limit'; break; }
      const copy = { ...structuredClone(attachment), id: `att_${next}`, quoteId: id };
      if (origin && copy.status === 'ready') {
        copy.sourceRequestId = origin.requestId;
        copy.sourceAttachmentId = attachment.id;
      }
      attachments.push(copy); attachmentIds.push(copy.id);
    }
    if (attachmentIds.length) quote.attachmentIds = attachmentIds;
    const hasMedia = attachments.some(value => value.quoteId === id && value.status !== 'failed');
    if (!quote.text && !hasMedia) {
      quote.status = 'unavailable';
      quote.failure ||= quotedAttachments.find(value => value.failure)?.failure || 'quote_content_unavailable';
    } else if (quote.failure || quote.truncated) quote.status = 'partial';
    quotes.push(quote);
  }
  return quotes;
}
