import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firefoxBinary, testDirectory } from './test-support.mjs';

const runDir = await mkdtemp(join(await testDirectory(), 'ui-'));
const longOrigin = 'https://research-preview.accessibility-and-interactions.example.org:8443';
const baseState = { version: '0.3.0', policy: { enabled: true, defaultBrowse: 'allow', rules: { 'https://example.com': { read: 'block', interact: 'block', navigate: 'block', capture: 'block' } } }, pending: [{ id: 'demo', origin: 'https://docs.example.org', capabilities: ['download'], reason: 'Save the report you requested.' }], uploads: [{ id: 'upload-demo', origin: 'https://docs.example.org', label: 'Report attachment', accept: '.txt,.pdf', multiple: false }], audit: [{ time: '2026-11-05T14:30:00Z', operation: 'firefox_read_page', origin: 'https://example.com', outcome: 'allowed' }], controlledTabs: 1, currentOrigin: 'https://example.com', extras: { bookmarks: false, history: false, downloads: true, tabGroups: true }, connection: { paired: true, error: '', mode: 'native' } };
const cases = [
  { name: 'first-run-light-340', width: 340, height: 680, theme: 'light', kind: 'first' },
  { name: 'requests-light-420', width: 420, height: 1000, theme: 'light', kind: 'requests' },
  { name: 'settings-light-800', width: 800, height: 1450, theme: 'light', kind: 'expanded' },
  { name: 'settings-dark-340', width: 340, height: 1600, theme: 'dark', kind: 'expanded' },
  { name: 'first-run-dark-420', width: 420, height: 680, theme: 'dark', kind: 'first' },
  { name: 'settings-dark-800', width: 800, height: 1450, theme: 'dark', kind: 'expanded' },
  { name: 'connection-error-light-420', width: 420, height: 750, theme: 'light', kind: 'error' }
];
const measurements = new Map();
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/metrics' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const report = JSON.parse(body); measurements.set(report.name, report); response.end('ok'); return;
    }
    const file = url.pathname === '/' ? 'panel.html' : url.pathname.slice(1);
    if (!['panel.html', 'panel.css', 'panel.js', 'icon.svg', 'preview-state.js'].includes(file)) { response.writeHead(404); response.end(); return; }
    const variant = cases.find(item => item.name === url.searchParams.get('case')) ?? cases[0];
    if (file === 'preview-state.js') {
      const state = structuredClone(baseState);
      if (['first', 'error'].includes(variant.kind)) { state.policy.enabled = false; state.policy.rules = {}; state.pending = []; state.uploads = []; state.audit = []; state.controlledTabs = 0; }
      if (variant.kind === 'error') state.connection = { paired: false, mode: 'native', error: 'The local bridge is not installed. Run the installer, then retry.' };
      if (variant.kind === 'expanded') {
        state.pending[0].origin = longOrigin;
        state.pending[0].capabilities = ['debug'];
        state.pending[0].reason = 'Inspect the console error on this page.';
        state.uploads = [];
        state.policy.rules = { [longOrigin]: { debug: 'allow', upload: 'ask', download: 'block' } };
      }
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`globalThis.browser={runtime:{sendMessage:async message=>message.action==='state'?${JSON.stringify(state)}:{ok:true}},permissions:{request:async()=>true,remove:async()=>true}};document.addEventListener('DOMContentLoaded',()=>{${variant.kind === 'expanded' ? "for(const id of ['sites-section','features-section','activity-section'])document.getElementById(id).open=true;" : ''}navigator.sendBeacon('/metrics',JSON.stringify({name:${JSON.stringify(variant.name)},width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.body.scrollHeight,theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light',access:document.getElementById('access-status').textContent}));});`);
      return;
    }
    let data = await readFile(join('extension', file));
    if (file === 'panel.html') data = Buffer.from(data.toString().replace('<script src="panel.js"', `<script src="preview-state.js?case=${variant.name}"></script><script src="panel.js"`));
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
    response.end(data);
  } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const variant of cases) {
    const profile = join(runDir, `profile-${variant.name}`); await mkdir(profile);
    await writeFile(join(profile, 'user.js'), `user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\nuser_pref("ui.systemUsesDarkTheme", ${variant.theme === 'dark' ? 1 : 0});\nuser_pref("layout.css.prefers-color-scheme.content-override", ${variant.theme === 'dark' ? 0 : 1});\n`);
    const child = spawn(firefoxBinary(), ['-headless', '-no-remote', '-profile', profile, '--screenshot', join(runDir, `${variant.name}.png`), '--window-size', `${variant.width},${variant.height}`, `http://127.0.0.1:${server.address().port}/panel.html?case=${variant.name}`], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('UI screenshot timed out')); }, 20000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Firefox exited with ${code}`)); });
    });
  }
} finally { await new Promise(resolve => server.close(resolve)); }
const report = { runDir, screenshots: cases.map(item => join(runDir, `${item.name}.png`)), measurements: [...measurements.values()] };
await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.measurements.length !== cases.length || report.measurements.some(item => item.scrollWidth > item.width || item.access === 'Loading…' || item.theme !== cases.find(variant => variant.name === item.name).theme)) process.exitCode = 1;
