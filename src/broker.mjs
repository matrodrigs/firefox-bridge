import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { validateCall } from './contract.mjs';
import { VERSION, PROTOCOL_VERSION } from './version.mjs';

export function createBroker({ token, port = 39281, pollTimeout = 20000, callTimeout = 45000, sessionTimeout = 35000 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Invalid local key.');
  let extension = null;
  let waiter = null;
  let lastSeen = 0;
  const tasks = new Map();
  const key = Buffer.from(`Bearer ${token}`);
  const close = () => new Promise(resolve => {
    if (waiter) { clearTimeout(waiter.timer); send(waiter.res, 503, { error: 'SHUTTING_DOWN' }); waiter = null; }
    for (const task of tasks.values()) { clearTimeout(task.timer); send(task.res, 503, { error: 'OUTCOME_UNKNOWN' }); }
    tasks.clear(); server.close(resolve); server.closeAllConnections();
  });
  const send = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  function authorized(req) {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    return supplied.length === key.length && timingSafeEqual(supplied, key);
  }
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8_000_000) throw new Error('BODY_TOO_LARGE');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value;
  }
  function nextTask(res) {
    for (const task of tasks.values()) {
      if (!task.delivered) { task.delivered = true; task.client = extension; send(res, 200, { id: task.id, name: task.name, args: task.args, expiresAt: task.expiresAt }); return true; }
    }
    return false;
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(res, 403, { error: 'INVALID_HOST' });
      const origin = req.headers.origin;
      if (origin && !/^moz-extension:\/\/[a-f0-9-]+$/i.test(origin)) return send(res, 403, { error: 'WEB_ORIGIN_DENIED' });
      if (!authorized(req)) return send(res, 401, { error: 'AUTHENTICATION_REQUIRED' });
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { service: 'firefox-bridge', version: VERSION, protocolVersion: PROTOCOL_VERSION, extensionOnline: Boolean(extension) && Date.now() - lastSeen < sessionTimeout, pendingCalls: tasks.size });
      if ((req.url?.startsWith('/extension/') || req.url === '/rpc') && (req.headers['x-firefox-protocol'] !== String(PROTOCOL_VERSION) || req.headers['x-firefox-version'] !== VERSION)) return send(res, 409, { error: 'VERSION_MISMATCH', message: 'Update the bridge, reload the extension and restart the MCP client from the same release.' });
      if (req.method === 'POST' && req.url === '/shutdown') {
        if (origin) return send(res, 403, { error: 'LOCAL_PROCESS_ONLY' });
        send(res, 200, { stopped: true }); setTimeout(() => { void close(); }, 50); return;
      }
      if ((req.method === 'GET' && req.url === '/extension/poll') || (req.method === 'POST' && req.url === '/extension/hello')) {
        const client = req.headers['x-firefox-client'];
        if (typeof client !== 'string' || !/^[a-f0-9-]{36}$/.test(client)) return send(res, 400, { error: 'INVALID_CLIENT' });
        if (extension && extension !== client && Date.now() - lastSeen < sessionTimeout) return send(res, 409, { error: 'ANOTHER_PROFILE_CONNECTED' });
        if (extension && extension !== client) {
          for (const task of tasks.values()) { clearTimeout(task.timer); send(task.res, 503, { error: task.delivered ? 'OUTCOME_UNKNOWN' : 'PROFILE_CHANGED' }); }
          tasks.clear();
        }
        extension = client; lastSeen = Date.now();
        if (req.url === '/extension/hello') return send(res, 200, { connected: true });
        if (waiter) { clearTimeout(waiter.timer); send(waiter.res, 204); waiter = null; }
        if (nextTask(res)) return;
        const timer = setTimeout(() => { if (waiter?.res === res) waiter = null; send(res, 204); }, pollTimeout);
        waiter = { res, timer };
        res.on('close', () => { if (waiter?.res === res) { clearTimeout(timer); waiter = null; } });
        return;
      }
      if (req.method === 'POST' && req.url === '/extension/result') {
        if (req.headers['x-firefox-client'] !== extension) return send(res, 403, { error: 'INVALID_CLIENT' });
        const result = await body(req);
        const task = tasks.get(result.id);
        if (!task?.delivered || task.client !== extension) return send(res, 410, { error: 'REQUEST_EXPIRED' });
        if (result.ok !== true && result.ok !== false) return send(res, 400, { error: 'INVALID_RESULT' });
        lastSeen = Date.now(); clearTimeout(task.timer); tasks.delete(task.id);
        send(task.res, 200, result); send(res, 200, { acknowledged: true });
        return;
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        const call = await body(req);
        validateCall(call.name, call.args);
        if (!extension || Date.now() - lastSeen > sessionTimeout) return send(res, 503, { error: 'FIREFOX_DISCONNECTED', message: 'Open Firefox with the extension enabled. Run setup if the native host is not registered.' });
        if (tasks.size >= 20) return send(res, 429, { error: 'QUEUE_FULL' });
        const task = { id: randomUUID(), name: call.name, args: call.args, res, delivered: false, expiresAt: Date.now() + callTimeout };
        task.timer = setTimeout(() => {
          tasks.delete(task.id);
          send(res, 504, { error: task.delivered ? 'OUTCOME_UNKNOWN' : 'REQUEST_TIMEOUT', message: task.delivered ? 'The action may have occurred. Inspect the tab before retrying.' : 'The extension did not receive the action in time.' });
        }, callTimeout);
        tasks.set(task.id, task);
        res.on('close', () => { if (tasks.has(task.id)) { tasks.delete(task.id); clearTimeout(task.timer); } });
        if (waiter) { const current = waiter; waiter = null; clearTimeout(current.timer); nextTask(current.res); }
        return;
      }
      send(res, 404, { error: 'NOT_FOUND' });
    } catch (error) { send(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'INVALID_REQUEST', message: error.message }); }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return {
    server,
    start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); }); }),
    close
  };
}
