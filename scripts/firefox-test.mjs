import { startFirefox, stopFirefox, testDirectory } from './test-support.mjs';
import http from 'node:http';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const directory = await testDirectory();
await mkdir(directory, { recursive: true });
const runDir = await mkdtemp(join(directory, 'firefox-'));
const extensionDir = join(runDir, 'extension'); await cp('extension', extensionDir, { recursive: true });
let reportResolve;
const reportPromise = new Promise(resolve => { reportResolve = resolve; });
const originHits = [];
const unapprovedServer = http.createServer((_req, res) => { originHits.push('escape'); res.end('<h1>Unapproved destination</h1>'); });
await new Promise(resolve => unapprovedServer.listen(0, '127.0.0.1', resolve));
const unapprovedOrigin = `http://127.0.0.1:${unapprovedServer.address().port}`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/report' && req.method === 'POST') {
    let data = ''; for await (const chunk of req) data += chunk;
    reportResolve(JSON.parse(data)); res.end('ok'); return;
  }
  if (req.url === '/redirect') { res.writeHead(302, { Location: `${unapprovedOrigin}/escape` }); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html lang="en"><head><title>Isolated Firefox Bridge test</title></head><body><h1>Isolated test page</h1><label for="name">Name</label><input id="name"><input id="password" type="password" value="DO_NOT_EXPOSE"><button id="button" onclick="document.getElementById(\'result\').textContent=\'Click received\'">Confirm</button><p id="result">Waiting</p></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const source = `
import { createController } from '${resolve('src/controller.mjs').replaceAll('\\', '/')}';
const c = createController(browser);
const steps = [];
async function check(label, fn) { try { const details = await fn(); steps.push({ label, ok: true, details }); } catch (e) { steps.push({ label, ok: false, error: e.message, code: e.code }); throw e; } }
async function run() {
  await c.ready;
  await check('starts paused without rules', async () => { if(c.policy.enabled || Object.keys(c.policy.rules).length) throw new Error('default grant'); });
  await c.ui({ action: 'resume' });
  await c.ui({ action: 'decision', origin: '${base}', capabilities: ['read','interact','navigate','capture'], decision: 'allow' });
  let tab;
  await check('opens an authorized local tab', async () => { tab = await c.call('firefox_open_tab', { url: '${base}/page' }); return { id: tab.id }; });
  let snapshot;
  await check('reads DOM references and omits passwords', async () => { snapshot = await c.call('firefox_read_page', { tabId: tab.id }); if(JSON.stringify(snapshot).includes('DO_NOT_EXPOSE')) throw new Error('password leaked'); if(!snapshot.elements.length || !snapshot.snapshotId) throw new Error('missing DOM'); return { elements: snapshot.elements.length }; });
  await check('fills a real field', async () => { const ref = snapshot.elements.find(e => e.label === 'Name').ref; await c.call('firefox_fill', { tabId: tab.id, snapshotId: snapshot.snapshotId, ref, value: 'Firefox test' }); });
  await check('clicks and verifies the page outcome', async () => { snapshot = await c.call('firefox_read_page', { tabId: tab.id }); const ref = snapshot.elements.find(e => e.label === 'Confirm').ref; await c.call('firefox_click', { tabId: tab.id, snapshotId: snapshot.snapshotId, ref }); const after = await c.call('firefox_read_page', { tabId: tab.id }); if(!after.text.includes('Click received')) throw new Error('click did not run'); });
  await check('captures a real PNG image', async () => { const image = await c.call('firefox_screenshot', { tabId: tab.id }); if(!image.image.data.startsWith('iVBORw0KGgo')) throw new Error('not PNG'); return { bytes: image.image.data.length }; });
  await check('denies another origin', async () => { try { await c.call('firefox_open_tab', { url: '${unapprovedOrigin}/escape' }); } catch (e) { if(e.code === 'APPROVAL_REQUIRED') return; throw e; } throw new Error('unexpected approval'); });
  await check('blocks redirects to unauthorized origins', async () => { try { await c.call('firefox_navigate', { tabId: tab.id, url: '${base}/redirect' }); } catch (e) { if(['NAVIGATION_TIMEOUT','NAVIGATION_CHANGED','INVALID_URL'].includes(e.code)) return { blocked: true, code: e.code }; throw e; } const current = await browser.tabs.get(tab.id); if(current.url.includes('/escape')) throw new Error('redirect escaped'); return { blocked: true }; });
  await check('revocation prevents subsequent reads', async () => { await c.ui({ action: 'revoke', origin: '${base}' }); try { await c.call('firefox_read_page', { tabId: tab.id }); } catch (e) { if(['APPROVAL_REQUIRED','INVALID_URL'].includes(e.code)) return; throw e; } throw new Error('revoke did not take effect'); });
}
run().catch(()=>{}).finally(async()=>{ await fetch('${base}/report', { method: 'POST', body: JSON.stringify({ steps }) }); });
`;
await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'test-harness.mjs' }, outfile: join(extensionDir, 'test-harness.js'), bundle: true, format: 'iife', target: 'firefox142' });
const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
manifest.background.scripts = ['test-harness.js'];
manifest.content_security_policy = manifest.content_security_policy.replace('connect-src http://127.0.0.1:39281', `connect-src ${base}`);
await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const child = startFirefox(extensionDir, { startUrl: `${base}/page` });
let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
let timer;
try {
  const report = await Promise.race([reportPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Firefox test timeout')), 60000); })]);
  clearTimeout(timer); report.unapprovedDestinationRequests = originHits.length;
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ runDir, ...report }, null, 2) + '\n');
  if (report.steps.length !== 9 || report.steps.some(x => !x.ok) || originHits.length) process.exitCode = 1;
} catch (error) { clearTimeout(timer); process.stderr.write(`${error.message}\n${logs}\n`); process.exitCode = 1; }
finally { await stopFirefox(child); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => unapprovedServer.close(resolve)); await writeFile(join(runDir, 'web-ext.log'), logs); }
