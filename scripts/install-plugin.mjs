import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';

const root = resolve('.');
const userRoot = process.env.USERPROFILE;
if (!userRoot) throw new Error('Could not identify the current Windows user profile.');
const staging = resolve('../firefox-bridge-plugin');
const sourcePath = relative(userRoot, staging).replaceAll('\\', '/');
if (sourcePath.startsWith('..') || sourcePath.includes(':')) throw new Error('This personal installer requires the plugin source to be inside the user profile.');
let codex = process.env.CODEX_CLI_PATH;
if (!codex || !existsSync(codex)) codex = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
if (!codex || !existsSync(codex)) throw new Error('Codex CLI was not found in this user environment.');
const remove = process.argv.includes('--remove');
if (remove) {
  const result = spawnSync(codex, ['plugin', 'remove', 'firefox-bridge@personal'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Failed to remove the plugin.');
  process.stdout.write(result.stdout); process.exit(0);
}
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const listed = spawnSync(codex, ['plugin', 'list', '--marketplace', 'personal', '--json'], { encoding: 'utf8', windowsHide: true });
if (listed.status === 0 && JSON.parse(listed.stdout).installed?.some(plugin => plugin.pluginId === 'firefox-bridge@personal' && plugin.version === manifest.version && plugin.enabled)) {
  const cache = join(process.env.CODEX_HOME || join(userRoot, '.codex'), 'plugins', 'cache', 'personal', 'firefox-bridge', manifest.version);
  let identical = false;
  try {
    identical = (await Promise.all(['plugin.json', 'mcp.json', 'dist/mcp.cjs', 'dist/broker.cjs'].map(async file => {
      const [source, installed] = await Promise.all([readFile(join(root, file)), readFile(join(cache, file))]);
      return source.equals(installed);
    }))).every(Boolean);
  } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  if (identical) {
    process.stdout.write(`Firefox Bridge ${manifest.version} is already installed and enabled in Codex.\nSelect the plugin and open Fox Bridge in Firefox.\n`);
    process.exit(0);
  }
}
await mkdir(join(staging, 'dist'), { recursive: true });
for (const file of ['plugin.json', 'mcp.json']) await copyFile(join(root, file), join(staging, file));
for (const file of ['mcp.cjs', 'broker.cjs']) await copyFile(join(root, 'dist', file), join(staging, 'dist', file));
const marketplaceFile = join(userRoot, '.agents', 'plugins', 'marketplace.json');
await mkdir(dirname(marketplaceFile), { recursive: true });
let marketplace;
try { marketplace = JSON.parse(await readFile(marketplaceFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; marketplace = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] }; }
if (marketplace.name !== 'personal' || !Array.isArray(marketplace.plugins)) throw new Error('The personal marketplace has an unsupported format; the file was preserved.');
const entry = marketplace.plugins.find(x => x.name === 'firefox-bridge');
const path = './' + sourcePath;
if (entry && entry.source?.path !== path) {
  if (entry.source?.source !== 'local') throw new Error('An external plugin source already uses this name. Remove that registration before installing this local build.');
  entry.source = { source: 'local', path };
}
if (!entry) marketplace.plugins.push({ name: 'firefox-bridge', source: { source: 'local', path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
await writeFile(marketplaceFile, JSON.stringify(marketplace, null, 2) + '\n');
const result = spawnSync(codex, ['plugin', 'add', 'firefox-bridge@personal', '--json'], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Failed to install the local plugin.');
process.stdout.write(result.stdout + '\n');
const old = spawnSync(codex, ['mcp', 'get', 'firefox-bridge', '--json'], { encoding: 'utf8', windowsHide: true });
if (old.status === 0) {
  const config = JSON.parse(old.stdout);
  if (config.transport?.args?.some(arg => resolve(arg) === join(root, 'dist', 'mcp.cjs'))) {
    const removed = spawnSync(codex, ['mcp', 'remove', 'firefox-bridge'], { encoding: 'utf8', windowsHide: true });
    if (removed.status !== 0) throw new Error('The plugin is installed, but the previous MCP entry could not be removed.');
  }
}
process.stdout.write('Firefox Bridge is installed as a personal plugin. Select it in Codex.\nUpdate Fox Bridge after updating the local bridge and keep this folder in place.\n');
