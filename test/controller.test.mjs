import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, trustedUiSender } from '../src/controller.mjs';
import { mockBrowser } from './helpers.mjs';

test('queued requests expire before execution instead of replaying late mutations', async () => {
  const { browser } = mockBrowser();
  const controller = createController(browser, { defaults: { defaultBrowse: 'allow' } });
  await controller.ready;
  await controller.ui({ action: 'resume' });
  let unblock;
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  browser.scripting.executeScript = async () => {
    entered();
    await new Promise(resolve => { unblock = resolve; });
    return [{ result: { text: 'Ready' } }];
  };
  const first = controller.call('firefox_read_page', { tabId: 1 });
  await began;
  let updates = 0;
  browser.tabs.update = async () => { updates++; };
  const expired = controller.call('firefox_tab_action', { tabId: 1, action: 'close' }, { expiresAt: Date.now() + 50 });
  await new Promise(resolve => setTimeout(resolve, 75));
  unblock();
  await first;
  await assert.rejects(expired, { code: 'REQUEST_TIMEOUT' });
  assert.equal(updates, 0);
  assert.equal((await browser.tabs.get(1)).id, 1);
});

async function setup(caps = ['read']) {
  const mock = mockBrowser(); const c = createController(mock.browser); await c.ready;
  await c.ui({ action: 'resume' }); await c.ui({ action: 'decision', origin: 'https://allowed.test', capabilities: caps, decision: 'allow' });
  return { ...mock, c };
}
test('only the extension panel can change permissions', () => {
  const { browser } = mockBrowser();
  const sender = { id: browser.runtime.id, frameId: 0, url: browser.runtime.getURL('panel.html') };
  assert.ok(trustedUiSender(browser, sender));
  for (const patch of [{ url: 'https://evil.test/panel.html' }, { frameId: 1 }, { id: 'other@ext' }, { url: browser.runtime.getURL('background.html') }]) assert.equal(trustedUiSender(browser, { ...sender, ...patch }), false);
});
test('tab discovery does not reveal unauthorized URLs or titles', async () => {
  const { c } = await setup(); const result = await c.call('firefox_list_tabs', {});
  assert.equal(result.hiddenTabs, 1); assert.deepEqual(result.tabs.map(t => t.id), [1]);
  assert.ok(!JSON.stringify(result).includes('Secret'));
});
test('requesting access does not grant access; a one-operation grant is consumed once', async () => {
  const { c } = await setup();
  const request = await c.call('firefox_request_access', { url: 'https://private.test', capabilities: ['read'], reason: '<script>not executable</script>' });
  await assert.rejects(c.call('firefox_read_page', { tabId: 2 }), { code: 'APPROVAL_REQUIRED' });
  await c.ui({ action: 'decision', requestId: request.requestId, decision: 'once' });
  assert.ok(await c.call('firefox_read_page', { tabId: 2 }));
  await assert.rejects(c.call('firefox_read_page', { tabId: 2 }), { code: 'APPROVAL_REQUIRED' });
});
test('remote tools cannot change policy or evaluate JavaScript', async () => {
  const { c } = await setup();
  for (const name of ['ui', 'evaluate', 'firefox_set_permissions']) await assert.rejects(c.call(name, {}));
  await assert.rejects(c.call('firefox_read_page', { tabId: 1, javascript: 'bad' }));
});
test('revoking access during a read discards its result', async () => {
  const { c, browser } = await setup();
  browser.scripting.executeScript = async () => { await c.ui({ action: 'revoke', origin: 'https://allowed.test' }); return [{ result: { secret: 'must not escape' } }]; };
  await assert.rejects(c.call('firefox_read_page', { tabId: 1 }), { code: 'AUTHORIZATION_CHANGED' });
});
test('screenshots require every frame permission and discard images after navigation', async () => {
  const { c, browser, tabs } = await setup(['read', 'capture']);
  browser.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, url: tabs.get(1).url }, { frameId: 1, parentFrameId: 0, url: 'https://private.test/frame' }];
  await assert.rejects(c.call('firefox_screenshot', { tabId: 1 }), { code: 'FRAME_APPROVAL_REQUIRED' });
  browser.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, url: tabs.get(1).url }];
  browser.tabs.captureTab = async () => { tabs.get(1).url = 'https://private.test'; return 'data:image/png;base64,secret'; };
  await assert.rejects(c.call('firefox_screenshot', { tabId: 1 }), { code: 'NAVIGATION_CHANGED' });
});
test('unauthorized redirects are blocked only in controlled tabs', async () => {
  const { c } = await setup(['read', 'navigate']);
  await c.call('firefox_read_page', { tabId: 1 });
  assert.deepEqual(c.gateRequest({ tabId: 1, type: 'main_frame', url: 'https://private.test' }), { cancel: true });
  assert.deepEqual(c.gateRequest({ tabId: 1, type: 'main_frame', url: 'https://allowed.test/ok' }), {});
  assert.deepEqual(c.gateRequest({ tabId: 2, type: 'main_frame', url: 'https://private.test' }), {});
  await c.ui({ action: 'release_all' });
  assert.deepEqual(c.gateRequest({ tabId: 1, type: 'main_frame', url: 'https://private.test' }), {});
});
test('private tabs are hidden even when the origin is authorized', async () => {
  const { c, tabs } = await setup(); tabs.get(1).incognito = true;
  assert.equal((await c.call('firefox_list_tabs', {})).tabs.length, 0);
  await assert.rejects(c.call('firefox_read_page', { tabId: 1 }), { code: 'PRIVATE_TAB' });
});
test('history and bookmarks filter origins and respect browser permission revocation', async () => {
  const { c, browser } = await setup();
  assert.equal((await c.call('firefox_history', { query: 'a' })).length, 1);
  assert.equal((await c.call('firefox_bookmarks', { action: 'search', query: 'a' })).length, 1);
  browser.permissions.contains = async () => false;
  await assert.rejects(c.call('firefox_history', { query: 'a' }), { code: 'BROWSER_PERMISSION_REQUIRED' });
});
test('audit omits field values and URL query parameters', async () => {
  const { c, storage } = await setup(['read', 'interact']);
  await c.call('firefox_fill', { tabId: 1, snapshotId: 's', ref: 'e1', value: 'CONFIDENTIAL' });
  assert.ok(!JSON.stringify(storage.audit).includes('CONFIDENTIAL'));
});

test('failed mutating injections report uncertain outcomes without replaying effects', async t => {
  for (const failure of ['rejection', 'injection error', 'missing result']) await t.test(failure, async () => {
    const { c, browser, storage } = await setup(['read', 'interact']);
    let effects = 0;
    browser.scripting.executeScript = async () => {
      effects++;
      if (failure === 'rejection') throw new Error('The document was destroyed after pointerdown.');
      if (failure === 'injection error') return [{ error: { message: 'Element removed after pointerdown.' } }];
      return [];
    };
    await assert.rejects(c.call('firefox_click', { tabId: 1, snapshotId: 'observed', ref: 'e1' }), error => {
      assert.equal(error.code, 'ACTION_OUTCOME_UNCERTAIN');
      assert.match(error.message, /Inspect the tab before repeating/);
      assert.match(error.details.cause, failure === 'missing result' ? /valid result/ : /pointerdown/);
      return true;
    });
    assert.equal(effects, 1);
    assert.equal(storage.audit.at(-1).code, 'ACTION_OUTCOME_UNCERTAIN');
  });
});

test('read-only injection failures and preflight denials do not imply an action occurred', async () => {
  const { c, browser } = await setup(['read']);
  let injections = 0;
  browser.scripting.executeScript = async () => { injections++; throw new Error('Read context disappeared.'); };
  await assert.rejects(c.call('firefox_read_page', { tabId: 1 }), { code: 'PAGE_ERROR' });
  await assert.rejects(c.call('firefox_click', { tabId: 1, snapshotId: 'observed', ref: 'e1' }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(injections, 1);
});

test('read-only context navigation failures preserve their navigation error', async () => {
  const { c, browser, tabs } = await setup(['read']);
  browser.scripting.executeScript = async () => { tabs.get(1).url = 'https://allowed.test/changed'; return [{ result: { title: 'Old title' } }]; };
  await assert.rejects(c.call('firefox_context', { tabId: 1 }), { code: 'NAVIGATION_CHANGED' });
});
