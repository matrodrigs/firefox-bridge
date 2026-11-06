import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASE_URL, dataDirectory } from '../src/runtime.mjs';
import { VERSION, PROTOCOL_VERSION } from '../src/version.mjs';
import { registrationDirectory, NATIVE_HOST } from '../src/native-registration.mjs';

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });
record('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.version);
const firefoxCandidates = [process.env.FIREFOX_BINARY, ...(process.platform === 'win32' ? ['C:/Program Files/Mozilla Firefox/firefox.exe', 'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'] : process.platform === 'darwin' ? ['/Applications/Firefox.app/Contents/MacOS/firefox'] : ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/opt/firefox/firefox'])].filter(Boolean);
const firefox = firefoxCandidates.find(existsSync);
record('Firefox', Boolean(firefox), firefox || 'Firefox was not found in standard locations. Set FIREFOX_BINARY to its executable path.');
const sourceCheckout = existsSync(resolve('extension/manifest.json'));
const files = ['dist/mcp.cjs', 'dist/broker.cjs', 'dist/native-host.cjs', ...(sourceCheckout ? ['extension/background.js', 'extension/panel.js'] : [])];
for (const file of files) record(file, existsSync(resolve(file)), existsSync(resolve(file)) ? 'present' : 'Extract the complete local bridge package, or rebuild a source checkout.');
for (const file of ['package.json', 'plugin.json', ...(sourceCheckout ? ['extension/manifest.json'] : [])]) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    record(`${file} version`, value.version === VERSION, value.version);
  } catch { record(`${file} version`, false, 'Missing or invalid metadata. Extract the complete local bridge package.'); }
}
let token;
try { token = (await readFile(join(dataDirectory, 'connection-key'), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') record('Local key', false, error.code); }
const hostManifest = join(registrationDirectory(), `${NATIVE_HOST}.json`);
try {
  const manifest = JSON.parse(await readFile(hostManifest, 'utf8'));
  record('Native connection', manifest.name === NATIVE_HOST && existsSync(manifest.path), hostManifest);
} catch { record('Native connection', false, 'Run setup.cmd on Windows, or node scripts/setup.mjs, once for this user.'); }
record('Local runtime', /^[a-f0-9]{64}$/.test(token ?? ''), token ? 'initialized; internal secret omitted' : 'Open Firefox after setup. The runtime initializes automatically.');
if (token) {
  try {
    const response = await fetch(`${BASE_URL}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    record('Broker', response.ok && health.service === 'firefox-bridge' && health.version === VERSION && health.protocolVersion === PROTOCOL_VERSION, response.ok ? `version ${health.version}, protocol ${health.protocolVersion}` : `HTTP ${response.status}`);
    record('Extension connected', health.extensionOnline === true, health.extensionOnline ? 'online' : 'Install and enable Fox Bridge in Firefox. It connects automatically.');
  } catch { record('Broker', false, 'Not reachable. Open Firefox after running setup.'); }
}
process.stdout.write(JSON.stringify({ version: VERSION, endpoint: BASE_URL, checks }, null, 2) + '\n');
if (checks.some(check => !check.ok)) process.exitCode = 1;
