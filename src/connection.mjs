import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { loadRuntime, BASE_URL } from './runtime.mjs';
import { VERSION, PROTOCOL_VERSION } from './version.mjs';

export async function connectBroker() {
  const { token } = await loadRuntime();
  async function health() {
    try { const response = await fetch(`${BASE_URL}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) }); const data = await response.json(); return response.ok && data.service === 'firefox-bridge' && data.protocolVersion === PROTOCOL_VERSION && data.version === VERSION; } catch { return false; }
  }
  if (!await health()) {
    const child = spawn(process.execPath, [join(dirname(process.argv[1]), 'broker.cjs')], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }); child.unref();
    let online = false;
    for (let i = 0; i < 40; i++) { if (await health()) { online = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    if (!online) throw new Error(`Could not start the bridge at ${BASE_URL}. Check the port or restart the bridge after updating.`);
  }
  return async (name, args) => {
    const response = await fetch(`${BASE_URL}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Firefox-Protocol': String(PROTOCOL_VERSION), 'X-Firefox-Version': VERSION }, body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(50000) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error?.message ?? data.message ?? String(data.error)), { details: typeof data.error === 'object' ? data.error : { code: data.error, message: data.message } });
    return data.result;
  };
}
