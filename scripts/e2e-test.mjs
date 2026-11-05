import { startFirefox, stopFirefox, testDirectory } from './test-support.mjs';
import http from 'node:http';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBroker } from '../src/broker.mjs';
import { TOOLS } from '../src/contract.mjs';
import { registerNativeHost, unregisterNativeHost } from '../src/native-registration.mjs';

const work = await testDirectory(); await mkdir(work, { recursive: true });
const runDir = await mkdtemp(join(work, 'e2e-')); const dir = join(runDir, 'extension'); await cp('extension', dir, { recursive: true });
const token = randomBytes(32).toString('hex'); await writeFile(join(runDir, 'connection-key'), token);
const fixture = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><head><title>Firefox MCP workflow</title></head><body><h1>Complete workflow</h1><label for="name">Name</label><input id="name"><button onclick="document.querySelector(\'h1\').textContent=\'Confirmed\'">Confirm</button></body></html>'); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
let broker = createBroker({ token, port: 0 }); const address = await broker.start();
const brokerOrigin = `http://127.0.0.1:${address.port}`;
const hostName = `io.github.matrodrigs.firefox_bridge_test_${randomBytes(6).toString('hex')}`;
await registerNativeHost({ name: hostName, environment: { FIREFOX_BRIDGE_PORT: String(address.port), FIREFOX_BRIDGE_DATA_DIR: runDir } });
const config = { policy: { enabled: true, defaultBrowse: 'ask', rules: { [origin]: { read: 'allow', interact: 'allow', navigate: 'allow', capture: 'allow' } } } };
const original = (await readFile(join(dir, 'background.js'), 'utf8')).replaceAll('io.github.matrodrigs.firefox_bridge', hostName);
await writeFile(join(dir, 'background.js'), `(async()=>{await browser.storage.local.set(${JSON.stringify(config)});\n${original}\n})();`);
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
manifest.content_security_policy = manifest.content_security_policy.replace('http://127.0.0.1:39281', brokerOrigin);
await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const child = startFirefox(dir);
let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const client = new Client({ name: 'firefox-bridge-e2e', version: '1.0.0' });
const report = { checks: [] };
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result));
  return result;
};
try {
  let connected = false;
  for (let i = 0; i < 100; i++) {
    const health = await (await fetch(`${brokerOrigin}/health`, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (health.extensionOnline) { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!connected) throw new Error('The test extension did not connect to the broker.');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.cjs')], env: { ...process.env, FIREFOX_BRIDGE_DATA_DIR: runDir, FIREFOX_BRIDGE_PORT: String(address.port) }, stderr: 'pipe' }));
  const tools = await client.listTools(); report.checks.push({ name: 'MCP discovers tools', ok: tools.tools.length === TOOLS.length });
  const status = JSON.parse((await call('firefox_status')).content[0].text); report.checks.push({ name: 'Real extension returns status', ok: status.enabled === true });
  const tab = JSON.parse((await call('firefox_open_tab', { url: `${origin}/page` })).content[0].text);
  const resources = await client.listResources();
  const resource = resources.resources.find(item => item.uri === `firefox://tab/${tab.id}`);
  const resourceRead = resource && await client.readResource({ uri: resource.uri });
  report.checks.push({ name: 'Authorized tabs exposed and read as MCP resources', ok: Boolean(resourceRead?.contents[0]?.text.includes('Complete workflow')) });
  const read = JSON.parse((await call('firefox_read_page', { tabId: tab.id })).content[0].text);
  const input = read.elements.find(x => x.label === 'Name');
  await call('firefox_fill', { tabId: tab.id, snapshotId: read.snapshotId, ref: input.ref, value: 'Through MCP' });
  const second = JSON.parse((await call('firefox_read_page', { tabId: tab.id })).content[0].text);
  report.checks.push({ name: 'Fill passes through MCP and native host', ok: second.elements.some(x => x.value === 'Through MCP') });
  const button = second.elements.find(x => x.label === 'Confirm');
  await call('firefox_click', { tabId: tab.id, snapshotId: second.snapshotId, ref: button.ref });
  const third = JSON.parse((await call('firefox_read_page', { tabId: tab.id })).content[0].text);
  report.checks.push({ name: 'Click confirmed by subsequent page read', ok: third.text.includes('Confirmed') });
  const image = await call('firefox_screenshot', { tabId: tab.id });
  const metadata = JSON.parse(image.content.find(item => item.type === 'text').text);
  report.checks.push({ name: 'Screenshot arrives as MCP image with coordinate observation', ok: image.content[0].type === 'image' && image.content[0].data.startsWith('iVBORw0KGgo') && typeof metadata.screenshotId === 'string' && metadata.width > 0 });
  const denied = await client.callTool({ name: 'firefox_open_tab', arguments: { url: 'https://unapproved.invalid/' } });
  report.checks.push({ name: 'Unapproved origin rejected through MCP', ok: denied.isError && JSON.stringify(denied).includes('APPROVAL_REQUIRED') });
  await broker.close();
  broker = createBroker({ token, port: address.port });
  await broker.start();
  let recovered = false;
  for (let i = 0; i < 100; i++) {
    try {
      const health = await (await fetch(`${brokerOrigin}/health`, { headers: { Authorization: `Bearer ${token}` } })).json();
      if (health.extensionOnline) { recovered = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  report.checks.push({ name: 'Native connection recovers automatically after broker restart', ok: recovered && !((await call('firefox_status')).isError) });
  if (report.checks.some(x => !x.ok)) throw new Error('An end-to-end check failed.');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { await client.close(); await stopFirefox(child); await broker.close(); await unregisterNativeHost({ name: hostName }); await new Promise(resolve => fixture.close(resolve)); await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(join(runDir, 'web-ext.log'), logs); }
process.stdout.write(JSON.stringify({ runDir, ...report }, null, 2) + '\n');
