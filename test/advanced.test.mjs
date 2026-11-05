import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/controller.mjs';
import { mockBrowser } from './helpers.mjs';

async function setup() {
  const mock = mockBrowser(); const c = createController(mock.browser, { defaults: { defaultBrowse: 'allow' } }); await c.ready; await c.ui({ action: 'resume' });
  return { ...mock, c };
}
test('custom browsing default allows any site but only the panel can change policy', async () => {
  const { c } = await setup(); assert.equal((await c.call('firefox_status', {})).defaultBrowse, 'allow');
  assert.equal((await c.call('firefox_list_tabs', {})).tabs.length, 2);
  await c.ui({ action: 'decision', origin: 'https://private.test', capabilities: ['read'], decision: 'block' });
  await assert.rejects(c.call('firefox_read_page', { tabId: 2 }), { code: 'SITE_BLOCKED' });
});
test('frames require their own origin permission and reject navigation during reads', async () => {
  const { c, browser } = await setup();
  await c.ui({ action: 'decision', origin: 'https://private.test', capabilities: ['read'], decision: 'block' });
  await assert.rejects(c.call('firefox_read_page', { tabId: 1, frameId: 5 }), { code: 'SITE_BLOCKED' });
  await c.ui({ action: 'revoke', origin: 'https://private.test' });
  browser.scripting.executeScript = async options => { assert.deepEqual(options.target.frameIds, [5]); browser.webNavigation.getFrame = async () => ({ frameId: 5, url: 'https://changed.test' }); return [{ result: { text: 'must be discarded' } }]; };
  await assert.rejects(c.call('firefox_read_page', { tabId: 1, frameId: 5 }), { code: 'NAVIGATION_CHANGED' });
});
test('groups containing blocked tabs are neither exposed nor modified', async () => {
  const { c, browser } = await setup();
  browser.tabGroups = { async query() { return [{ id: 10, title: 'secret' }]; }, async update() { throw new Error('should not happen'); } };
  browser.tabs.group = async () => 10;
  browser.tabs.query = async () => [{ id: 2, url: 'https://private.test', windowId: 1 }];
  await c.ui({ action: 'decision', origin: 'https://private.test', capabilities: ['read'], decision: 'block' });
  assert.deepEqual((await c.call('firefox_tab_group', { action: 'list' })).groups, []);
  await assert.rejects(c.call('firefox_tab_group', { action: 'update', groupId: 10, title: 'updated' }), { code: 'SITE_BLOCKED' });
});
test('downloads require a separate grant and filenames cannot escape the destination', async () => {
  const { c } = await setup();
  await assert.rejects(c.call('firefox_download', { url: 'https://allowed.test/file', filename: 'x.txt' }), { code: 'APPROVAL_REQUIRED' });
  await c.ui({ action: 'decision', origin: 'https://allowed.test', capabilities: ['download'], decision: 'allow' });
  for (const name of ['../secret.txt', 'C:\\secret.txt', 'CON.txt', 'x.']) await assert.rejects(c.call('firefox_download', { url: 'https://allowed.test/file', filename: name }), { code: 'INVALID_FILENAME' });
  await assert.rejects(c.call('firefox_downloads', { action: 'cancel', downloadId: 900 }), { code: 'DOWNLOAD_MISSING' });
});
test('upload requests cannot read local paths and blocks override file selection', async () => {
  const { c, browser } = await setup();
  browser.scripting.executeScript = async () => [{ result: { accept: '.txt', multiple: false, label: 'Attachment' } }];
  const request = await c.call('firefox_upload', { tabId: 1, snapshotId: 's', ref: 'e1' });
  assert.equal(request.status, 'pending_user'); assert.equal((await c.ui({ action: 'state' })).uploads.length, 1);
  await c.ui({ action: 'decision', origin: 'https://allowed.test', capabilities: ['upload'], decision: 'block' });
  let attached = false;
  browser.scripting.executeScript = async () => { attached = true; throw new Error('blocked upload dispatched'); };
  await assert.rejects(c.ui({ action: 'upload_files', requestId: request.requestId, files: [{ name: 'a.txt', type: 'text/plain', data: 'YQ==' }] }), { code: 'REQUEST_EXPIRED' });
  assert.equal((await c.call('firefox_upload_status', { requestId: request.requestId })).status, 'cancelled');
  assert.equal(attached, false);
  await assert.rejects(c.call('firefox_upload', { tabId: 1, snapshotId: 's', ref: 'e1', filePath: 'C:\\secret' }));
});
test('network recording requires debugging, omits queries, and filters unauthorized origins', async () => {
  const { c, browser } = await setup();
  await assert.rejects(c.call('firefox_network', { tabId: 1, action: 'start' }), { code: 'APPROVAL_REQUIRED' });
  await c.ui({ action: 'decision', origin: 'https://allowed.test', capabilities: ['debug'], decision: 'allow' });
  await c.call('firefox_network', { tabId: 1, action: 'start' });
  const listener = browser.webRequest.onBeforeRequest.listeners[1];
  listener({ tabId: 1, requestId: 'a', url: 'https://allowed.test/api?token=SECRET', method: 'GET', type: 'xmlhttprequest', timeStamp: 1 });
  listener({ tabId: 1, requestId: 'b', url: 'https://private.test/api', method: 'GET', timeStamp: 1 });
  const result = await c.call('firefox_network', { tabId: 1, action: 'read' });
  assert.equal(result.entries.length, 1); assert.ok(!JSON.stringify(result).includes('SECRET')); assert.ok(!JSON.stringify(result).includes('private.test'));
});
