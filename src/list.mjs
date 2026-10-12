import { NativeClient } from './native-client.mjs';

const action = process.argv[2];
if (!['sessions', 'models'].includes(action) || process.argv.includes('--help')) {
  process.stdout.write('Usage: node src/list.mjs sessions|models\nLists local account metadata only; does not submit model turns.\n');
} else {
  let client;
  try {
    client = await NativeClient.open({ experimentalApi: true });
    if (action === 'sessions') {
      const result = await client.request('thread/list', { limit: 20, sortKey: 'updated_at' });
      process.stdout.write(JSON.stringify({ sessions: result.data.map(t => ({ id: t.id, name: t.name || null, model: t.model || null })), more: !!result.nextCursor }) + '\n');
    } else {
      const result = await client.request('model/list', { includeHidden: true, limit: 100 });
      process.stdout.write(JSON.stringify({ models: result.data.map(m => ({ model: m.model, name: m.displayName })), more: !!result.nextCursor }) + '\n');
    }
  } finally { await client?.closeAndWait(); }
}
