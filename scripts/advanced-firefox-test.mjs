import { startFirefox, stopFirefox, testDirectory } from './test-support.mjs';
import http from 'node:http';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const work = await testDirectory(); await mkdir(work, { recursive: true });
const runDir = await mkdtemp(join(work, 'advanced-')); const dir = join(runDir, 'extension'); await cp('extension', dir, { recursive: true });
let reportResolve; const reportPromise = new Promise(resolve => { reportResolve = resolve; });
const fixture = http.createServer(async (req, res) => {
  if (req.url === '/report' && req.method === 'POST') { let data = ''; for await (const chunk of req) data += chunk; reportResolve(JSON.parse(data)); res.end('ok'); return; }
  if (req.url === '/file') { res.setHeader('Content-Type', 'text/plain'); res.end('Firefox Bridge isolated download'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/frame') { res.end('<!doctype html><label for="frame-name">Frame field</label><input id="frame-name">'); return; }
  res.end('<!doctype html><html lang="en"><head><title>Advanced features</title></head><body><h1>Advanced features</h1><button id="point" onclick="document.getElementById(\'result\').textContent=\'Point confirmed\'">Point</button><p id="result">Waiting</p><label for="file">Test attachment</label><input id="file" type="file" onchange="document.getElementById(\'upload-state\').textContent=\'files:\'+this.files[0].name"><p id="upload-state">No file</p><iframe src="/frame" title="Test frame"></iframe><video controls></video><script>const t=document.querySelector("video").addTextTrack("captions","English","en");t.addCue(new VTTCue(0,1,"Test caption"));t.mode="hidden";</script></body></html>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const harness = `
import { createController } from '${resolve('src/controller.mjs').replaceAll('\\', '/')}';
const c=createController(browser,{defaults:{defaultBrowse:'allow'}}); const steps=[];
async function check(name,fn){try{const details=await fn();steps.push({name,ok:true,details});}catch(e){steps.push({name,ok:false,error:e.message,code:e.code});throw e;}}
async function run(){await c.ready;await c.ui({action:'resume'});const tab=await c.call('firefox_open_tab',{url:'${origin}/page'});
await check('browsing default permits navigation and explicit blocks take precedence',async()=>{if((await c.call('firefox_status',{})).defaultBrowse!=='allow')throw Error('default');await c.ui({action:'decision',origin:'https://blocked.invalid',capabilities:['read','interact','navigate','capture'],decision:'block'});try{await c.call('firefox_open_tab',{url:'https://blocked.invalid'});}catch(e){if(e.code==='SITE_BLOCKED')return;throw e;}throw Error('not blocked');});
await check('reads and fills a real frame',async()=>{const frames=await c.call('firefox_frames',{tabId:tab.id});const f=frames.frames.find(x=>x.frameId!==0);if(!f)throw Error('no frame');const read=await c.call('firefox_read_page',{tabId:tab.id,frameId:f.frameId});const ref=read.elements.find(x=>x.label==='Frame field').ref;await c.call('firefox_fill',{tabId:tab.id,frameId:f.frameId,snapshotId:read.snapshotId,ref,value:'Filled frame'});const after=await c.call('firefox_read_page',{tabId:tab.id,frameId:f.frameId});if(!after.elements.some(x=>x.value==='Filled frame'))throw Error('frame fill');});
await check('clicks coordinates from a recent screenshot',async()=>{const image=await c.call('firefox_screenshot',{tabId:tab.id});const [{result:r}]=await browser.scripting.executeScript({target:{tabId:tab.id},func:()=>{const r=document.getElementById('point').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight};}});await c.call('firefox_point',{tabId:tab.id,screenshotId:image.screenshotId,x:r.x*image.width/r.w,y:r.y*image.height/r.h,action:'click'});const read=await c.call('firefox_read_page',{tabId:tab.id});if(!read.text.includes('Point confirmed'))throw Error('point did not click');});
await check('uploads a simulated user-selected file in the test profile',async()=>{const read=await c.call('firefox_read_page',{tabId:tab.id});const ref=read.elements.find(x=>x.type==='file').ref;const req=await c.call('firefox_upload',{tabId:tab.id,snapshotId:read.snapshotId,ref});await c.ui({action:'upload_files',requestId:req.requestId,files:[{name:'fixture.txt',type:'text/plain',data:'VGVzdGU='}]});const status=await c.call('firefox_upload_status',{requestId:req.requestId});if(status.status!=='attached')throw Error('upload not attached');const after=await c.call('firefox_read_page',{tabId:tab.id});if(!after.text.includes('files:fixture.txt'))throw Error('page did not receive file');});
await check('real download stays in the isolated test directory',async()=>{await c.ui({action:'decision',origin:'${origin}',capabilities:['download'],decision:'allow'});const result=await c.call('firefox_download',{url:'${origin}/file',filename:'fixture-download.txt',saveAs:false});let item;for(let i=0;i<100;i++){[item]=await browser.downloads.search({id:result.downloadId});if(item.state==='complete')break;await new Promise(r=>setTimeout(r,50));}if(item.state!=='complete'||!item.filename.includes('firefox-bridge-validation'))throw Error('download failed or outside test directory: '+item.filename);return{bytes:item.bytesReceived};});
await check('native Firefox tab groups',async()=>{const second=await c.call('firefox_open_tab',{url:'${origin}/page',active:false});const group=await c.call('firefox_tab_group',{action:'create',tabIds:[tab.id,second.id],title:'Bridge test',color:'green'});const all=await c.call('firefox_tab_group',{action:'list'});const found=all.groups.find(x=>x.title==='Bridge test');if(!found)throw Error('group not found');await c.call('firefox_tab_group',{action:'update',groupId:found.id,title:'Updated group',collapsed:false});await c.call('firefox_tab_group',{action:'ungroup',groupId:found.id});});
await check('network metadata omits secret query parameters',async()=>{await c.ui({action:'decision',origin:'${origin}',capabilities:['debug'],decision:'allow'});await c.call('firefox_network',{tabId:tab.id,action:'start'});await c.call('firefox_navigate',{tabId:tab.id,url:'${origin}/page?token=SECRET_QUERY'});const result=await c.call('firefox_network',{tabId:tab.id,action:'read'});if(!result.entries.length||JSON.stringify(result).includes('SECRET_QUERY'))throw Error('network log invalid');return{entries:result.entries.length};});
await check('document context and HTML5 captions',async()=>{const context=await c.call('firefox_context',{tabId:tab.id});if(context.title!=='Advanced features')throw Error('context');const media=await c.call('firefox_media',{tabId:tab.id,action:'inspect'});if(!JSON.stringify(media).includes('Test caption'))throw Error('captions missing');});
}
run().catch(()=>{}).finally(async()=>{await fetch('${origin}/report',{method:'POST',body:JSON.stringify({steps})});});
`;
await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'advanced-harness.mjs' }, outfile: join(dir, 'test-harness.js'), bundle: true, format: 'iife', target: 'firefox142' });
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); manifest.permissions.push(...manifest.optional_permissions); manifest.optional_permissions = []; manifest.background.scripts = ['test-harness.js']; await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const downloadsDir = join(runDir, 'downloads'); await mkdir(downloadsDir);
const profile = join(runDir, 'profile'); await mkdir(profile);
await writeFile(join(profile, 'user.js'), `user_pref("browser.download.folderList", 2);\nuser_pref("browser.download.dir", ${JSON.stringify(downloadsDir)});\nuser_pref("browser.download.lastDir", ${JSON.stringify(downloadsDir)});\nuser_pref("browser.download.useDownloadDir", true);\n`);
const child = startFirefox(dir, { profile });
let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
let timer;
try { const report = await Promise.race([reportPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Advanced Firefox test timeout')), 60000); })]); clearTimeout(timer); await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify({ runDir, ...report }, null, 2) + '\n'); if (report.steps.length !== 8 || report.steps.some(x => !x.ok)) process.exitCode = 1; }
catch (error) { clearTimeout(timer); process.stderr.write(`${error.message}\n${logs}\n`); process.exitCode = 1; }
finally { await stopFirefox(child); await new Promise(resolve => fixture.close(resolve)); await writeFile(join(runDir, 'web-ext.log'), logs); }
