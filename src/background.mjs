import { createController, trustedUiSender } from './controller.mjs';
import defaults from '../extension/user-defaults.json';
import { VERSION, PROTOCOL_VERSION } from './version.mjs';

const controller = createController(browser, { defaults });
const hostName = 'io.github.matrodrigs.firefox_bridge';
let port = null;
let portLifetime = null;
let clientId = '';
let retryTimer = null;
let retryDelay = 500;
let connection = { paired: false, label: 'Connecting', error: '', mode: 'native' };

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10000);
}

function connect() {
  if (port || !clientId) return;
  try {
    const current = browser.runtime.connectNative(hostName);
    const lifetime = new AbortController();
    port = current;
    portLifetime = lifetime;
    current.onMessage.addListener(async message => {
      if (port !== current) return;
      if (message.type === 'status') {
        connection = { paired: message.connected === true, label: message.connected ? 'Connected' : 'Reconnecting', error: message.error ?? '', mode: 'native' };
        if (message.connected) retryDelay = 500;
        return;
      }
      if (message.type !== 'task') return;
      const task = message.task;
      let result;
      try {
        if (!Number.isFinite(task.expiresAt) || task.expiresAt <= Date.now()) throw Object.assign(new Error('The request expired before execution.'), { code: 'REQUEST_TIMEOUT' });
        result = { id: task.id, ok: true, result: await controller.call(task.name, task.args, { expiresAt: task.expiresAt, signal: lifetime.signal }) };
      } catch (error) { result = { id: task.id, ok: false, error: { code: error.code ?? 'OPERATION_FAILED', message: error.message, details: error.details ?? {} } }; }
      if (port === current) {
        try { current.postMessage({ type: 'result', result }); } catch { connection.paired = false; }
      }
    });
    current.onDisconnect.addListener(() => {
      lifetime.abort();
      if (port !== current) return;
      port = null;
      connection = { paired: false, label: 'Setup needed', error: current.error?.message ? 'Run the local setup, then keep its folder in place. Connection retries automatically.' : 'Local connection interrupted. Reconnecting automatically.', mode: 'native' };
      scheduleReconnect();
    });
    current.postMessage({ type: 'hello', clientId, version: VERSION, protocolVersion: PROTOCOL_VERSION });
  } catch {
    portLifetime?.abort();
    port = null;
    connection = { paired: false, label: 'Setup needed', error: 'Run npm run setup in the project folder. Connection retries automatically.', mode: 'native' };
    scheduleReconnect();
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!trustedUiSender(browser, sender)) return undefined;
  return (async () => {
    try {
      if (message.action === 'retry_connection') {
        portLifetime?.abort();
        const previous = port; port = null; previous?.disconnect();
        clearTimeout(retryTimer); retryDelay = 500; connect();
        return { ok: true };
      }
      const result = await controller.ui(message);
      return message.action === 'state' ? { ...result, connection, version: VERSION } : result;
    } catch (error) { return { error: error.message }; }
  })();
});

async function initialize() {
  await controller.ready;
  const stored = await browser.storage.local.get(['clientId']);
  clientId = stored.clientId ?? crypto.randomUUID();
  await browser.storage.local.set({ clientId });
  await browser.storage.local.remove('brokerToken');
  connect();
}
void initialize();
