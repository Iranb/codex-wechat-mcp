import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { acquireLock } from './runtime.mjs';
import { readPrivateJson, writePrivateJson } from './native-journal.mjs';
import { localCall } from './local-ipc.mjs';

const RETRYABLE = new Set(['native_thread_active_writer', 'dedicated_thread_not_idle', 'receiver_disconnected',
  'native_disconnected', 'native_server_unavailable', 'native_rpc_unconfirmed', 'native_rpc_rejected', 'native_transport_failed', 'wechat_queue_not_ready']);

export const restartDelay = failures => Math.min(300000, 5000 * 2 ** Math.min(failures, 6));
export function controllerDecision(journal, expected) {
  if (!expected?.threadId || !expected?.model || journal.threadId !== expected.threadId || journal.model !== expected.model || journal.transport !== 'codex-exec' || journal.cliProbe?.stage !== 'completed')
    return { allowed: false, reason: 'original_binding_or_probe_requires_review' };
  if (journal.active && !['claimed', 'prepared'].includes(journal.active.stage))
    return { allowed: false, reason: 'uncertain_request_requires_reconciliation' };
  if (journal.phase === 'awaiting_user') return { allowed: false, reason: 'user_action_required' };
  if (journal.phase === 'paused' && !RETRYABLE.has(journal.pauseReason))
    return { allowed: false, reason: journal.pauseReason || 'controller_requires_review' };
  return { allowed: true };
}
export function receiverReady(status, now = Date.now()) {
  return status?.running && status.mode === 'local-queue' && status.ownerBound && status.accountConfigured &&
    status.normalReceptionActivated && status.receive?.successfulPolls > 0 && !status.receive.lastFailure &&
    now - Date.parse(status.receive.lastSuccessAt) < 120000;
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unsafe_managed_directory');
}
async function lockedProcessAlive(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unsafe_bridge_lock');
    const raw = (await readFile(path, 'utf8')).trim();
    if (!/^[1-9]\d*$/.test(raw)) throw new Error('invalid_bridge_lock');
    try { process.kill(Number(raw), 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function pollerNeedsLogin(path, start) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat(), offset = Math.max(start, info.size - 16384);
    const bytes = Buffer.alloc(Math.max(0, info.size - offset));
    await file.read(bytes, 0, bytes.length, offset);
    return /WeChat session expired|Run login and bind before starting/.test(bytes.toString('utf8'));
  } finally { await file.close(); }
}

export async function runManaged(role, configPath) {
  if (!['poller', 'controller'].includes(role)) throw new Error('invalid_managed_role');
  process.umask(0o077);
  const config = await readPrivateJson(configPath);
  for (const key of ['appDir', 'stateDir', 'node', 'codex', 'python', 'pdftoppm']) {
    if (!isAbsolute(config[key] || '') || config[key].startsWith('/Volumes/')) throw new Error('local_absolute_dependency_required');
    try { if ((await realpath(config[key])).startsWith('/Volumes/')) throw new Error('local_absolute_dependency_required'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await privateDirectory(config.appDir); await privateDirectory(config.stateDir);
  const managedDir = join(config.stateDir, 'launchd'); await privateDirectory(managedDir);
  const journalPath = join(config.stateDir, 'native-codex.json'), socketPath = join(config.stateDir, 'local-queue.sock');
  const statusPath = join(managedDir, role + '-status.json');
  const bridgeLock = role === 'poller' ? join(config.stateDir, 'state.json.lock') : journalPath + '.lock';
  const logPath = join(config.stateDir, role === 'poller' ? 'poller.log' : 'exec-controller.log');
  let release;
  try { release = await acquireLock(join(managedDir, role + '-supervisor')); }
  catch (error) {
    if (error.message === 'another bridge or setup process holds the state lock') {
      process.stdout.write(JSON.stringify({ event: 'duplicate_supervisor_refused', role }) + '\n'); return;
    }
    throw error;
  }
  const abort = new AbortController(); let child = null, killTimer, failures = 0, childStarts = 0;
  const stop = () => {
    abort.abort();
    if (child && child.exitCode == null && child.signalCode == null) {
      const owned = child; owned.kill('SIGTERM');
      killTimer = setTimeout(() => { if (owned.exitCode == null && owned.signalCode == null) owned.kill('SIGKILL'); }, 12000);
    }
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let lastPhase;
  const status = async (phase, extra = {}) => {
    await writePrivateJson(statusPath, { role, supervisorPid: process.pid, childPid: child?.pid || null,
      phase, childStarts, at: new Date().toISOString(), ...extra });
    const key = phase + ':' + (extra.reason || '');
    if (key !== lastPhase) {
      process.stdout.write(JSON.stringify({ event: 'managed_state', role, phase, childPid: child?.pid || null, ...extra }) + '\n'); lastPhase = key;
    }
  };
  const wait = ms => pause(ms, undefined, { signal: abort.signal });
  try {
    while (!abort.signal.aborted) {
      if (await lockedProcessAlive(bridgeLock)) { await status('waiting_existing_process'); await wait(5000); continue; }
      let unavailable = false;
      for (const path of [config.node, config.codex, config.python, config.pdftoppm]) {
        try { await access(path, constants.X_OK); } catch { unavailable = true; }
      }
      if (unavailable) { await status('waiting_local_dependencies'); await wait(30000); continue; }
      if (role === 'controller') {
        const decision = controllerDecision(await readPrivateJson(journalPath), config);
        if (!decision.allowed) {
          await status('blocked', { reason: decision.reason, manualRestartRequired: true });
          // Authentication, approval and uncertain results need human repair.
          // Keep the launchd job alive without repeated model or send attempts.
          await wait(30000); continue;
        }
        let ready = false;
        try { ready = receiverReady(await localCall(socketPath, { command: 'status' }, { signal: AbortSignal.timeout(2000) })); } catch {}
        if (!ready) { await status('waiting_receiver'); await wait(5000); continue; }
      }
      const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      let startBytes, outcome; const started = Date.now();
      try {
        const info = await log.stat();
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('private_managed_log_required');
        startBytes = info.size;
        const script = join(config.appDir, 'src', role === 'poller' ? 'main.mjs' : 'exec.mjs');
        const args = role === 'poller' ? [script, '--live', '--mode', 'local-queue', '--new-only'] : [script, 'run', '--live'];
        child = spawn(config.node, args, { cwd: config.appDir, detached: false, shell: false, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            CODEX_WECHAT_STATE: join(config.stateDir, 'state.json'), CODEX_WECHAT_SOCKET: socketPath,
            CODEX_WECHAT_MODEL: config.model, CODEX_WECHAT_PYTHON: config.python, CODEX_WECHAT_CODEX: config.codex, CODEX_WECHAT_PDFTOPPM: config.pdftoppm } });
        const closed = new Promise(resolveClose => {
          child.once('error', () => {});
          child.once('close', (code, signal) => resolveClose({ code, signal }));
        });
        try { childStarts++; await status('running'); outcome = await closed; }
        catch (error) { stop(); await closed; throw error; }
      } finally { clearTimeout(killTimer); await log.close(); child = null; }
      if (abort.signal.aborted) break;
      if (role === 'poller' && await pollerNeedsLogin(logPath, startBytes)) {
        await status('blocked', { reason: 'wechat_login_required', manualRestartRequired: true });
        while (!abort.signal.aborted) await wait(30000);
      }
      if (Date.now() - started >= 60000) failures = 0;
      const delayMs = restartDelay(failures++);
      await status('backoff', { delayMs, exitCode: outcome.code, exitSignal: outcome.signal });
      await wait(delayMs);
    }
  } catch (error) { if (!abort.signal.aborted) throw error; }
  finally {
    clearTimeout(killTimer); process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await status('stopped'); await release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runManaged(process.argv[2], process.argv[3]).catch(error => {
    process.stderr.write(JSON.stringify({ event: 'managed_supervisor_failed', reason: /^[a-z_]+$/.test(error.message) ? error.message : 'managed_setup_requires_review' }) + '\n');
    process.exitCode = 1;
  });
}
