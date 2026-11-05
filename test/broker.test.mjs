import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/broker.mjs';

const token = 'b'.repeat(64);
const client = '0d9ac7ca-c491-44dd-99ae-ac5176938faf';
const auth = { Authorization: `Bearer ${token}`, 'X-Firefox-Protocol': '2', 'X-Firefox-Version': '0.3.0' };
async function setup(t, options = {}) {
  const broker = createBroker({ token, port: 0, pollTimeout: 1000, callTimeout: 1000, ...options });
  const address = await broker.start(); t.after(() => broker.close());
  return { broker, url: `http://127.0.0.1:${address.port}` };
}
test('broker requires the correct secret and rejects web page origins', async t => {
  const { url } = await setup(t);
  assert.equal((await fetch(`${url}/health`)).status, 401);
  assert.equal((await fetch(`${url}/health`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${url}/health`, { headers: { ...auth, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(`${url}/health`, { headers: { ...auth, Origin: 'null' } })).status, 403);
  const response = await fetch(`${url}/health`, { headers: auth });
  assert.equal(response.status, 200); assert.ok(!JSON.stringify(await response.json()).includes(token));
});
test('unknown operations and calls without a connected extension are rejected', async t => {
  const { url } = await setup(t);
  const call = body => fetch(`${url}/rpc`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await call({ name: 'firefox_evaluate', args: {} })).status, 400);
  assert.equal((await call({ name: 'firefox_status', args: {} })).status, 503);
});
test('each task is delivered once and responses from other profiles are rejected', async t => {
  const { url } = await setup(t);
  const polling = fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': client } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const rpc = fetch(`${url}/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'firefox_status', args: {} }) });
  const task = await (await polling).json();
  const post = async (who, result) => fetch(`${url}/extension/result`, { method: 'POST', headers: { ...auth, 'X-Firefox-Client': who }, body: JSON.stringify(result) });
  assert.equal((await post('bad-client', { id: task.id, ok: true })).status, 403);
  assert.equal((await post(client, { id: task.id, ok: true, result: { enabled: false } })).status, 200);
  assert.deepEqual((await (await rpc).json()).result, { enabled: false });
  assert.equal((await post(client, { id: task.id, ok: true })).status, 410);
});
test('timeout after delivery reports unknown outcome without replaying the action', async t => {
  const { url } = await setup(t, { callTimeout: 80 });
  const polling = fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': client } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const rpc = fetch(`${url}/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'firefox_status', args: {} }) });
  await polling;
  const response = await rpc;
  assert.equal(response.status, 504); assert.equal((await response.json()).error, 'OUTCOME_UNKNOWN');
});

test('outdated extensions are rejected before delivering calls', async t => {
  const { url } = await setup(t);
  const response = await fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': client, 'X-Firefox-Version': '0.2.1' } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'VERSION_MISMATCH');
  assert.equal((await (await fetch(`${url}/health`, { headers: auth })).json()).extensionOnline, false);
});

test('outdated MCP clients cannot submit requests to an upgraded broker', async t => {
  const { url } = await setup(t);
  await fetch(`${url}/extension/hello`, { method: 'POST', headers: { ...auth, 'X-Firefox-Client': client } });
  const response = await fetch(`${url}/rpc`, { method: 'POST', headers: { ...auth, 'X-Firefox-Protocol': '1', 'X-Firefox-Version': '0.2.1' }, body: JSON.stringify({ name: 'firefox_status', args: {} }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'VERSION_MISMATCH');
  assert.equal((await (await fetch(`${url}/health`, { headers: auth })).json()).pendingCalls, 0);
});

test('cancellation before delivery removes the queued task', async t => {
  const { url } = await setup(t, { pollTimeout: 30 });
  await fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': client } });
  const abort = new AbortController();
  const rpc = fetch(`${url}/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'firefox_status', args: {} }), signal: abort.signal }).catch(() => null);
  const health = async () => (await (await fetch(`${url}/health`, { headers: auth })).json());
  for (let i = 0; i < 100 && !(await health()).pendingCalls; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await health()).pendingCalls, 1);
  abort.abort(); await rpc;
  for (let i = 0; i < 100 && (await health()).pendingCalls; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await health()).pendingCalls, 0);
  assert.equal((await fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': client } })).status, 204);
});

test('switching profiles does not execute pending tasks from the previous profile', async t => {
  const { url } = await setup(t, { pollTimeout: 5, sessionTimeout: 60 });
  await fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': client } });
  const rpc = fetch(`${url}/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'firefox_status', args: {} }) });
  for (let i = 0; i < 20; i++) {
    if ((await (await fetch(`${url}/health`, { headers: auth })).json()).pendingCalls) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await new Promise(resolve => setTimeout(resolve, 70));
  const other = '1d9ac7ca-c491-44dd-99ae-ac5176938faf';
  assert.equal((await fetch(`${url}/extension/poll`, { headers: { ...auth, 'X-Firefox-Client': other } })).status, 204);
  const response = await rpc;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'PROFILE_CHANGED');
});

test('invalid keys and malformed JSON envelopes are rejected', async t => {
  assert.throws(() => createBroker(), /Invalid local key/);
  const { url } = await setup(t);
  for (const value of [null, [], 'text']) {
    assert.equal((await fetch(`${url}/rpc`, { method: 'POST', headers: auth, body: JSON.stringify(value) })).status, 400);
  }
});
