import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';

const entries = {};
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const version = metadata.version;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--signed-xpi')) throw new Error('Usage: npm run package -- [--signed-xpi <path>]');
const providedXpi = args[1];
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
let xpi = zipSync(extensionEntries, zipOptions);
if (providedXpi) {
  xpi = await readFile(providedXpi);
  const providedEntries = unzipSync(xpi);
  const applicationFiles = Object.keys(providedEntries).filter(name => !name.startsWith('META-INF/'));
  if (!providedEntries['META-INF/mozilla.rsa'] || !providedEntries['META-INF/manifest.mf']) throw new Error('The provided XPI has no signature metadata.');
  if (applicationFiles.length !== Object.keys(extensionEntries).length) throw new Error('The provided XPI has different application files.');
  for (const name of applicationFiles) {
    if (!extensionEntries[name]) throw new Error(`Unexpected XPI file: ${name}`);
    const matches = name === 'manifest.json'
      ? isDeepStrictEqual(JSON.parse(strFromU8(providedEntries[name])), JSON.parse(strFromU8(extensionEntries[name])))
      : Buffer.from(providedEntries[name]).equals(Buffer.from(extensionEntries[name]));
    if (!matches) throw new Error(`The provided XPI differs from this build: ${name}`);
  }
}
await mkdir('artifacts', { recursive: true });
const xpiName = `Fox-Bridge-${version}${providedXpi ? '' : '-unsigned'}.xpi`;
const xpiPath = resolve('artifacts', xpiName);
await writeFile(xpiPath, xpi);
const archive = zipSync(Object.fromEntries(Object.entries(entries).map(([name, data]) => [`firefox-bridge/${name}`, data])), zipOptions);
const archivePath = resolve(`artifacts/Firefox-Bridge-${version}-dev.zip`); await writeFile(archivePath, archive);
const checked = unzipSync(await readFile(archivePath));
if (Object.keys(checked).length !== Object.keys(entries).length) throw new Error('ZIP file count mismatch.');
const manifest = JSON.parse(strFromU8(checked['firefox-bridge/extension/manifest.json']));
for (const file of [...manifest.background.scripts, manifest.browser_action.default_popup, 'panel.js', 'panel.css', 'icon.svg']) if (!extensionEntries[file]) throw new Error(`Missing packaged asset: ${file}`);
const sourceEntries = Object.fromEntries(Object.entries(entries).filter(([name]) => !name.startsWith('dist/') && !['extension/background.js', 'extension/panel.js'].includes(name)).map(([name, data]) => [`firefox-bridge/${name}`, data]));
const sources = zipSync(sourceEntries, zipOptions);
const sourcePath = resolve(`artifacts/Firefox-Bridge-${version}-source.zip`);
await writeFile(sourcePath, sources);
const runtimeFiles = new Set([
  'dist/mcp.cjs', 'dist/broker.cjs', 'dist/native-host.cjs',
  'src/native-registration.mjs', 'src/runtime.mjs', 'src/version.mjs',
  'scripts/setup.mjs', 'scripts/install.mjs', 'scripts/install-plugin.mjs', 'scripts/doctor.mjs',
  'plugin.json', 'mcp.json', 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md',
  'LICENSE', 'THIRD-PARTY-LICENSES.txt', 'setup.cmd', 'install-codex.cmd', 'uninstall.cmd'
]);
for (const file of runtimeFiles) if (!entries[file]) throw new Error(`Missing runtime file: ${file}`);
const runtimeEntries = Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith('docs/') || runtimeFiles.has(name)).map(([name, data]) => [`firefox-bridge/${name}`, data]));
runtimeEntries['firefox-bridge/package.json'] = strToU8(JSON.stringify({
  name: metadata.name, version, private: true, type: 'module', engines: metadata.engines,
  scripts: { start: 'node dist/mcp.cjs', setup: 'node scripts/setup.mjs', doctor: 'node scripts/doctor.mjs' },
  description: metadata.description, license: metadata.license, repository: metadata.repository
}, null, 2) + '\n');
const runtime = zipSync(runtimeEntries, zipOptions);
const runtimePath = resolve(`artifacts/Firefox-Bridge-${version}.zip`);
await writeFile(runtimePath, runtime);
const distributions = [[`Firefox-Bridge-${version}.zip`, runtime], [xpiName, xpi], [`Firefox-Bridge-${version}-source.zip`, sources]];
if (!providedXpi) distributions.push([`Firefox-Bridge-${version}-dev.zip`, archive]);
await writeFile('artifacts/SHA256SUMS', distributions.map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n');
process.stdout.write(JSON.stringify({ runtimePath, archivePath, xpiPath, sourcePath, files: Object.keys(checked).length, runtimeFiles: Object.keys(runtimeEntries).length, runtimeBytes: runtime.length, zipBytes: archive.length, xpiBytes: xpi.length, extensionSource: providedXpi ? 'provided' : 'built' }) + '\n');
