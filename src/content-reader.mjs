import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pythonExecutable, pdfExecutable } from './settings.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./content-reader.py', import.meta.url));
export async function readAttachmentContent(value) {
  try {
    const { stdout } = await run(pythonExecutable(), [script, value.path, value.kind, value.sha256],
      { timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, CODEX_WECHAT_PDFTOPPM: pdfExecutable() } });
    const result = JSON.parse(stdout);
    if (!['ready', 'failed'].includes(result.status)) throw new Error('invalid_content_result');
    if (result.status === 'failed' && !/^[a-z_]+$/.test(result.failure || '')) throw new Error('invalid_content_failure');
    return result;
  } catch { return { status: 'failed', failure: 'content_reader_unavailable_or_timeout' }; }
}
