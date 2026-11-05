import { BridgeError, originOf } from './policy.mjs';
import { consoleOperation } from './console-page.mjs';
import { debugPageOperation } from './debug-page.mjs';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'exception', 'rejection'];

export function createDebugging({ browser, policy, managed, getTab, verify }) {
  const sessions = new Map();
  const keyOf = (tabId, frameId = 0) => `${tabId}:${frameId}`;

  async function inject(target, func, args, world = 'ISOLATED') {
    await verify(target);
    const result = await browser.scripting.executeScript({ target: { tabId: target.tab.id, frameIds: [target.frame.frameId] }, world, func, args: [{ ...args, expectedUrl: target.frame.url }] });
    await verify(target);
    if (result.length !== 1 || result[0].error || !result[0].result) throw new BridgeError('DEBUG_ERROR', result[0]?.error?.message ?? 'The debug query failed.');
    return result[0].result;
  }

  async function stopSession(session) {
    const key = keyOf(session.tabId, session.frameId);
    if (sessions.get(key) === session) sessions.delete(key);
    try {
      await browser.scripting.executeScript({ target: { tabId: session.tabId, frameIds: [session.frameId] }, world: 'MAIN', func: consoleOperation, args: [{ action: 'stop', sessionId: session.id, expectedUrl: session.url }] });
    } catch {}
  }

  async function clear(tabId, frameId) {
    const targets = [...sessions.values()].filter(x => (tabId === undefined || x.tabId === tabId) && (frameId === undefined || x.frameId === frameId));
    await Promise.all(targets.map(stopSession));
  }

  async function call(name, args) {
    const key = keyOf(args.tabId, args.frameId);
    if (name === 'firefox_console' && args.action === 'stop') {
      const existing = sessions.get(key);
      if (existing) await stopSession(existing);
      return { recording: false, entries: [] };
    }
    const target = await getTab(args.tabId, ['read', 'debug'], args.frameId ?? 0);
    if (name === 'firefox_inspect') {
      if (args.selector ? args.ref !== undefined || args.snapshotId !== undefined : !args.ref || !args.snapshotId) throw new BridgeError('INVALID_ARGUMENT', 'Use selector or the snapshotId/ref pair.');
      return { ...await inject(target, debugPageOperation, { ...args, action: 'inspect' }), frameId: target.frame.frameId };
    }
    if (name === 'firefox_performance') {
      const result = await inject(target, debugPageOperation, { action: 'performance' });
      const allowed = result.resources.filter(item => item.url && (originOf(item.url) === target.frameTicket.origin || policy.can(item.url, ['read', 'debug'])));
      return { ...result, resources: allowed.slice(-(args.maxResults ?? 100)), hiddenResources: result.resources.length - allowed.length, truncated: allowed.length > (args.maxResults ?? 100), frameId: target.frame.frameId };
    }
    let session = sessions.get(key);
    if (session && (session.url !== target.frame.url || session.version !== policy.version || session.expires < Date.now() || !managed.has(args.tabId))) { await stopSession(session); session = null; }
    if (args.action === 'start') {
      if (!policy.can(target.ticket.origin, ['read']) || !policy.can(target.frameTicket.origin, ['read', 'debug'])) throw new BridgeError('PERSISTENT_DEBUG_REQUIRED', 'Continuous recording requires persistent read access to the tab and debug access to the frame. One-operation grants only allow individual queries.');
      if (session) await stopSession(session);
      await Promise.all([...sessions.values()].filter(item => item.expires < Date.now()).map(stopSession));
      if (sessions.size >= 20) throw new BridgeError('TOO_MANY_SESSIONS', 'Stop another recording before starting a new one.');
      session = { id: crypto.randomUUID(), tabId: args.tabId, frameId: target.frame.frameId, url: target.frame.url, topOrigin: target.ticket.origin, version: policy.version, expires: Date.now() + 900000 };
      sessions.set(key, session);
    }
    if (!session) return { recording: false, entries: [], contentTrust: 'untrusted_webpage' };
    let result;
    try {
      result = await inject(target, consoleOperation, { ...args, sessionId: session.id }, 'MAIN');
      if (sessions.get(key) !== session || !managed.has(args.tabId)) throw new BridgeError('DEBUG_SESSION_ENDED', 'Recording was stopped while the request was in flight.');
    }
    catch (error) { await stopSession(session); throw error; }
    if (!result.recording) await stopSession(session);
    const entries = Array.isArray(result.entries) ? result.entries.slice(-200).filter(x => x && LEVELS.includes(x.level)).map(x => ({
      sequence: Number.isSafeInteger(x.sequence) ? x.sequence : null,
      time: Number.isFinite(x.time) ? x.time : null,
      level: x.level, text: typeof x.text === 'string' ? x.text.slice(0, 2000) : '',
      ...(typeof x.source === 'string' ? { source: cleanSource(x.source), line: Number.isSafeInteger(x.line) ? x.line : null, column: Number.isSafeInteger(x.column) ? x.column : null } : {})
    })).filter(x => !args.levels || args.levels.includes(x.level)).slice(-(args.maxResults ?? 100)) : [];
    return { recording: result.recording === true, expires: session.expires, dropped: Number.isSafeInteger(result.dropped) && result.dropped >= 0 ? result.dropped : 0, entries, frameId: session.frameId, contentTrust: 'untrusted_webpage', source: 'page_instrumentation' };
  }

  function cleanSource(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? (url.origin + url.pathname).slice(0, 2000) : null; }
    catch { return null; }
  }

  async function onPolicyChanged() {
    const stopped = [];
    for (const session of sessions.values()) {
      if (!managed.has(session.tabId) || !policy.can(session.topOrigin, ['read']) || !policy.can(session.url, ['read', 'debug'])) stopped.push(stopSession(session));
      else session.version = policy.version;
    }
    await Promise.all(stopped);
  }

  return { handles: name => ['firefox_console', 'firefox_inspect', 'firefox_performance'].includes(name), call, clear, onPolicyChanged };
}
