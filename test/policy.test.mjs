import test from 'node:test';
import assert from 'node:assert/strict';
import { Policy, originOf } from '../src/policy.mjs';

test('origins include exact scheme and port; embedded credentials and special schemes are rejected', () => {
  assert.equal(originOf('HTTPS://EXAMPLE.COM:443/path?q=secret'), 'https://example.com');
  assert.notEqual(originOf('http://example.com'), originOf('https://example.com'));
  assert.notEqual(originOf('http://localhost:8000'), originOf('http://localhost:8001'));
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'about:config', 'data:text/plain,hello', 'https://u:p@example.com', '*.example.com']) assert.throws(() => originOf(url));
});

test('no operation is authorized initially', () => {
  const p = new Policy();
  assert.throws(() => p.authorize('https://example.com', ['read']), { code: 'PAUSED' });
  p.resume();
  assert.throws(() => p.authorize('https://example.com', ['read']), { code: 'APPROVAL_REQUIRED' });
});

test('an approved origin does not authorize subdomains or another scheme or port', () => {
  const p = new Policy(); p.resume(); p.configure('https://example.com', ['read'], 'allow');
  assert.ok(p.authorize('https://example.com/path', ['read']));
  for (const url of ['https://sub.example.com', 'http://example.com', 'https://example.com:8443', 'https://example.com.evil.test']) assert.throws(() => p.authorize(url, ['read']), { code: 'APPROVAL_REQUIRED' });
});

test('read permission does not imply interaction or capture permission', () => {
  const p = new Policy(); p.resume(); p.configure('https://example.com', ['read'], 'allow');
  for (const cap of ['interact', 'capture', 'navigate']) assert.throws(() => p.authorize('https://example.com', ['read', cap]), { code: 'APPROVAL_REQUIRED' });
});

test('one-operation grants are consumed atomically and expire', () => {
  let now = 100; const p = new Policy({ clock: () => now }); p.resume();
  p.grantOnce('https://example.com', ['read', 'interact']);
  const ticket = p.authorize('https://example.com', ['read', 'interact']);
  p.verify(ticket, 'https://example.com/path');
  assert.throws(() => p.authorize('https://example.com', ['read']), { code: 'APPROVAL_REQUIRED' });
  p.grantOnce('https://example.com', ['read']); now += 300001;
  assert.throws(() => p.authorize('https://example.com', ['read']), { code: 'APPROVAL_REQUIRED' });
});

test('explicit blocks override grants and pausing invalidates tickets', () => {
  const p = new Policy(); p.resume(); p.configure('https://example.com', ['read'], 'allow');
  const ticket = p.authorize('https://example.com', ['read']);
  p.configure('https://example.com', ['read'], 'block');
  assert.throws(() => p.verify(ticket, 'https://example.com'), { code: 'AUTHORIZATION_CHANGED' });
  assert.throws(() => p.grantOnce('https://example.com', ['read']), { code: 'SITE_BLOCKED' });
  p.configure('https://example.com', ['read'], 'allow');
  const second = p.authorize('https://example.com', ['read']); p.pause(); p.resume();
  assert.throws(() => p.verify(second, 'https://example.com'), { code: 'AUTHORIZATION_CHANGED' });
});

test('persistence does not restore temporary grants and discards invalid rules', () => {
  const p = new Policy(); p.load({ enabled: true, rules: { 'file:///bad': { read: 'allow' }, 'https://ok.test': { read: 'allow', interact: 'unexpected' } } });
  assert.deepEqual(Object.keys(p.rules), ['https://ok.test']);
  assert.equal(p.rules['https://ok.test'].interact, 'ask');
});

test('allowing all sites preserves blocks, pause state, and separate capabilities', () => {
  const p = new Policy(); p.load({ enabled: true, defaultBrowse: 'allow' });
  assert.ok(p.authorize('https://any.test', ['read', 'interact', 'navigate', 'capture']));
  for (const cap of ['download', 'upload', 'debug']) assert.throws(() => p.authorize('https://any.test', [cap]), { code: 'APPROVAL_REQUIRED' });
  p.configure('https://blocked.test', ['read', 'interact', 'navigate', 'capture'], 'block');
  assert.throws(() => p.authorize('https://blocked.test', ['read']), { code: 'SITE_BLOCKED' });
  p.configure('https://ask.test', ['read'], 'ask');
  assert.throws(() => p.authorize('https://ask.test', ['read']), { code: 'APPROVAL_REQUIRED' });
  p.configure('https://ask.test', ['read'], 'inherit'); assert.ok(p.authorize('https://ask.test', ['read']));
  p.pause(); assert.throws(() => p.authorize('https://any.test', ['read']), { code: 'PAUSED' });
});
