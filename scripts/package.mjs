import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { zipSync, unzipSync, strFromU8 } from 'fflate';

const entries = {};
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const selected = ['extension', 'dist', 'src', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json', 'plugin.json', 'mcp.json', '.gitignore', '.gitattributes', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'THIRD-PARTY-LICENSES.txt', 'setup.cmd', 'install-codex.cmd', 'uninstall.cmd', 'eslint.config.mjs', 'knip.json'];
async function add(path) {
  let directory;
  try { directory = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOTDIR') throw error; entries[relative('.', path).replaceAll('\\', '/')] = new Uint8Array(await readFile(path)); return; }
  for (const item of directory) { if (item.isSymbolicLink()) throw new Error('Unexpected symbolic link.'); await add(join(path, item.name)); }
}
for (const path of selected) await add(path);
for (const name of Object.keys(entries)) if (/node_modules|connection-key|\.runtime|profile-|test-artifacts|\.log$/.test(name)) throw new Error(`Unexpected file: ${name}`);
for (const file of ['plugin.json', 'mcp.json', 'extension/manifest.json', 'package.json']) {
  const metadata = JSON.parse(strFromU8(entries[file]));
  if (metadata.version && metadata.version !== version) throw new Error(`Version mismatch: ${file}`);
}
const extensionEntries = Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith('extension/')).map(([name, data]) => [name.slice(10), data]));
const zipOptions = { level: 9, mtime: new Date(2026, 0, 1) };
const xpi = zipSync(extensionEntries, zipOptions);
await mkdir('artifacts', { recursive: true });
const xpiPath = resolve(`artifacts/Firefox-Bridge-${version}.xpi`);
await writeFile(xpiPath, xpi);
const archive = zipSync(Object.fromEntries(Object.entries(entries).map(([name, data]) => [`firefox-bridge/${name}`, data])), zipOptions);
const archivePath = resolve(`artifacts/Firefox-Bridge-${version}.zip`); await writeFile(archivePath, archive);
const checked = unzipSync(await readFile(archivePath));
if (Object.keys(checked).length !== Object.keys(entries).length) throw new Error('ZIP file count mismatch.');
const manifest = JSON.parse(strFromU8(checked['firefox-bridge/extension/manifest.json']));
for (const file of [...manifest.background.scripts, manifest.browser_action.default_popup, 'panel.js', 'panel.css', 'icon.svg']) if (!extensionEntries[file]) throw new Error(`Missing packaged asset: ${file}`);
await writeFile('artifacts/SHA256SUMS', [[`Firefox-Bridge-${version}.zip`, archive], [`Firefox-Bridge-${version}.xpi`, xpi]].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n');
process.stdout.write(JSON.stringify({ archivePath, xpiPath, files: Object.keys(checked).length, zipBytes: archive.length, xpiBytes: xpi.length, unsigned: true }) + '\n');
