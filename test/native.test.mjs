import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createMessageDecoder, encodeMessage } from '../src/native-protocol.mjs';
import { createBroker } from '../src/broker.mjs';
import { VERSION, PROTOCOL_VERSION } from '../src/version.mjs';

test('native framing handles fragmented UTF-8, concatenated messages, and invalid envelopes', () => {
  const results = [];
  const decode = createMessageDecoder(message => results.push(message));
  const bytes = Buffer.concat([encodeMessage({ text: 'Testing 🔥' }), encodeMessage({ id: 2 })]);
  for (let index = 0; index < bytes.length; index += 3) decode(bytes.subarray(index, index + 3));
  assert.deepEqual(results, [{ text: 'Testing 🔥' }, { id: 2 }]);
  assert.throws(() => createMessageDecoder(() => {})(Buffer.alloc(4)), /length/);
  assert.throws(() => createMessageDecoder(() => {}, 8)(encodeMessage({ text: 'too large' })), /length/);
  assert.throws(() => createMessageDecoder(() => {})(encodeMessage(null)), /object/);
  assert.throws(() => encodeMessage({ text: 'x'.repeat(1024 * 1024) }), /1 MiB/);
});

test('native host relays a real broker request and exits when Firefox closes stdin', async t => {
  await mkdir('test-artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('test-artifacts/native-'));
  const token = 'c'.repeat(64);
  await writeFile(join(directory, 'connection-key'), token);
  const broker = createBroker({ token, port: 0, pollTimeout: 50 });
  const address = await broker.start();
  t.after(() => broker.close());
  const child = spawn(process.execPath, [resolve('dist/native-host.cjs')], { env: { ...process.env, FIREFOX_BRIDGE_PORT: String(address.port), FIREFOX_BRIDGE_DATA_DIR: directory }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const messages = [];
  child.stdout.on('data', createMessageDecoder(message => {
    messages.push(message);
    if (message.type === 'task') child.stdin.write(encodeMessage({ type: 'result', result: { id: message.task.id, ok: true, result: { native: true } } }));
  }));
  child.stdin.write(encodeMessage({ type: 'hello', version: VERSION, protocolVersion: PROTOCOL_VERSION, clientId: '4d9ac7ca-c491-44dd-99ae-ac5176938faf' }));
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'X-Firefox-Protocol': String(PROTOCOL_VERSION), 'X-Firefox-Version': VERSION };
  for (let i = 0; i < 100 && !messages.some(message => message.connected); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(messages.some(message => message.connected), errors || JSON.stringify(messages));
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers, body: JSON.stringify({ name: 'firefox_status', args: {} }), signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await response.json()).result, { native: true });
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  assert.equal(await Promise.race([exit, new Promise(resolve => { const timer = setTimeout(() => resolve('timeout'), 2000); timer.unref(); })]), 0);
});
