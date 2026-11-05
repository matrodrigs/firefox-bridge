import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

await mkdir('dist', { recursive: true });
const results = await Promise.all([
  build({ entryPoints: ['src/background.mjs'], bundle: true, outfile: 'extension/background.js', format: 'iife', target: 'firefox142', legalComments: 'none' }),
  build({ entryPoints: ['src/panel.mjs'], bundle: true, outfile: 'extension/panel.js', format: 'iife', target: 'firefox142', legalComments: 'none' }),
  build({ entryPoints: ['src/mcp.mjs'], bundle: true, outfile: 'dist/mcp.cjs', platform: 'node', format: 'cjs', target: 'node22', legalComments: 'none', metafile: true }),
  build({ entryPoints: ['src/broker-main.mjs'], bundle: true, outfile: 'dist/broker.cjs', platform: 'node', format: 'cjs', target: 'node22', legalComments: 'none' }),
  build({ entryPoints: ['src/native-host.mjs'], bundle: true, outfile: 'dist/native-host.cjs', platform: 'node', format: 'cjs', target: 'node22', legalComments: 'none' })
]);
const packages = new Set();
for (const file of Object.keys(results[2].metafile.inputs)) {
  const normalized = file.replaceAll('\\', '/'); const index = normalized.lastIndexOf('node_modules/');
  if (index < 0) continue;
  const parts = normalized.slice(index + 13).split('/');
  packages.add(normalized.slice(0, index + 13) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/'));
}
const notices = ['Third-party packages bundled in dist/mcp.cjs.\nOriginal application code: see LICENSE.\n'];
for (const directory of [...packages].sort()) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  notices.push(`\n${'='.repeat(72)}\n${metadata.name} ${metadata.version}\nLicense: ${metadata.license}\n`);
  const files = (await readdir(directory)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
  if (!files.length) throw new Error(`License not found: ${metadata.name}`);
  for (const file of files) notices.push(await readFile(join(directory, file), 'utf8'));
}
await writeFile('THIRD-PARTY-LICENSES.txt', notices.join('\n'));
process.stdout.write('Extension, MCP server and native host built.\n');
