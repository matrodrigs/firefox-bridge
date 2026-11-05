import { loadRuntime, BASE_URL } from './runtime.mjs';
import { connectBroker } from './connection.mjs';
import { VERSION, PROTOCOL_VERSION } from './version.mjs';
import { createMessageDecoder, encodeMessage } from './native-protocol.mjs';

const lifetime = new AbortController();
let pending = null;
let started = false;
let stopped = false;
const send = message => { if (!stopped) process.stdout.write(encodeMessage(message)); };
const stop = () => { stopped = true; lifetime.abort(); pending?.resolve(null); };
process.stdin.on('end', stop);
process.stdout.on('error', stop);

async function run(hello) {
  if (hello.version !== VERSION || hello.protocolVersion !== PROTOCOL_VERSION) throw new Error('Update the extension and run setup from the matching release.');
  if (!/^[a-f0-9-]{36}$/.test(hello.clientId ?? '')) throw new Error('Invalid Firefox profile identifier.');
  const { token } = await loadRuntime();
  const headers = { Authorization: `Bearer ${token}`, 'X-Firefox-Client': hello.clientId, 'X-Firefox-Protocol': String(PROTOCOL_VERSION), 'X-Firefox-Version': VERSION };
  let retry = 500;
  let connected = false;
  while (!stopped) {
    try {
      await connectBroker();
      if (!connected) {
        const helloResponse = await fetch(`${BASE_URL}/extension/hello`, { method: 'POST', headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]) });
        if (!helloResponse.ok) {
          const failure = await helloResponse.json();
          throw new Error(failure.error === 'ANOTHER_PROFILE_CONNECTED' ? 'Another Firefox profile is connected. Close that profile first.' : failure.message ?? failure.error);
        }
        connected = true;
        send({ type: 'status', connected: true, version: VERSION });
      }
      const response = await fetch(`${BASE_URL}/extension/poll`, { headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error === 'ANOTHER_PROFILE_CONNECTED' ? 'Another Firefox profile is connected. Close that profile first.' : error.message ?? error.error);
      }
      send({ type: 'status', connected: true, version: VERSION });
      retry = 500;
      if (response.status === 204) continue;
      const task = await response.json();
      let timer;
      const result = await new Promise(resolve => {
        pending = { id: task.id, resolve };
        timer = setTimeout(() => resolve(null), Math.max(0, task.expiresAt - Date.now()) + 1000);
        send({ type: 'task', task });
      });
      clearTimeout(timer); pending = null;
      if (!result || stopped) continue;
      const posted = await fetch(`${BASE_URL}/extension/result`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]) });
      if (!posted.ok && posted.status !== 410) throw new Error('The result could not be delivered. Check the page before repeating the action.');
    } catch (error) {
      connected = false;
      if (stopped) break;
      send({ type: 'status', connected: false, error: error.message });
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, retry);
        lifetime.signal.addEventListener('abort', done, { once: true });
      });
      retry = Math.min(retry * 2, 8000);
    }
  }
}

const decode = createMessageDecoder(message => {
  if (message.type === 'hello' && !started) {
    started = true;
    void run(message).catch(error => { send({ type: 'status', connected: false, error: error.message }); stop(); process.stdin.destroy(); });
  } else if (message.type === 'result' && pending?.id === message.result?.id) pending.resolve(message.result);
});
process.stdin.on('data', chunk => {
  try { decode(chunk); } catch (error) { process.stderr.write(`${error.message}\n`); stop(); process.stdin.destroy(); }
});
