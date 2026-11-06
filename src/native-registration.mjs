import { chmod, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const NATIVE_HOST = 'io.github.matrodrigs.firefox_bridge';
const extensionId = 'firefox-bridge@matrodrigs';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const batchQuote = value => {
  if (/["\r\n]/.test(value)) throw new Error('Unsupported character in installation path.');
  return `"${value.replaceAll('%', '%%')}"`;
};

export function registrationDirectory() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'FirefoxBridge', 'native-hosts');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts');
  return join(homedir(), '.mozilla', 'native-messaging-hosts');
}

export async function registerNativeHost({ root = resolve('.'), name = NATIVE_HOST, environment = {} } = {}) {
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(name)) throw new Error('Invalid native host name.');
  const entry = join(root, 'dist', 'native-host.cjs');
  if (!existsSync(entry)) throw new Error('Runtime files are missing. Extract the complete bridge package.');
  const directory = registrationDirectory();
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, `${name}.json`);
  const launcherPath = join(directory, `${name}.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
  const variables = Object.entries(environment);
  if (variables.some(([key]) => !['FIREFOX_BRIDGE_PORT', 'FIREFOX_BRIDGE_DATA_DIR'].includes(key))) throw new Error('Unsupported native host environment variable.');
  const launcher = process.platform === 'win32'
    ? ['@echo off', 'setlocal DisableDelayedExpansion', ...variables.map(([key, value]) => `set ${batchQuote(`${key}=${value}`)}`), `${batchQuote(process.execPath)} ${batchQuote(entry)} %*`, ''].join('\r\n')
    : ['#!/bin/sh', ...variables.map(([key, value]) => `export ${key}=${shellQuote(value)}`), `exec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"`, ''].join('\n');
  await writeFile(launcherPath, launcher, { mode: 0o700 });
  if (process.platform !== 'win32') await chmod(launcherPath, 0o700);
  await writeFile(manifestPath, JSON.stringify({ name, description: 'Firefox Bridge local connection', path: launcherPath, type: 'stdio', allowed_extensions: [extensionId] }, null, 2) + '\n');
  if (process.platform === 'win32') {
    const result = spawnSync('reg.exe', ['ADD', `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${name}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Native host registration failed.');
  }
  return { manifestPath, launcherPath, name, entry };
}

export async function unregisterNativeHost({ name = NATIVE_HOST } = {}) {
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(name)) throw new Error('Invalid native host name.');
  const manifestPath = join(registrationDirectory(), `${name}.json`);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const launcherPath = join(dirname(manifestPath), `${name}.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
  if (manifest.name !== name || resolve(manifest.path) !== resolve(launcherPath) || manifest.allowed_extensions?.[0] !== extensionId) throw new Error('Unexpected native host registration; files were preserved.');
  if (process.platform === 'win32') {
    const result = spawnSync('reg.exe', ['DELETE', `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${name}`, '/f'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('Could not remove native host registration.');
  }
  await unlink(manifestPath);
  await unlink(launcherPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
