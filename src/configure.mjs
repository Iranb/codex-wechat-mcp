import { dirname, join } from 'node:path';
import { statePath, acquireLock } from './runtime.mjs';
import { bindingPath, projectDir } from './settings.mjs';
import { readPrivateJson, writePrivateJson } from './native-journal.mjs';

export const validThreadId = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value || '');
const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) {
  process.stdout.write('Usage: node src/configure.mjs --thread THREAD_ID --model MODEL_ID\nChoose an existing dedicated Codex session; no new session is created.\n');
} else {
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes('--thread') || !args.includes('--model') || args.length !== 4) throw new Error('explicit_thread_and_model_required');
  const threadId = option('--thread'), model = option('--model');
  if (!validThreadId(threadId) || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(model || '')) throw new Error('invalid_binding');
  process.env.CODEX_WECHAT_MODEL = model;
  const { NativeClient, checkExecWritable } = await import('./native-client.mjs');
  const { NativeJournal } = await import('./native-journal.mjs');
  const path = join(dirname(statePath()), 'native-codex.json');
  const release = await acquireLock(path); let client;
  try {
    let previous;
    try { previous = await readPrivateJson(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && (previous.threadId !== threadId || previous.model !== model || previous.active)) throw new Error('existing_binding_requires_manual_review');
    client = await NativeClient.open({ experimentalApi: true }); await client.requireModel();
    const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
    if (thread.id !== threadId || thread.model !== model) throw new Error('selected_thread_model_mismatch');
    await checkExecWritable({ threadId, cwd: projectDir });
    await writePrivateJson(bindingPath(), { threadId, model });
    if (!previous) {
      const journal = await new NativeJournal(path).load();
      await journal.update(data => { data.threadId = threadId; data.model = model; data.transport = 'codex-exec'; });
    }
    process.stdout.write(JSON.stringify({ configured: true, model, existingSession: true, contextProbeRequired: !previous?.cliProbe }) + '\n');
  } finally { await client?.closeAndWait(); await release(); }
}
