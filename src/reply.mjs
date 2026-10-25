export const MAX_MESSAGE_CHARS = 800;
export const MAX_REPLY_CHARS = 64_000;
// JSON escaping can use six bytes per UTF-16 code unit.
export const REPLY_FRAME_BYTES = MAX_REPLY_CHARS * 6 + 32_768;

export function splitReply(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_REPLY_CHARS) throw new Error('invalid reply text');
  if (text.length <= MAX_MESSAGE_CHARS) return [text];
  const chunks = [];
  const capacity = MAX_MESSAGE_CHARS - 20; // Space for the part number.
  let offset = 0;
  while (offset < text.length) {
    let size = Math.min(capacity, text.length - offset);
    if (offset + size < text.length) {
      const window = text.slice(offset, offset + size);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      if (paragraph >= capacity / 2) size = paragraph + 2;
      else if (line >= capacity / 2) size = line + 1;
      else {
        const breaks = [...window.matchAll(/[。！？.!?](?:\s+|$)|[ \t]+/g)];
        const last = breaks.at(-1);
        if (last && last.index >= capacity / 2) size = last.index + last[0].length;
      }
      const previous = text.charCodeAt(offset + size - 1);
      const next = text.charCodeAt(offset + size);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) size--;
    }
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}
