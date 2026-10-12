import { existsSync, lstatSync, readFileSync, accessSync, constants } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statePath } from './runtime.mjs';

export const projectDir = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
export const bindingPath = () => process.env.CODEX_WECHAT_BINDING || join(dirname(statePath()), 'bridge-config.json');
export function bindingSettings() {
  const path = bindingPath();
  if (!existsSync(path)) return {};
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('private_binding_config_required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function modelSetting() {
  const value = process.env.CODEX_WECHAT_MODEL || bindingSettings().model || 'gpt-6-luna';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(value)) throw new Error('invalid_model_setting');
  return value;
}
export function findExecutable(name, override, extraCandidates = []) {
  const explicit = override && process.env[override];
  const candidates = explicit ? [explicit] : [...extraCandidates, ...(process.env.PATH || '').split(':').filter(Boolean).map(folder => join(folder, name))];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { accessSync(candidate, constants.X_OK); if (lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink()) return resolve(candidate); } catch {}
  }
  if (explicit) throw new Error('configured_executable_unavailable');
  // Offline tests can import modules without a logged-in/installed CLI.
  return name;
}
export const pythonExecutable = () => findExecutable('python3', 'CODEX_WECHAT_PYTHON', [join(projectDir, '.venv', 'bin', 'python3')]);
export const pdfExecutable = () => findExecutable('pdftoppm', 'CODEX_WECHAT_PDFTOPPM');
export const codexExecutable = () => findExecutable('codex', 'CODEX_WECHAT_CODEX',
  ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex']);
