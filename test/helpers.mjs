export function mockBrowser() {
  const storage = {};
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://allowed.test/page', title: 'Allowed', active: true, status: 'complete', incognito: false }], [2, { id: 2, windowId: 1, url: 'https://private.test/secret', title: 'Secret', status: 'complete', incognito: false }]]);
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const browser = {
    runtime: { id: 'test@local', getManifest: () => ({ version: '0.1.0' }), getURL: path => `moz-extension://abc/${path}` },
    storage: { local: { async get(keys) { return Object.fromEntries(keys.map(k => [k, storage[k]])); }, async set(value) { Object.assign(storage, structuredClone(value)); } } },
    browserAction: { async setBadgeText() {} },
    permissions: { async contains() { return true; } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('Tab not found'); return { ...tabs.get(id) }; },
      async query() { return [...tabs.values()].map(t => ({ ...t })); },
      async create(options) { const tab = { id: 3, status: 'complete', ...options }; tabs.set(3, tab); return tab; },
      async update(id, value) { Object.assign(tabs.get(id), value); return tabs.get(id); },
      async captureTab() { return 'data:image/png;base64,aGVsbG8='; },
      async remove(id) { tabs.delete(id); }, async reload() {}, onCreated: event(), onRemoved: event()
    },
    webRequest: { onBeforeRequest: event() },
    webNavigation: { onBeforeNavigate: event(), async getFrame({tabId,frameId}) { return { frameId, url: frameId ? 'https://private.test/frame' : tabs.get(tabId).url }; }, async getAllFrames() { return [{ frameId: 0, parentFrameId: -1, url: tabs.get(1).url }]; } },
    scripting: { async executeScript() { return [{ result: { text: 'authorized content' } }]; } },
    bookmarks: { async search() { return [{ id: 'a', title: 'Allowed', url: tabs.get(1).url }, { id: 'b', title: 'Secret', url: tabs.get(2).url }]; }, async create(value) { return value; } },
    history: { async search() { return [{ id: 'a', title: 'Allowed', url: tabs.get(1).url }, { id: 'b', title: 'Secret', url: tabs.get(2).url }]; } }
  };
  return { browser, tabs, storage };
}
