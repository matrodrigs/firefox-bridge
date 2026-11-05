export function consoleOperation(request) {
  const key = '__firefoxBridgeConsole';
  let state = globalThis[key];
  if (request.action === 'stop') {
    if (state?.sessionId === request.sessionId) state.stop();
    return { recording: false, entries: [] };
  }
  if (location.href !== request.expectedUrl) throw new Error('The page changed. Restart console recording.');
  if (request.action === 'start') {
    state?.stop?.();
    const entries = [];
    const original = new Map();
    const wrappers = new Map();
    const expires = Date.now() + 900000;
    let sequence = 0;
    let dropped = 0;
    const plain = value => {
      if (value === null) return 'null';
      if (['string', 'number', 'boolean', 'undefined', 'bigint'].includes(typeof value)) return String(value).slice(0, 2000);
      if (value instanceof Error) {
        const message = Object.getOwnPropertyDescriptor(value, 'message');
        if (typeof message?.value === 'string') return message.value.slice(0, 2000);
      }
      return `[${typeof value}]`;
    };
    const append = (level, values, source = {}) => {
      if (Date.now() >= expires) { state.stop(); return; }
      entries.push({ sequence: ++sequence, time: Date.now(), level, text: values.slice(0, 10).map(plain).join(' ').slice(0, 2000), ...source });
      if (entries.length > 200) { entries.shift(); dropped++; }
    };
    const onError = event => {
      if (typeof event.message !== 'string') return;
      let source = null;
      try { const url = new URL(event.filename); if (/^https?:$/.test(url.protocol)) source = url.origin + url.pathname; } catch {}
      append('exception', [event.message], { source, line: event.lineno, column: event.colno });
    };
    const onRejection = event => append('rejection', [event.reason]);
    const stop = () => {
      clearTimeout(state.timer);
      for (const [level, fn] of original) if (console[level] === wrappers.get(level)) console[level] = fn;
      removeEventListener('error', onError, true);
      removeEventListener('unhandledrejection', onRejection);
      entries.length = 0;
      if (globalThis[key] === state) delete globalThis[key];
    };
    state = { sessionId: request.sessionId, entries, stop, expires, dropped: () => dropped, clear: () => { entries.length = 0; dropped = 0; } };
    globalThis[key] = state;
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const fn = console[level];
      if (typeof fn !== 'function') continue;
      const wrapper = function (...values) { append(level, values); return Reflect.apply(fn, this, values); };
      original.set(level, fn);
      wrappers.set(level, wrapper);
      console[level] = wrapper;
    }
    addEventListener('error', onError, true);
    addEventListener('unhandledrejection', onRejection);
    state.timer = setTimeout(stop, 900000);
  }
  if (!state || state.sessionId !== request.sessionId) return { recording: false, entries: [] };
  if (Date.now() >= state.expires) { state.stop(); return { recording: false, entries: [] }; }
  if (request.action === 'clear') state.clear();
  return { recording: true, expires: state.expires, dropped: state.dropped(), entries: state.entries.filter(x => !request.levels || request.levels.includes(x.level)).slice(-(request.maxResults ?? 100)) };
}
