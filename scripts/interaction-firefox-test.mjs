import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { startFirefox, stopFirefox, testDirectory } from './test-support.mjs';

const runDir = await mkdtemp(join(await testDirectory(), 'interaction-'));
const extensionDir = join(runDir, 'extension');
await cp('extension', extensionDir, { recursive: true });
let reportResolve;
const reportPromise = new Promise(resolve => { reportResolve = resolve; });
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Interaction fixture</title>
<style>body{font:16px sans-serif;margin:30px}input,button,[contenteditable]{margin:8px;padding:8px}output{display:block;height:24px;white-space:nowrap}#covered{position:relative}#overlay{position:absolute;inset:0;background:#bbb;z-index:10}#far{margin-top:1200px}</style>
<body><div id="host"></div><div id="covered"><button id="blocked">Covered action</button><div id="overlay"></div></div>
<label for="controlled">Controlled</label><input id="controlled"><output id="input-state"></output>
<label for="canceled">Canceled</label><input id="canceled"><input id="readonly" aria-label="Readonly" readonly>
<div contenteditable="true" aria-label="Editor">Original</div><button id="keyboard">Keyboard</button><input id="checkbox" type="checkbox" aria-label="Toggle">
<output id="clicked">0</output><output id="events"></output><button id="partial">Partial action</button><output id="partial-state">0</output><button id="far">Far action</button>
<script>
const host = document.getElementById('host');
host.attachShadow({mode:'open'}).innerHTML='<style>button{padding:12px}</style><span id="name">Shadow action</span><button aria-labelledby="name">Inside</button>';
host.shadowRoot.querySelector('button').addEventListener('click', e => document.getElementById('events').textContent='shadow:'+e.composed+':'+e.isTrusted);
const field=document.getElementById('controlled');const native=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
Object.defineProperty(field,'value',{get(){return native.get.call(this)},set(){throw Error('framework setter')}});
field.addEventListener('input',e=>document.getElementById('input-state').textContent=field.value+':'+e.inputType+':'+e.composed);
document.getElementById('canceled').addEventListener('beforeinput',e=>e.preventDefault());
for(const id of ['blocked','keyboard'])document.getElementById(id).addEventListener('click',()=>document.getElementById('clicked').textContent=String(Number(document.getElementById('clicked').textContent)+1));
document.getElementById('partial').addEventListener('pointerdown',event=>{document.getElementById('partial-state').textContent=String(Number(document.getElementById('partial-state').textContent)+1);event.currentTarget.remove();});
const sequence=[];for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.getElementById('far').addEventListener(type,e=>{sequence.push(type);document.getElementById('events').textContent=sequence.join(',')+':'+e.clientY;});
</script></body></html>`;
const server = http.createServer(async (request, response) => {
  if (request.url === '/report' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    reportResolve(JSON.parse(body));
    response.end('ok');
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const harness = `
import { createController } from './src/controller.mjs';
const controller = createController(browser, { defaults: { defaultBrowse: 'allow' } });
const steps = [];
async function check(name, fn) { try { await fn(); steps.push({name,ok:true}); } catch(error) { steps.push({name,ok:false,error:error.message}); throw error; } }
let tab;
async function read(){return controller.call('firefox_read_page',{tabId:tab.id});}
async function action(name,label,extra={}){const snapshot=await read();const target=snapshot.elements.find(e=>e.label===label);if(!target)throw Error('Missing target '+label);return controller.call(name,{tabId:tab.id,snapshotId:snapshot.snapshotId,ref:target.ref,...extra});}
async function inspect(func){const [{result}]=await browser.scripting.executeScript({target:{tabId:tab.id},func});return result;}
async function run(){
  await controller.ready; await controller.ui({action:'resume'});
  tab=await controller.call('firefox_open_tab',{url:'${origin}/fixture'});
  await check('open shadow DOM and composed pointer activation',async()=>{
    const snapshot=await read();if(!snapshot.elements.some(e=>e.label==='Shadow action'&&e.shadowRoot&&e.role==='button'))throw Error('Shadow reference missing');
    await action('firefox_click','Shadow action');
    if(await inspect(()=>document.getElementById('events').textContent)!=='shadow:true:false')throw Error('Wrong shadow event');
  });
  await check('covered controls are rejected without activation',async()=>{
    let denied=false;try{await action('firefox_click','Covered action');}catch(error){denied=error.message.includes('covered');}
    if(!denied||await inspect(()=>document.getElementById('clicked').textContent)!=='0')throw Error('Overlay bypassed');
    await inspect(()=>document.getElementById('overlay').remove());
    await action('firefox_click','Covered action');
    if(await inspect(()=>document.getElementById('clicked').textContent)!=='1')throw Error('Uncovered action failed');
  });
  await check('controlled input uses native setter and composed InputEvent',async()=>{
    await action('firefox_fill','Controlled',{value:'Framework value'});
    if(await inspect(()=>document.getElementById('input-state').textContent)!=='Framework value:insertReplacementText:true')throw Error('Input behavior mismatch');
  });
  await check('beforeinput cancellation and readonly are honored',async()=>{
    const canceled=await action('firefox_fill','Canceled',{value:'blocked'});
    if(canceled.performed!==false||await inspect(()=>document.getElementById('canceled').value)!=='')throw Error('Canceled input changed');
    let denied=false;try{await action('firefox_fill','Readonly',{value:'blocked'});}catch(error){denied=error.message.includes('read-only');}
    if(!denied)throw Error('Readonly changed');
  });
  await check('contenteditable accepts literal text',async()=>{
    await action('firefox_fill','Editor',{value:'<b>Literal</b>'});
    const value=await inspect(()=>({text:document.querySelector('[contenteditable]').textContent,children:document.querySelector('[contenteditable]').children.length}));
    if(value.text!=='<b>Literal</b>'||value.children)throw Error('HTML interpreted');
  });
  await check('keyboard Enter and Space activate native controls',async()=>{
    await action('firefox_key','Keyboard',{key:'Enter'});
    if(await inspect(()=>document.getElementById('clicked').textContent)!=='2')throw Error('Enter did not activate');
    await action('firefox_key','Toggle',{key:'Space'});
    if(!await inspect(()=>document.getElementById('checkbox').checked))throw Error('Space did not toggle');
  });
  await check('offscreen control scrolls and receives one pointer sequence',async()=>{
    await action('firefox_click','Far action');
    const value=await inspect(()=>({events:document.getElementById('events').textContent,scroll:scrollY,height:innerHeight}));
    if(!value.scroll||!value.events.startsWith('pointerdown,mousedown,pointerup,mouseup,click:'))throw Error('Pointer sequence or scroll failed');
    const y=Number(value.events.split(':').at(-1));if(y<0||y>=value.height)throw Error('Coordinate outside viewport');
  });
  await check('partial pointer effects return uncertainty without replay',async()=>{
    let failure;try{await action('firefox_click','Partial action');}catch(error){failure=error;}
    if(failure?.code!=='ACTION_OUTCOME_UNCERTAIN'||!failure.message.includes('removed'))throw Error('Partial action was not reported as uncertain');
    if(await inspect(()=>document.getElementById('partial-state').textContent)!=='1')throw Error('Partial action was replayed or never dispatched');
  });
}
run().catch(()=>{}).finally(async()=>{await fetch('${origin}/report',{method:'POST',body:JSON.stringify({steps})});});
`;
await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'interaction-harness.mjs' }, outfile: join(extensionDir, 'test-harness.js'), bundle: true, format: 'iife', target: 'firefox142' });
const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
manifest.background.scripts = ['test-harness.js'];
await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const child = startFirefox(extensionDir, { startUrl: `${origin}/fixture` });
let logs = '', timer;
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
try {
  const report = await Promise.race([reportPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Interaction Firefox test timeout')), 60000); })]);
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ runDir, ...report }, null, 2) + '\n');
  if (report.steps.length !== 8 || report.steps.some(step => !step.ok)) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n${logs}\n`); process.exitCode = 1; }
finally { clearTimeout(timer); await stopFirefox(child); await new Promise(resolve => server.close(resolve)); await writeFile(join(runDir, 'web-ext.log'), logs); }
