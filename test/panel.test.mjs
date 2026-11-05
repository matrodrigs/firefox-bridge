import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function panel(overrides = {}) {
  const html = await readFile('extension/panel.html', 'utf8');
  const js = await readFile('extension/panel.js', 'utf8');
  const dom = new JSDOM(html, { url: 'https://preview.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const state = { version: '0.3.0', policy: { enabled: true, defaultBrowse: 'allow', rules: { 'https://example.com': { read: 'block' } } }, pending: [{ id: 'p', origin: 'https://docs.example.org', capabilities: ['read'], reason: 'Test request' }], uploads: [], audit: [], controlledTabs: 1, currentOrigin: 'https://example.com', extras: {}, connection: { paired: true, mode: 'native' }, ...overrides };
  let poll, reads = 0;
  const messages = [];
  dom.window.setInterval = fn => { poll = fn; return 1; };
  dom.window.browser = { runtime: { async sendMessage(message) {
    messages.push(structuredClone(message));
    if (message.action === 'state') { reads++; return structuredClone(state); }
    if (message.action === 'release_all') state.controlledTabs = 0;
    if (message.action === 'decision') {
      if (message.capabilities) for (const cap of message.capabilities) state.policy.rules[message.origin][cap] = message.decision;
      else state.pending = state.pending.filter(item => item.id !== message.requestId);
    }
    if (message.action === 'revoke') delete state.policy.rules[message.origin];
    if (message.action === 'retry_connection') state.connection = { paired: true, mode: 'native', error: '' };
    if (message.action === 'pause') state.policy.enabled = false;
    if (message.action === 'resume') state.policy.enabled = true;
    return { ok: true };
  } }, permissions: { async request() { return false; }, async remove() { return true; } } };
  dom.window.eval(js);
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  await tick();
  return { dom, state, messages, tick, poll: () => poll(), reads: () => reads, document: dom.window.document };
}

test('panel preserves focus and disclosures, names actions and disables released tabs', async () => {
  const { dom, state, document, tick, poll, reads } = await panel();
  document.querySelector('#sites-section').open = true;
  const approve = [...document.querySelectorAll('button')].find(button => button.textContent === 'Allow once');
  assert.match(approve.getAttribute('aria-label'), /https:\/\/docs.example.org/);
  const remove = [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove');
  assert.equal(remove.getAttribute('aria-label'), 'Remove the rule for https://example.com and restore default access');
  approve.focus(); const before = reads(); poll(); await tick();
  assert.equal(reads(), before + 1); assert.equal(document.activeElement, approve);
  const select = document.querySelector('select[data-capability="browse"]');
  select.focus(); select.value = 'block'; select.dispatchEvent(new dom.window.Event('change'));
  await tick();
  const replacement = document.querySelector('select[data-capability="browse"]');
  assert.notEqual(replacement, select); assert.equal(replacement.value, 'block'); assert.equal(document.activeElement, replacement);
  assert.equal(document.querySelector('#sites-section').open, true);
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove').click();
  await tick();
  assert.deepEqual(state.policy.rules, {}); assert.match(document.querySelector('#sites-list').textContent, /No site exceptions/);
  document.querySelector('#release-all').click(); await tick();
  assert.equal(document.querySelector('#release-all').disabled, true);
  assert.equal(document.querySelector('#managed-section').hidden, true);
  dom.window.close();
});

test('native connection needs no token form and exposes recovery only on failure', async () => {
  const { dom, document, messages, tick } = await panel({ connection: { paired: false, mode: 'native', error: 'Native host is not installed. Run the installer.' } });
  assert.equal(document.querySelector('#connection-form'), null);
  assert.equal(document.querySelector('input[type="password"]'), null);
  assert.equal(document.querySelector('#connection-help').hidden, false);
  assert.match(document.querySelector('#connection-error').textContent, /Run the installer/);
  document.querySelector('#retry-connection').click(); await tick();
  assert.ok(messages.some(message => message.action === 'retry_connection'));
  assert.equal(document.querySelector('#connection-state').textContent, 'Connected');
  assert.equal(document.querySelector('#connection-help').hidden, true);
  assert.equal(document.querySelector('#version').textContent, 'v0.3.0');
  dom.window.close();
});

test('polling leaves unchanged controls and selected uploads intact', async () => {
  const { dom, state, document, tick, poll } = await panel({ uploads: [{ id: 'upload-1', origin: 'https://example.com', label: 'Attachment', multiple: false }] });
  const select = document.querySelector('select[data-capability="browse"]');
  const input = document.querySelector('input[type="file"]');
  poll(); await tick();
  assert.equal(document.querySelector('select[data-capability="browse"]'), select);
  assert.equal(document.querySelector('input[type="file"]'), input);
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'selected.txt', size: 1 }] });
  document.querySelector('#toggle-access').click(); await tick();
  assert.equal(document.querySelector('input[type="file"]'), input);
  assert.equal(document.querySelector('#access-status').textContent, 'Access paused');
  state.uploads = [];
  Object.defineProperty(input, 'files', { value: [] });
  document.activeElement.blur(); poll(); await tick();
  assert.equal(document.querySelector('#upload-section').hidden, true);
  assert.equal(document.querySelector('input[type="file"]'), null);
  dom.window.close();
});

test('untrusted request content stays text and first-run keeps secondary settings collapsed', async () => {
  const { dom, document } = await panel({ pending: [{ id: 'p', origin: 'https://a-very-long-subdomain.example.org:8443', capabilities: ['debug'], reason: '<img src=x onerror="alert(1)">Debug this page' }], controlledTabs: 0 });
  assert.equal(document.querySelector('.request-row img'), null);
  assert.match(document.querySelector('.request-reason').textContent, /<img/);
  assert.equal(document.querySelector('.request-origin').textContent, 'https://a-very-long-subdomain.example.org:8443');
  for (const id of ['sites-section', 'features-section', 'activity-section']) assert.equal(document.getElementById(id).open, false);
  assert.equal(document.querySelector('#managed-section').hidden, true);
  dom.window.close();
});

test('keyboard focus and selected files do not hide incoming requests or connection changes', async () => {
  const { dom, state, document, tick, poll } = await panel({ pending: [] });
  const summary = document.querySelector('#sites-section summary');
  summary.focus();
  state.pending.push({ id: 'new', origin: 'https://example.com', capabilities: ['debug'], reason: 'Inspect this page' });
  state.uploads.push({ id: 'file', origin: 'https://example.com', label: 'Attachment' });
  state.connection = { paired: false, error: 'Reconnecting automatically.' };
  poll(); await tick();
  assert.equal(document.querySelector('#pending-section').hidden, false);
  assert.equal(document.querySelector('#upload-section').hidden, false);
  assert.equal(document.querySelector('#connection-help').hidden, false);
  assert.equal(document.activeElement, summary);
  const approve = document.querySelector('#pending-list button');
  approve.focus();
  const input = document.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [{ name: 'selected.txt', size: 1 }] });
  state.pending.push({ id: 'another', origin: 'https://example.org', capabilities: ['read'], reason: 'Read the page' });
  poll(); await tick();
  assert.equal(document.querySelectorAll('#pending-list .request-row').length, 2);
  assert.equal(document.activeElement, approve);
  assert.equal(document.querySelector('input[type="file"]'), input);
  assert.equal(input.files[0].name, 'selected.txt');
  dom.window.close();
});
