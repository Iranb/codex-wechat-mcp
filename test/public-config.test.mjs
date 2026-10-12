import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildAgent, agentXml, SERVICE_PREFIX } from '../src/service.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
test('user service plan is generic, escapes paths and never installs in dry-run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cwx-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state.json');
  const { stdout } = await run(process.execPath, ['src/service.mjs', 'install', '--dry-run'],
    { cwd: root, env: { ...process.env, CODEX_WECHAT_STATE: state, CODEX_WECHAT_BINDING: join(dir, 'binding.json') } });
  const plan = JSON.parse(stdout); assert.equal(plan.dryRun, true);
  assert.equal(plan.config.stateDir, dir); assert.equal(plan.agents.length, 2);
  assert.equal(plan.agents[0].Label, SERVICE_PREFIX + '.poller');
  await assert.rejects(access(join(dir, 'app')));
  const agent = buildAgent('controller', { appDir: '/tmp/a&b', stateDir: '/tmp/private', node: process.execPath });
  assert.ok(agentXml(agent).includes('a&amp;b')); assert.equal(agent.RunAtLoad, true); assert.equal(agent.ThrottleInterval, 30);
});

test('README entry point helpers have no-login help and reject placeholder session IDs before network calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cwx-help-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const script of ['configure.mjs', 'service.mjs', 'list.mjs']) {
    const { stdout } = await run(process.execPath, ['src/' + script, '--help'], { cwd: root });
    assert.ok(stdout.includes('Usage:'));
  }
  await assert.rejects(run(process.execPath, ['src/configure.mjs', '--thread', 'YOUR_EXISTING_CODEX_THREAD_ID', '--model', 'YOUR_MODEL_ID'],
    { cwd: root, env: { ...process.env, CODEX_WECHAT_STATE: join(dir, 'state.json') } }), error => error.stderr.includes('invalid_binding'));
  await assert.rejects(access(join(dir, 'native-codex.json')));
});
