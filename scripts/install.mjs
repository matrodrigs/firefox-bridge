import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = resolve('dist/mcp.cjs');
if (!existsSync(entry)) throw new Error('Compiled bridge not found. Extract the complete package before installing.');
let codex = process.env.CODEX_CLI_PATH;
if (!codex || !existsSync(codex)) {
  const found = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true });
  codex = found.stdout?.trim().split(/\r?\n/)[0];
}
if (!codex || !existsSync(codex)) throw new Error('Codex CLI was not found in this user environment. Install it or open the Codex terminal, then try again.');
const existing = spawnSync(codex, ['mcp', 'get', 'firefox-bridge', '--json'], { encoding: 'utf8', windowsHide: true });
if (existing.status === 0) {
  const config = JSON.parse(existing.stdout);
  if (!config.transport?.args?.some(arg => resolve(arg) === entry)) throw new Error('Another MCP server named firefox-bridge already exists. Its configuration was preserved.');
}
const remove = process.argv.includes('--remove');
if (remove && existing.status !== 0) { process.stdout.write('Firefox Bridge is not registered.\n'); }
else if (!remove && existing.status === 0) { process.stdout.write('Firefox Bridge is already registered at this path.\n'); }
else {
  const args = remove ? ['mcp', 'remove', 'firefox-bridge'] : ['mcp', 'add', 'firefox-bridge', '--', process.execPath, entry];
  const result = spawnSync(codex, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'MCP setup failed.');
  process.stdout.write(result.stdout);
}
if (!remove) process.stdout.write(`\nNext steps:\n1. Run setup.cmd once to register the native connection.\n2. Install Fox Bridge in Firefox.\n3. Fox Bridge connects automatically through the native host.\n4. Enable access and review site permissions in the extension panel.\n5. Use the firefox_* tools in Codex. Open a new chat if they do not appear.\n\nKeep this folder in place while the MCP server is installed.\n`);
