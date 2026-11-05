import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { startFirefox, stopFirefox, testDirectory } from './test-support.mjs';

const runDir = await mkdtemp(join(await testDirectory(), 'debug-'));
const dir = join(runDir, 'extension');
await cp('extension', dir, { recursive: true });
let resolveReport;
const reportPromise = new Promise(resolve => { resolveReport = resolve; });
const fixture = http.createServer(async (request, response) => {
  if (request.url === '/report' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    resolveReport(JSON.parse(body));
    response.end('ok');
    return;
  }
  if (request.url.startsWith('/api')) { response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('Fixture failure'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><title>Debug fixture</title></head><body>
    <h1 id="heading">Debug fixture</h1><button id="run">Run diagnostics</button><p id="result">Waiting</p><input id="password" type="password" value="PRIVATE_VALUE">
    <div id="host"></div><script>
      const shadow = document.querySelector('#host').attachShadow({mode:'open'});
      shadow.innerHTML = '<button id="shadow-button" aria-label="Shadow control">Shadow</button>';
      document.querySelector('#run').addEventListener('click', () => {
        console.warn('fixture warning', {token:'PRIVATE_OBJECT'});
        setTimeout(() => fetch('/api?token=PRIVATE_QUERY').then(response => response.text()).then(() => document.querySelector('#result').textContent = 'Diagnostics complete'), 30);
        setTimeout(() => { throw new Error('fixture exception'); }, 20);
      });
    </script></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const harness = `
import { createController } from '${resolve('src/controller.mjs').replaceAll('\\', '/')}';
const c = createController(browser, {defaults:{defaultBrowse:'allow'}});
const steps = [];
async function check(name, job) { try { const details = await job(); steps.push({name,ok:true,details}); } catch(error) { steps.push({name,ok:false,error:error.message,code:error.code}); throw error; } }
async function run() {
  await c.ready; await c.ui({action:'resume'});
  await c.ui({action:'decision',origin:'${origin}',capabilities:['debug'],decision:'allow'});
  const tab = await c.call('firefox_open_tab',{url:'${origin}/page'});
  await check('DOM inspection and shadow traversal', async () => {
    const info = await c.call('firefox_inspect',{tabId:tab.id,selector:'#heading'});
    if(info.tag !== 'h1' || info.box.width <= 0) throw Error('missing native geometry');
    const shadow = await c.call('firefox_inspect',{tabId:tab.id,selector:'#shadow-button'});
    if(shadow.accessibility.name !== 'Shadow control') throw Error('shadow inspection failed');
    const secret = await c.call('firefox_inspect',{tabId:tab.id,selector:'#password'});
    if(JSON.stringify(secret).includes('PRIVATE_VALUE')) throw Error('sensitive field leaked');
    return {width:info.box.width};
  });
  await check('console records actual page JavaScript and preserves warning arguments', async () => {
    await c.call('firefox_console',{tabId:tab.id,action:'start'});
    await c.call('firefox_network',{tabId:tab.id,action:'start'});
    const page = await c.call('firefox_read_page',{tabId:tab.id});
    const button = page.elements.find(x => x.label === 'Run diagnostics');
    await c.call('firefox_click',{tabId:tab.id,snapshotId:page.snapshotId,ref:button.ref});
    await c.call('firefox_wait',{tabId:tab.id,text:'Diagnostics complete',timeoutMs:5000});
    let logs;
    for(let i=0;i<30;i++) {
      logs=await c.call('firefox_console',{tabId:tab.id,action:'read'});
      if(logs.entries.some(x=>x.level==='exception')) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!logs.entries.some(x=>x.text.includes('fixture warning')) || !logs.entries.some(x=>x.level==='exception' && x.text.includes('fixture exception'))) throw Error('page console/error not captured: '+JSON.stringify(logs));
    if(JSON.stringify(logs).includes('PRIVATE_OBJECT')) throw Error('console object traversed');
    return {levels:logs.entries.map(x=>x.level)};
  });
  await check('network records real status and duration without query', async () => {
    let result, item;
    for(let i=0;i<40;i++) {
      result=await c.call('firefox_network',{tabId:tab.id,action:'read',errorsOnly:true,statusMin:500});
      item=result.entries.find(x=>x.url.endsWith('/api'));
      if(item && item.state==='completed') break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!item || item.status!==503 || typeof item.durationMs!=='number') throw Error('network diagnostics missing: '+JSON.stringify(result));
    if(JSON.stringify(result).includes('PRIVATE_QUERY')) throw Error('query leaked');
    return {status:item.status,durationMs:item.durationMs};
  });
  await check('native performance navigation and resource timing', async () => {
    const result=await c.call('firefox_performance',{tabId:tab.id});
    if(!result.navigation || !result.resources.some(x=>x.url.endsWith('/api'))) throw Error('performance timing missing: '+JSON.stringify(result));
    if(JSON.stringify(result).includes('PRIVATE_QUERY')) throw Error('performance query leaked');
    return {resources:result.resources.length,loadMs:result.navigation.loadMs};
  });
  await check('new document stops console but same-origin network remains active', async () => {
    await c.call('firefox_navigate',{tabId:tab.id,url:'${origin}/page?next=1'});
    if((await c.call('firefox_console',{tabId:tab.id,action:'read'})).recording) throw Error('console carried into new document');
    if(!(await c.call('firefox_network',{tabId:tab.id,action:'read'})).recording) throw Error('network stopped on same-origin navigation');
  });
  await check('pause and release clean up collection', async () => {
    await c.call('firefox_console',{tabId:tab.id,action:'start'});
    await c.ui({action:'pause'});
    if((await c.call('firefox_console',{tabId:tab.id,action:'stop'})).recording) throw Error('console did not stop');
    await c.ui({action:'resume'});
    if((await c.call('firefox_network',{tabId:tab.id,action:'read'})).recording) throw Error('network resumed silently');
    await c.call('firefox_release_tab',{tabId:tab.id});
  });
}
run().catch(()=>{}).finally(async()=>{await fetch('${origin}/report',{method:'POST',body:JSON.stringify({steps})});});
`;
await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'debug-harness.mjs' }, outfile: join(dir, 'test-harness.js'), bundle: true, format: 'iife', target: 'firefox142' });
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
manifest.background.scripts = ['test-harness.js'];
await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const child = startFirefox(dir);
let logs = '';
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
let timer;
try {
  const report = await Promise.race([reportPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Debug Firefox test timeout')), 60000); })]);
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ runDir, ...report }, null, 2) + '\n');
  if (report.steps.length !== 6 || report.steps.some(x => !x.ok)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n${logs}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await stopFirefox(child);
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await writeFile(join(runDir, 'web-ext.log'), logs);
}
