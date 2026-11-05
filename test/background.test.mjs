import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { mockBrowser } from './helpers.mjs';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/background.mjs', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'firefox142'
});

async function startBackground() {
  const mock = mockBrowser();
  const { browser } = mock;
  const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });
  const ports = [];
  let reconnect;
  let initialized;
  const ready = new Promise(resolve => { initialized = resolve; });
  browser.runtime.onMessage = event();
  browser.runtime.connectNative = () => {
    const port = {
      onMessage: event(), onDisconnect: event(), messages: [],
      postMessage(message) { this.messages.push(message); if (message.type === 'hello') initialized(); },
      disconnect() { for (const listener of this.onDisconnect.listeners) listener(); },
      send(name, args, id) {
        return Promise.all(this.onMessage.listeners.map(listener => listener({
          type: 'task', task: { id, name, args, expiresAt: Number.MAX_SAFE_INTEGER }
        })));
      }
    };
    ports.push(port);
    return port;
  };
  browser.storage.local.remove = async () => {};
  const ui = message => browser.runtime.onMessage.listeners[0](message, {
    id: browser.runtime.id, frameId: 0, url: browser.runtime.getURL('panel.html')
  });
  runInNewContext(outputFiles[0].text, {
    browser, crypto, AbortController, URL,
    setTimeout(callback) { reconnect = callback; return 1; },
    clearTimeout() { reconnect = null; }
  });
  await ready;
  await ui({ action: 'resume' });
  return {
    ...mock, ports, ui,
    reconnect() { assert.equal(typeof reconnect, 'function'); const callback = reconnect; reconnect = null; callback(); }
  };
}

for (const reason of ['native disconnect', 'manual reconnect']) {
  test(`${reason} cancels queued mutations and a new connection can read`, { timeout: 5000 }, async t => {
    const { browser, tabs, ports, ui, reconnect } = await startBackground();
    let unblock;
    let entered;
    const began = new Promise(resolve => { entered = resolve; });
    let reads = 0;
    browser.scripting.executeScript = async () => {
      if (++reads === 1) {
        entered();
        await new Promise(resolve => { unblock = resolve; });
      }
      return [{ result: { text: 'Current page content' } }];
    };
    t.after(() => unblock?.());
    const first = ports[0].send('firefox_read_page', { tabId: 1 }, 'blocked-read');
    await Promise.race([began, first.then(() => { throw new Error('The initial read did not reach page execution.'); })]);
    ports[0].disconnect();
    reconnect();
    const mutation = ports[1].send('firefox_tab_action', { tabId: 1, action: 'close' }, 'queued-close');
    if (reason === 'native disconnect') { ports[1].disconnect(); reconnect(); }
    else await ui({ action: 'retry_connection' });
    assert.equal(ports.length, 3);
    unblock();
    await Promise.all([first, mutation]);
    assert.ok(tabs.has(1), 'The disconnected request must not close its tab.');
    assert.equal(ports[0].messages.some(message => message.type === 'result'), false);
    assert.equal(ports[1].messages.some(message => message.type === 'result'), false);
    await ports[2].send('firefox_read_page', { tabId: 1 }, 'fresh-read');
    const results = ports[2].messages.filter(message => message.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].result.id, 'fresh-read');
    assert.equal(results[0].result.ok, true);
    assert.equal(results[0].result.result.text, 'Current page content');
    assert.equal(reads, 2);
  });
}
