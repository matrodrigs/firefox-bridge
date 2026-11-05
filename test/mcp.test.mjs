import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBroker } from '../src/broker.mjs';
import { TOOLS } from '../src/contract.mjs';

test('real MCP starts, discovers tools and resources, and forwards extension errors', async t => {
  const work = resolve('test-artifacts/firefox-bridge-validation'); await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, 'mcp-'));
  const token = 'a'.repeat(64); await writeFile(join(dir, 'connection-key'), token);
  const broker = createBroker({ token, port: 0 }); const address = await broker.start(); t.after(() => broker.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.cjs')], env: { ...process.env, FIREFOX_BRIDGE_DATA_DIR: dir, FIREFOX_BRIDGE_PORT: String(address.port) }, stderr: 'pipe' });
  const client = new Client({ name: 'firefox-bridge-validation', version: '1.0.0' });
  t.after(() => client.close()); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, TOOLS.length);
  assert.deepEqual((await client.listResources()).resources, []);
  const result = await client.callTool({ name: 'firefox_status', arguments: {} });
  assert.equal(result.isError, true); assert.ok(JSON.stringify(result).includes('FIREFOX_DISCONNECTED'));
});
