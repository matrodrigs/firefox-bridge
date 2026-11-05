import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export function firefoxBinary() {
  const candidates = [process.env.FIREFOX_BINARY, ...(process.platform === 'win32' ? ['C:/Program Files/Mozilla Firefox/firefox.exe', 'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'] : process.platform === 'darwin' ? ['/Applications/Firefox.app/Contents/MacOS/firefox'] : ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/opt/firefox/firefox'])].filter(Boolean);
  const binary = candidates.find(existsSync);
  if (!binary) throw new Error('Firefox not found. Set FIREFOX_BINARY to its executable path.');
  return binary;
}

export async function testDirectory() {
  const directory = resolve('test-artifacts/firefox-bridge-validation');
  await mkdir(directory, { recursive: true });
  return directory;
}

export function startFirefox(sourceDir, { profile, startUrl } = {}) {
  const args = ['node_modules/web-ext/bin/web-ext.js', 'run', '--no-config-discovery', '--source-dir', sourceDir, '--firefox', firefoxBinary(), '--no-reload', '--no-input', '--args=-headless'];
  if (profile) args.push('--firefox-profile', profile, '--keep-profile-changes');
  if (startUrl) args.push('--start-url', startUrl);
  const child = spawn(process.execPath, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  child.launchError = null;
  child.on('error', error => { child.launchError = error; });
  return child;
}

export async function stopFirefox(child) {
  child.stdin?.end();
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
