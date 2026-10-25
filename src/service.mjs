import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { access, cp, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { statePath, acquireLock } from './runtime.mjs';
import { readPrivateJson, writePrivateJson } from './native-journal.mjs';
import { bindingSettings, projectDir, findExecutable, codexExecutable, pythonExecutable, pdfExecutable } from './settings.mjs';

const exec = promisify(execFile);
export const SERVICE_PREFIX = 'org.codex-wechat-mcp';
export function buildAgent(role, config) {
  return { Label: `${SERVICE_PREFIX}.${role}`, ProgramArguments: [config.node, join(config.appDir, 'src', 'managed-supervisor.mjs'), role, join(config.stateDir, 'launchd', 'config.json')],
    WorkingDirectory: config.appDir, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, ExitTimeOut: 20,
    AbandonProcessGroup: false, Umask: 63, StandardOutPath: join(config.stateDir, 'launchd', `${role}-supervisor.log`),
    StandardErrorPath: join(config.stateDir, 'launchd', `${role}-supervisor-error.log`),
    EnvironmentVariables: { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' } };
}
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xml(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (typeof value === 'string') return `<string>${escape(value)}</string>`;
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, val]) => `<key>${escape(key)}</key>${xml(val)}`).join('')}</dict>`;
}
export const agentXml = value => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(value)}</plist>\n`;
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('private_service_directory_required');
}
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function lockAlive(path) {
  if (!await exists(path)) return false;
  const text = (await readFile(path, 'utf8')).trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error('invalid_service_lock');
  try { process.kill(Number(text), 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
export function servicePlan() {
  const stateDir = dirname(statePath()), binding = bindingSettings();
  return { ...binding, stateDir, appDir: join(stateDir, 'app'), node: findExecutable('node', 'CODEX_WECHAT_NODE'),
    codex: codexExecutable(), python: pythonExecutable(), pdftoppm: pdfExecutable() };
}
export async function serviceAction(action, { dryRun = false } = {}) {
  if (!['plan', 'install', 'load', 'status', 'stop', 'uninstall'].includes(action)) throw new Error('unknown_service_action');
  const config = servicePlan(), agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  const files = ['poller', 'controller'].map(role => join(agentsDir, `${SERVICE_PREFIX}.${role}.plist`));
  if (action === 'plan' || dryRun) return { action, dryRun: true, config, agents: ['poller', 'controller'].map(role => buildAgent(role, config)) };
  if (process.platform !== 'darwin') throw new Error('launchd_requires_macos');
  const domain = `gui/${process.getuid()}`;
  if (action === 'install') {
    if (!config.threadId || !config.model) throw new Error('configure_existing_session_first');
    const journal = await readPrivateJson(join(config.stateDir, 'native-codex.json'));
    if (journal.threadId !== config.threadId || journal.model !== config.model || journal.cliProbe?.stage !== 'completed' || journal.active) throw new Error('verified_idle_session_required');
    for (const lock of ['state.json.lock', 'native-codex.json.lock']) if (await lockAlive(join(config.stateDir, lock))) throw new Error('stop_manual_bridge_before_install');
    if (await exists(config.appDir) || await exists(files[0]) || await exists(files[1])) throw new Error('existing_service_requires_review');
    if (!isAbsolute(config.stateDir) || (await realpath(config.stateDir)).startsWith('/Volumes/')) throw new Error('local_private_state_required');
    for (const key of ['node', 'codex', 'python', 'pdftoppm']) {
      if (!isAbsolute(config[key]) || (await realpath(config[key])).startsWith('/Volumes/')) throw new Error('local_absolute_dependencies_required');
      await access(config[key], constants.X_OK);
    }
    const release = await acquireLock(join(config.stateDir, 'service-install'));
    try {
      const managed = join(config.stateDir, 'launchd'); await privateDirectory(managed); await privateDirectory(config.appDir);
      await cp(join(projectDir, 'src'), join(config.appDir, 'src'), { recursive: true, errorOnExist: true, force: false });
      for (const name of ['package.json', 'README.md', 'QUOTES.md', 'LICENSE', 'requirements.txt', 'THIRD_PARTY_NOTICES.md'])
        await cp(join(projectDir, name), join(config.appDir, name), { errorOnExist: true, force: false });
      await writePrivateJson(join(managed, 'config.json'), config);
      await mkdir(agentsDir, { recursive: true });
      for (const [i, role] of ['poller', 'controller'].entries()) {
        for (const suffix of ['-supervisor.log', '-supervisor-error.log']) {
          const file = await open(join(managed, role + suffix), 'wx', 0o600); await file.close();
        }
        await writeFile(files[i], agentXml(buildAgent(role, config)), { mode: 0o600, flag: 'wx' });
        await exec('/usr/bin/plutil', ['-lint', files[i]]);
      }
      return { installed: true, loaded: false, statePreserved: true, ...config };
    } finally { await release(); }
  }
  if (action === 'load') {
    for (const file of files) await exec('/bin/launchctl', ['bootstrap', domain, file]);
    return { loaded: true, loginOnly: true };
  }
  if (action === 'status') {
    const result = {};
    for (const role of ['poller', 'controller']) {
      try { result[role] = await readPrivateJson(join(config.stateDir, 'launchd', role + '-status.json')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; result[role] = { loaded: false }; }
    }
    return result;
  }
  for (const role of ['controller', 'poller']) {
    try { await exec('/bin/launchctl', ['bootout', `${domain}/${SERVICE_PREFIX}.${role}`]); }
    catch (e) { if (!/Could not find service|No such process/.test(e.stderr || '')) throw e; }
  }
  if (action === 'uninstall') {
    for (const file of files) {
      if (!await exists(file)) continue;
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('unrecognized_agent_file');
      const text = await readFile(file, 'utf8');
      if (!text.includes(escape(join(config.appDir, 'src', 'managed-supervisor.mjs')))) throw new Error('unrecognized_agent_file');
      await unlink(file);
    }
  }
  return { stopped: true, uninstalled: action === 'uninstall', privateStateDeleted: false };
}

if (process.argv[1]?.endsWith('/service.mjs')) {
  const action = process.argv[2];
  if (!action || process.argv.includes('--help')) process.stdout.write('Usage: node src/service.mjs plan|install|load|status|stop|uninstall [--dry-run]\n');
  else serviceAction(action, { dryRun: process.argv.includes('--dry-run') }).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: /^[a-z_]+$/.test(error.message) ? error.message : 'service_action_failed' }) + '\n'); process.exitCode = 1;
  });
}
