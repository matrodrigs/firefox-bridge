import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createController } from '../src/controller.mjs';
import { consoleOperation } from '../src/console-page.mjs';
import { debugPageOperation } from '../src/debug-page.mjs';
import { mockBrowser } from './helpers.mjs';

async function setup() {
  const mock = mockBrowser();
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  for (const name of ['onCompleted', 'onErrorOccurred', 'onBeforeRedirect']) mock.browser.webRequest[name] = event();
  const c = createController(mock.browser, { defaults: { defaultBrowse: 'allow' } });
  await c.ready;
  await c.ui({ action: 'resume' });
  return { ...mock, c };
}

async function grant(c, origin = 'https://allowed.test') {
  await c.ui({ action: 'decision', origin, capabilities: ['debug'], decision: 'allow' });
}

function consolePage() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://allowed.test/page', runScripts: 'outside-only' });
  const calls = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) dom.window.console[level] = (...args) => calls.push({ level, args });
  const run = args => dom.window.eval(`(${consoleOperation.toString()})`)({ expectedUrl: dom.window.location.href, sessionId: 'session', ...args });
  return { dom, calls, run };
}

test('console preserves original behavior and bounds data without invoking object getters', () => {
  const { dom, calls, run } = consolePage();
  const original = dom.window.console.warn;
  let getterCalls = 0;
  const payload = { get token() { getterCalls++; return 'SECRET'; } };
  run({ action: 'start' });
  dom.window.console.warn('example', payload);
  const read = run({ action: 'read' });
  assert.equal(read.entries[0].text, 'example [object]');
  assert.equal(getterCalls, 0);
  assert.equal(calls.length, 1);
  for (let i = 0; i < 205; i++) dom.window.console.log('x'.repeat(5000));
  const bounded = run({ action: 'read', maxResults: 200 });
  assert.equal(bounded.entries.length, 200);
  assert.equal(bounded.dropped, 6);
  assert.equal(bounded.entries[0].text.length, 2000);
  run({ action: 'stop' });
  assert.equal(dom.window.console.warn, original);
  assert.equal(dom.window.__firefoxBridgeConsole, undefined);
  dom.window.close();
});

test('console records future errors, filters levels, clears and restores hooks on expiry', () => {
  const { dom, run } = consolePage();
  const original = dom.window.console.log;
  run({ action: 'start' });
  dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { message: 'Fixture failure', filename: 'https://allowed.test/app.js?token=SECRET', lineno: 7, colno: 2 }));
  dom.window.console.log('message');
  const result = run({ action: 'read', levels: ['exception'] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].source, 'https://allowed.test/app.js');
  assert.equal(run({ action: 'clear' }).entries.length, 0);
  dom.window.Date.now = () => Date.now() + 900001;
  assert.equal(run({ action: 'read' }).recording, false);
  assert.equal(dom.window.console.log, original);
  dom.window.close();
});

test('stopping console leaves a site replacement hook intact', () => {
  const { dom, run } = consolePage();
  run({ action: 'start' });
  const replacement = () => {};
  dom.window.console.warn = replacement;
  run({ action: 'stop' });
  assert.equal(dom.window.console.warn, replacement);
  dom.window.close();
});

test('console cleanup survives same-document URL changes and only stops its own session', () => {
  const { dom, run } = consolePage();
  const original = dom.window.console.warn;
  const expectedUrl = dom.window.location.href;
  run({ action: 'start' });
  dom.window.console.warn('discard this message');
  const state = dom.window.__firefoxBridgeConsole;
  dom.window.history.pushState({}, '', '/changed#fragment');
  run({ action: 'stop', expectedUrl, sessionId: 'different-session' });
  assert.equal(dom.window.__firefoxBridgeConsole, state);
  assert.equal(state.entries.length, 1);
  run({ action: 'stop', expectedUrl });
  assert.equal(dom.window.console.warn, original);
  assert.equal(dom.window.__firefoxBridgeConsole, undefined);
  assert.equal(state.entries.length, 0);
  dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { message: 'after cleanup' }));
  assert.equal(state.entries.length, 0);
  dom.window.close();
});

test('revocation removes live page instrumentation after a same-document URL change', async () => {
  const { c, browser, tabs } = await setup();
  const { dom, run } = consolePage();
  const original = dom.window.console.log;
  await grant(c);
  browser.scripting.executeScript = async options => [{ result: run(options.args[0]) }];
  await c.call('firefox_console', { tabId: 1, action: 'start' });
  dom.window.console.log('recorded before revocation');
  const state = dom.window.__firefoxBridgeConsole;
  dom.window.history.pushState({}, '', '/page#changed');
  tabs.get(1).url = dom.window.location.href;
  await c.ui({ action: 'revoke', origin: 'https://allowed.test' });
  assert.equal(dom.window.console.log, original);
  assert.equal(dom.window.__firefoxBridgeConsole, undefined);
  assert.equal(state.entries.length, 0);
  dom.window.close();
});

test('recording injected after pause or release is immediately cleaned up', async () => {
  for (const action of ['pause', 'release_all']) {
    const { c, browser } = await setup();
    const { dom, run } = consolePage();
    const original = dom.window.console.log;
    await grant(c);
    let lateState;
    browser.scripting.executeScript = async options => {
      const request = options.args[0];
      if (request.action === 'start') await c.ui({ action });
      const result = run(request);
      if (request.action === 'start') lateState = dom.window.__firefoxBridgeConsole;
      return [{ result }];
    };
    await assert.rejects(c.call('firefox_console', { tabId: 1, action: 'start' }), { code: action === 'pause' ? 'AUTHORIZATION_CHANGED' : 'DEBUG_SESSION_ENDED' });
    assert.ok(lateState);
    assert.equal(lateState.entries.length, 0);
    assert.equal(dom.window.__firefoxBridgeConsole, undefined);
    assert.equal(dom.window.console.log, original);
    dom.window.close();
  }
});

test('debug access is separate and continuous recording rejects one-operation grants', async () => {
  const { c } = await setup();
  for (const [name, args] of [['firefox_console', { action: 'start' }], ['firefox_inspect', { selector: 'button' }], ['firefox_performance', {}]]) await assert.rejects(c.call(name, { tabId: 1, ...args }), { code: 'APPROVAL_REQUIRED' });
  await c.ui({ action: 'decision', origin: 'https://allowed.test', capabilities: ['debug'], decision: 'once' });
  await assert.rejects(c.call('firefox_console', { tabId: 1, action: 'start' }), { code: 'PERSISTENT_DEBUG_REQUIRED' });
});

test('console uses MAIN without a remote API and bounds tampered page results', async () => {
  const { c, browser, storage } = await setup();
  await grant(c);
  browser.scripting.executeScript = async options => {
    assert.equal(options.world, 'MAIN');
    assert.equal(options.func, consoleOperation);
    assert.deepEqual(options.target.frameIds, [0]);
    return [{ result: { recording: true, dropped: -10, entries: [{ level: 'warn', text: 'CONFIDENTIAL'.repeat(1000), time: Infinity }, { level: 'unknown', text: 'bad' }] } }];
  };
  const result = await c.call('firefox_console', { tabId: 1, action: 'start' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].text.length, 2000);
  assert.equal(result.entries[0].time, null);
  assert.equal(result.dropped, 0);
  assert.equal(result.contentTrust, 'untrusted_webpage');
  assert.ok(!JSON.stringify(storage.audit).includes('CONFIDENTIAL'));
});

test('revocation during a debug query discards the result and stops recording', async () => {
  const { c, browser } = await setup();
  await grant(c);
  let stops = 0;
  browser.scripting.executeScript = async options => {
    if (options.args[0].action === 'stop') { stops++; return [{ result: { recording: false } }]; }
    await c.ui({ action: 'pause' });
    return [{ result: { recording: true, entries: [{ level: 'log', text: 'must not escape' }] } }];
  };
  await assert.rejects(c.call('firefox_console', { tabId: 1, action: 'start' }), { code: 'AUTHORIZATION_CHANGED' });
  assert.ok(stops > 0);
  assert.equal((await c.call('firefox_console', { tabId: 1, action: 'stop' })).recording, false);
});

test('console stops on tab release and navigation, including the same URL', async () => {
  const { c, browser, tabs } = await setup();
  await grant(c);
  const calls = [];
  browser.scripting.executeScript = async options => { calls.push(options.args[0].action); return [{ result: { recording: true, entries: [] } }]; };
  await c.call('firefox_console', { tabId: 1, action: 'start' });
  browser.webNavigation.onBeforeNavigate.listeners[0]({ tabId: 1, frameId: 0, url: tabs.get(1).url });
  assert.equal((await c.call('firefox_console', { tabId: 1, action: 'read' })).recording, false);
  await c.call('firefox_console', { tabId: 1, action: 'start' });
  await c.call('firefox_release_tab', { tabId: 1 });
  assert.equal((await c.call('firefox_console', { tabId: 1, action: 'read' })).recording, false);
  assert.equal(calls.filter(x => x === 'stop').length, 2);
});

test('CSS inspection requires a unique match, omits sensitive values and traverses open shadow roots', () => {
  const dom = new JSDOM('<!doctype html><input id="secret" type="password" value="SECRET"><button>First</button><button>Second</button><div id="host"></div>', { url: 'https://allowed.test/page', runScripts: 'outside-only' });
  const shadow = dom.window.document.querySelector('#host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="inside" aria-labelledby="missing">Shadow</button>';
  const run = args => dom.window.eval(`(${debugPageOperation.toString()})`)({ expectedUrl: dom.window.location.href, action: 'inspect', ...args });
  const secret = run({ selector: '#secret' });
  assert.equal(secret.sensitive, true);
  assert.ok(!JSON.stringify(secret).includes('SECRET'));
  assert.throws(() => run({ selector: 'button' }), /Ambiguous/);
  assert.ok(run({ selector: '#inside' }).accessibility.issues.includes('missing_label_reference'));
  dom.window.close();
});

test('inspection checks current references and signature changes', () => {
  const dom = new JSDOM('<button id="button">Send</button>', { url: 'https://allowed.test/page', runScripts: 'outside-only' });
  const element = dom.window.document.querySelector('button');
  dom.window.__firefoxBridgeDocument = { snapshotId: 'current', refs: new Map([['e1', { element, signature: 'Send' }]]), signature: node => node.textContent };
  const run = args => dom.window.eval(`(${debugPageOperation.toString()})`)({ expectedUrl: dom.window.location.href, action: 'inspect', ref: 'e1', ...args });
  assert.throws(() => run({ snapshotId: 'old' }), /expired/);
  assert.equal(run({ snapshotId: 'current' }).tag, 'button');
  element.textContent = 'Delete';
  assert.throws(() => run({ snapshotId: 'current' }), /changed/);
  dom.window.close();
});

test('inspection visibility includes hidden and transparent composed ancestors', () => {
  const dom = new JSDOM('<div id="parent"><button id="button">Visible</button></div><div id="host"></div>', { url: 'https://allowed.test/page', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0 });
  const host = dom.window.document.querySelector('#host');
  host.attachShadow({ mode: 'open' }).innerHTML = '<button id="inside">Shadow</button>';
  const run = selector => dom.window.eval(`(${debugPageOperation.toString()})`)({ expectedUrl: dom.window.location.href, action: 'inspect', selector });
  const parent = dom.window.document.querySelector('#parent');
  assert.equal(run('#button').visible, true);
  parent.hidden = true;
  assert.equal(run('#button').visible, false);
  parent.hidden = false;
  parent.style.opacity = '0';
  assert.equal(run('#button').visible, false);
  assert.equal(run('#inside').visible, true);
  host.style.opacity = '0';
  assert.equal(run('#inside').visible, false);
  host.style.opacity = '1';
  host.setAttribute('inert', '');
  assert.equal(run('#inside').visible, false);
  assert.equal(run('#inside').disabled, true);
  dom.window.close();
});

test('performance filters resource origins and requires each frame authorization', async () => {
  const { c, browser } = await setup();
  await grant(c);
  browser.scripting.executeScript = async options => {
    assert.equal(options.world, 'ISOLATED');
    return [{ result: { resources: [{ url: 'https://allowed.test/app.js', duration: 2 }, { url: 'https://private.test/tracker', duration: 10 }] } }];
  };
  const result = await c.call('firefox_performance', { tabId: 1 });
  assert.equal(result.resources.length, 1);
  assert.equal(result.hiddenResources, 1);
  await assert.rejects(c.call('firefox_performance', { tabId: 1, frameId: 5 }), { code: 'APPROVAL_REQUIRED' });
});

test('network preserves start times, computes duration and filters failures across same-origin navigation', async () => {
  const { c, browser, tabs } = await setup();
  await grant(c);
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  const before = browser.webRequest.onBeforeRequest.listeners[1];
  const after = browser.webRequest.onCompleted.listeners[0];
  const request = { tabId: 1, requestId: '1', url: 'https://allowed.test/api?token=SECRET', type: 'xmlhttprequest', method: 'GET', timeStamp: 100 };
  before(request);
  after({ ...request, timeStamp: 125, statusCode: 503, fromCache: false });
  browser.webNavigation.onBeforeNavigate.listeners[0]({ tabId: 1, frameId: 0, url: tabs.get(1).url });
  const result = await c.call('firefox_network', { tabId: 1, action: 'read', errorsOnly: true, statusMin: 500, type: 'xmlhttprequest' });
  assert.equal(result.entries[0].durationMs, 25);
  assert.equal(result.entries[0].status, 503);
  assert.equal(result.entries[0].state, 'completed');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  await c.call('firefox_network', { tabId: 1, action: 'clear' });
  assert.equal((await c.call('firefox_network', { tabId: 1, action: 'read' })).entries.length, 0);
});

test('network clears recording after revocation, release and cross-origin navigation', async () => {
  const { c, browser } = await setup();
  await grant(c);
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  await c.call('firefox_release_tab', { tabId: 1 });
  assert.equal((await c.call('firefox_network', { tabId: 1, action: 'read' })).recording, false);
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  browser.webNavigation.onBeforeNavigate.listeners[0]({ tabId: 1, frameId: 0, url: 'https://private.test' });
  assert.equal((await c.call('firefox_network', { tabId: 1, action: 'read' })).recording, false);
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  await c.ui({ action: 'pause' });
  assert.equal((await c.call('firefox_network', { tabId: 1, action: 'stop' })).recording, false);
});

test('wait returns a fresh snapshot and ignores unrelated tab navigation', async () => {
  const { c, browser } = await setup();
  await c.call('firefox_read_page', { tabId: 2 });
  let count = 0;
  browser.scripting.executeScript = async () => {
    browser.webNavigation.onBeforeNavigate.listeners[0]({ tabId: 2, frameId: 0, url: 'https://private.test/next' });
    return [{ result: { snapshotId: String(++count), text: count === 1 ? 'Loading' : 'Ready', elements: count === 1 ? [] : [{ ref: 'e1', label: 'Ready', role: 'button' }] } }];
  };
  const result = await c.call('firefox_wait', { tabId: 1, text: 'ready', role: 'button', timeoutMs: 1000 });
  assert.equal(result.snapshotId, '2');
  assert.equal(result.matches[0].ref, 'e1');
  assert.equal(result.conditionMet, true);
  await assert.rejects(c.call('firefox_wait', { tabId: 1, text: 'Missing', timeoutMs: 0 }), { code: 'WAIT_TIMEOUT' });
});

test('unrelated permission changes preserve recordings while revocation erases them', async () => {
  const { c, browser } = await setup();
  await grant(c);
  let stops = 0;
  browser.scripting.executeScript = async options => {
    if (options.args[0].action === 'stop') stops++;
    return [{ result: { recording: true, entries: [] } }];
  };
  await c.call('firefox_console', { tabId: 1, action: 'start' });
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  await grant(c, 'https://unrelated.test');
  assert.equal((await c.call('firefox_console', { tabId: 1, action: 'read' })).recording, true);
  assert.equal((await c.call('firefox_network', { tabId: 1, action: 'read' })).recording, true);
  assert.equal(stops, 0);
  await c.ui({ action: 'revoke', origin: 'https://allowed.test' });
  assert.equal(stops, 1);
  await grant(c);
  assert.equal((await c.call('firefox_console', { tabId: 1, action: 'read' })).recording, false);
  assert.equal((await c.call('firefox_network', { tabId: 1, action: 'read' })).recording, false);
});

test('network buffers report dropped entries and clearing resets counters', async () => {
  const { c, browser } = await setup();
  await grant(c);
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  for (let i = 0; i < 350; i++) browser.webRequest.onBeforeRequest.listeners[1]({ tabId: 1, requestId: String(i), url: 'https://allowed.test/api', method: 'GET', type: 'xmlhttprequest', timeStamp: i });
  const result = await c.call('firefox_network', { tabId: 1, action: 'read', maxResults: 300 });
  assert.equal(result.entries.length, 300);
  assert.equal(result.dropped, 50);
  assert.equal(result.entries[0].requestId, '50');
  const cleared = await c.call('firefox_network', { tabId: 1, action: 'clear' });
  assert.equal(cleared.entries.length, 0);
  assert.equal(cleared.dropped, 0);
});

test('debug and wait reject invalid queries before injecting code', async () => {
  const { c, browser } = await setup();
  await grant(c);
  browser.scripting.executeScript = async () => { throw new Error('Unexpected injection'); };
  for (const args of [{}, { selector: '#a', ref: 'e1' }, { snapshotId: 's' }]) await assert.rejects(c.call('firefox_inspect', { tabId: 1, ...args }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(c.call('firefox_wait', { tabId: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(c.call('firefox_wait', { tabId: 1, text: 'ready', timeoutMs: -1 }), /Invalid number/);
  await assert.rejects(c.call('firefox_wait', { tabId: 1, text: 'ready', timeoutMs: 10001 }), /Invalid number/);
  await assert.rejects(c.call('firefox_console', { tabId: 1, action: 'start', levels: ['log', 'log'] }), /Duplicate/);
  await assert.rejects(c.call('firefox_inspect', { tabId: 1, selector: '#a', javascript: 'alert(1)' }), /Unexpected argument/);
});

test('wait observes absence and cancels when its own document navigates', async () => {
  const { c, browser } = await setup();
  browser.scripting.executeScript = async () => [{ result: { text: 'Ready', elements: [], snapshotId: 'new' } }];
  assert.equal((await c.call('firefox_wait', { tabId: 1, text: 'Loading', state: 'absent' })).snapshotId, 'new');
  browser.scripting.executeScript = async () => {
    browser.webNavigation.onBeforeNavigate.listeners[0]({ tabId: 1, frameId: 0, url: 'https://allowed.test/next' });
    return [{ result: { text: 'Ready', elements: [] } }];
  };
  await assert.rejects(c.call('firefox_wait', { tabId: 1, text: 'Ready' }), { code: 'NAVIGATION_CHANGED' });
});
