import { BridgeError, originOf } from './policy.mjs';

const NAMES = ['firefox_frames', 'firefox_point', 'firefox_find', 'firefox_context', 'firefox_media', 'firefox_tab_group', 'firefox_download', 'firefox_downloads', 'firefox_upload', 'firefox_upload_status', 'firefox_network', 'firefox_tab_history'];
const MAX_FILE = 20 * 1024 * 1024;

export function createAdvanced({ browser, policy, managed, getTab, verify, page, log }) {
  const images = new Map();
  const uploads = new Map();
  const downloads = new Map();
  const network = new Map();

  function recordRequest(details, stage = 'start') {
    const session = network.get(details.tabId);
    if (!session) return;
    if (session.expires < Date.now() || session.version !== policy.version || !managed.has(details.tabId) || !policy.can(session.origin, ['read', 'debug'])) { network.delete(details.tabId); return; }
    if (details.incognito) return;
    let origin;
    try { origin = originOf(details.url); } catch { return; }
    if (!policy.can(origin, ['read', 'debug'])) return;
    const url = new URL(details.url);
    let item = session.entries.find(x => x.requestId === details.requestId && x.url === url.origin + url.pathname);
    if (!item) {
      item = { requestId: details.requestId, origin, url: url.origin + url.pathname, method: details.method, type: details.type, time: details.timeStamp, startedAt: stage === 'start' ? details.timeStamp : null, status: null, error: null, durationMs: null, state: 'pending' };
      session.entries.push(item);
      if (session.entries.length > 300) { session.entries.shift(); session.dropped++; }
    }
    if (stage !== 'start') {
      item.status = details.statusCode ?? null;
      item.error = details.error ?? null;
      item.endedAt = details.timeStamp;
      item.durationMs = item.startedAt !== null ? Math.max(0, Math.round((details.timeStamp - item.startedAt) * 100) / 100) : null;
      item.fromCache = details.fromCache === true;
      item.state = stage;
    }
  }
  browser.webRequest.onBeforeRequest.addListener(recordRequest, { urls: ['<all_urls>'] });
  for (const [name, stage] of [['onCompleted', 'completed'], ['onErrorOccurred', 'failed'], ['onBeforeRedirect', 'redirected']]) browser.webRequest[name]?.addListener(details => recordRequest(details, stage), { urls: ['<all_urls>'] });

  async function optional(permission) {
    if (!await browser.permissions.contains({ permissions: [permission] })) throw new BridgeError('BROWSER_PERMISSION_REQUIRED', `Enable ${permission} in the Firefox Bridge panel.`);
  }
  async function authorizedTabs(ids, capabilities) {
    if (!ids?.length) throw new BridgeError('INVALID_ARGUMENT', 'Provide tab IDs.');
    const targets = [];
    for (const id of ids) targets.push(await getTab(id, capabilities));
    for (const target of targets) await verify(target);
    return targets;
  }

  async function group(args) {
    await optional('tabGroups');
    if (!browser.tabGroups || !browser.tabs.group) throw new BridgeError('UNSUPPORTED_API', 'This Firefox version does not expose tab groups to extensions.');
    if (args.action === 'list') {
      const groups = await browser.tabGroups.query({}); const result = [];
      for (const group of groups) {
        const tabs = await browser.tabs.query({ groupId: group.id });
        if (!tabs.length || tabs.some(t => t.incognito || !policy.can(t.url, ['read']))) continue;
        result.push({ ...group, tabIds: tabs.map(t => t.id) });
      }
      return { groups: result, hiddenGroups: groups.length - result.length };
    }
    let ids = args.tabIds;
    if (args.groupId !== undefined) {
      const members = await browser.tabs.query({ groupId: args.groupId });
      if (!members.length) throw new BridgeError('GROUP_MISSING', 'Group not found.');
      await authorizedTabs(members.map(t => t.id), ['read', 'interact']);
      if (!ids) ids = members.map(t => t.id);
    }
    const targets = await authorizedTabs(ids, ['read', 'interact']);
    if (new Set(targets.map(t => t.tab.windowId)).size !== 1) throw new BridgeError('INVALID_ARGUMENT', 'Tabs must belong to the same window.');
    if (args.action === 'ungroup') { await browser.tabs.ungroup(ids); return { ungrouped: ids }; }
    let groupId = args.groupId;
    if (args.action === 'create') groupId = await browser.tabs.group({ tabIds: ids, ...(groupId !== undefined ? { groupId } : {}) });
    if (groupId === undefined) throw new BridgeError('INVALID_ARGUMENT', 'Provide a group ID.');
    const properties = Object.fromEntries(['title', 'color', 'collapsed'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    if (Object.keys(properties).length) return browser.tabGroups.update(groupId, properties);
    return { groupId, tabIds: ids };
  }

  async function download(args) {
    await optional('downloads');
    const origin = originOf(args.url);
    const ticket = policy.authorize(origin, ['read', 'download']);
    if (/[\\/:<>"|?*]/.test(args.filename) || [...args.filename].some(character => character.charCodeAt(0) < 32) || args.filename === '.' || args.filename === '..' || /[. ]$/.test(args.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(args.filename)) throw new BridgeError('INVALID_FILENAME', 'Use a valid file name without directories.');
    let response;
    try { response = await fetch(args.url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(25000) }); }
    catch { throw new BridgeError('DOWNLOAD_FETCH_FAILED', 'File fetch failed. Use a direct URL; redirects are not followed.'); }
    if (!response.ok || originOf(response.url || args.url) !== origin) throw new BridgeError('DOWNLOAD_FETCH_FAILED', 'The file could not be downloaded from this origin.');
    if (Number(response.headers.get('content-length')) > MAX_FILE) { await response.body?.cancel(); throw new BridgeError('FILE_TOO_LARGE', 'Download limit: 20 MiB.'); }
    const chunks = []; let size = 0; const reader = response.body.getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_FILE) throw new BridgeError('FILE_TOO_LARGE', 'Download limit: 20 MiB.'); chunks.push(value); }
    } catch (error) { await reader.cancel(); throw error; }
    policy.verify(ticket, args.url);
    const blob = new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    let id;
    try { id = await browser.downloads.download({ url: blobUrl, filename: args.filename, saveAs: args.saveAs !== false, conflictAction: 'uniquify' }); }
    catch (error) { URL.revokeObjectURL(blobUrl); throw error; }
    downloads.set(id, { id, origin, name: args.filename, bytes: size, blobUrl });
    browser.downloads.onChanged?.addListener(function finished(delta) { if (delta.id === id && ['complete', 'interrupted'].includes(delta.state?.current)) { URL.revokeObjectURL(blobUrl); browser.downloads.onChanged.removeListener(finished); } });
    return { downloadId: id, filename: args.filename, bytes: size };
  }

  async function call(name, args) {
    if (name === 'firefox_network' && args.action === 'stop') { network.delete(args.tabId); return { recording: false, stopped: true }; }
    if (name === 'firefox_tab_group') return group(args);
    if (name === 'firefox_download') return download(args);
    if (name === 'firefox_downloads') {
      await optional('downloads');
      if (args.action === 'list') {
        const result = [];
        for (const item of downloads.values()) if (policy.can(item.origin, ['read', 'download'])) { const [download] = await browser.downloads.search({ id: item.id }); if (download) result.push({ id: item.id, origin: item.origin, filename: item.name, state: download.state, paused: download.paused, bytesReceived: download.bytesReceived, totalBytes: download.totalBytes }); }
        return { downloads: result };
      }
      const item = downloads.get(args.downloadId);
      if (!item) throw new BridgeError('DOWNLOAD_MISSING', 'This download does not belong to the current extension session.');
      policy.authorize(item.origin, ['read', 'download']);
      await browser.downloads[args.action](item.id); return { performed: args.action, downloadId: item.id };
    }
    if (name === 'firefox_upload_status') {
      const item = uploads.get(args.requestId); if (!item) throw new BridgeError('REQUEST_MISSING', 'Upload request not found.');
      policy.authorize(item.origin, ['read']);
      return { requestId: item.id, status: item.status, files: item.files ?? [], error: item.error ?? null };
    }
    if (name === 'firefox_upload') {
      const target = await getTab(args.tabId, ['read'], args.frameId ?? 0);
      if (policy.decision(target.frameTicket.origin, 'upload') === 'block') throw new BridgeError('SITE_BLOCKED', 'Uploads are blocked on this site.');
      const probe = await page(target, 'upload_probe', args);
      if ([...uploads.values()].filter(x => x.status === 'pending_user').length >= 10) throw new BridgeError('TOO_MANY_REQUESTS', 'Too many pending upload requests.');
      const item = { id: crypto.randomUUID(), origin: target.frameTicket.origin, args, url: target.frame.url, ...probe, status: 'pending_user', expires: Date.now() + 300000 };
      uploads.set(item.id, item);
      return { requestId: item.id, status: item.status, next: 'Choose files in the Firefox Bridge panel.' };
    }
    if (name === 'firefox_frames') {
      const target = await getTab(args.tabId, ['read']);
      const frames = await browser.webNavigation.getAllFrames({ tabId: args.tabId }); await verify(target);
      return { frames: frames.filter(f => { try { const origin = originOf(f.url); return origin === target.ticket.origin || policy.can(origin, ['read']); } catch { return false; } }).map(f => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })) };
    }
    if (name === 'firefox_network') {
      const target = await getTab(args.tabId, ['read', 'debug']);
      await verify(target);
      if (args.action === 'start') {
        if (!policy.can(target.ticket.origin, ['read', 'debug'])) throw new BridgeError('PERSISTENT_DEBUG_REQUIRED', 'Continuous recording requires persistent debug access on this site.');
        for (const [id, session] of network) if (session.expires < Date.now()) network.delete(id);
        if (!network.has(args.tabId) && network.size >= 20) throw new BridgeError('TOO_MANY_SESSIONS', 'Stop another network recording before starting a new one.');
        network.set(args.tabId, { origin: target.ticket.origin, entries: [], version: policy.version, expires: Date.now() + 900000, dropped: 0 });
      }
      let session = network.get(args.tabId);
      if (session && (session.expires < Date.now() || session.version !== policy.version || session.origin !== target.ticket.origin)) { network.delete(args.tabId); session = null; }
      if (args.action === 'clear' && session) { session.entries = []; session.dropped = 0; }
      const entries = (session?.entries ?? []).filter(x => policy.can(x.origin, ['read', 'debug']) && (!args.type || x.type === args.type) && (args.statusMin === undefined || x.status >= args.statusMin) && (!args.errorsOnly || x.error || x.status >= 400));
      return { recording: !!session, expires: session?.expires ?? null, dropped: session?.dropped ?? 0, entries: entries.slice(-(args.maxResults ?? 100)), truncated: entries.length > (args.maxResults ?? 100), source: 'webRequest' };
    }
    if (name === 'firefox_point') {
      const image = images.get(args.screenshotId); images.delete(args.screenshotId);
      if (!image || image.tabId !== args.tabId || image.expires < Date.now() || image.version !== policy.version) throw new BridgeError('STALE_SCREENSHOT', 'Capture the tab again before using coordinates.');
      if (args.x >= image.imageWidth || args.y >= image.imageHeight) throw new BridgeError('INVALID_COORDINATE', 'The point is outside the image.');
      const target = await getTab(args.tabId, ['read', 'interact']);
      return page(target, 'point', { command: args.action, x: args.x * image.observation.width / image.imageWidth, y: args.y * image.observation.height / image.imageHeight, observation: image.observation });
    }
    if (name === 'firefox_tab_history') {
      const target = await getTab(args.tabId, ['read', 'navigate']); await verify(target);
      await browser.tabs[args.direction === 'back' ? 'goBack' : 'goForward'](args.tabId);
      return { performed: args.direction, readAgain: true };
    }
    const target = await getTab(args.tabId, name === 'firefox_media' && args.action !== 'inspect' ? ['read', 'interact'] : ['read'], args.frameId ?? 0);
    if (name === 'firefox_context') return page(target, 'context');
    if (name === 'firefox_media') return page(target, 'media', { command: args.action, index: args.index, time: args.time });
    if (name === 'firefox_find') {
      const result = await page(target, 'read', { maxChars: 50000 });
      return { url: result.url, snapshotId: result.snapshotId, frameId: result.frameId, elements: result.elements.filter(e => [e.label, e.value, e.role].some(v => String(v ?? '').toLocaleLowerCase().includes(args.text.toLocaleLowerCase()))) };
    }
    throw new BridgeError('UNKNOWN_TOOL', 'Unknown tool.');
  }

  function pendingUploads() {
    for (const item of uploads.values()) if (item.status === 'pending_user' && item.expires < Date.now()) item.status = 'expired';
    return [...uploads.values()].filter(x => x.status === 'pending_user').map(({ id, origin, label, accept, multiple }) => ({ id, origin, label, accept, multiple }));
  }
  async function uploadFromUser(message) {
    const item = uploads.get(message.requestId);
    if (!item || item.status !== 'pending_user' || item.expires < Date.now()) throw new BridgeError('REQUEST_EXPIRED', 'The upload request expired.');
    if (!Array.isArray(message.files) || !message.files.length || message.files.length > 10 || message.files.some(f => !f || typeof f.name !== 'string' || f.name.length > 255 || typeof f.type !== 'string' || typeof f.data !== 'string' || f.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) || message.files.reduce((n, f) => n + f.data.length / 4 * 3 - (f.data.endsWith('==') ? 2 : f.data.endsWith('=') ? 1 : 0), 0) > 5 * 1024 * 1024) throw new BridgeError('INVALID_FILE', 'Select up to ten files totaling at most 5 MiB.');
    if (!item.multiple && message.files.length !== 1) throw new BridgeError('INVALID_FILE', 'This field accepts one file.');
    if (!policy.can(item.origin, ['read', 'interact', 'upload'])) policy.grantOnce(item.origin, ['read', 'interact', 'upload']);
    item.status = 'sending';
    try {
      const target = await getTab(item.args.tabId, ['read', 'interact', 'upload'], item.args.frameId ?? 0);
      if (target.frame.url !== item.url) throw new BridgeError('NAVIGATION_CHANGED', 'The destination changed. Request another upload.');
      const result = await page(target, 'upload_files', { ...item.args, files: message.files });
      item.status = 'attached'; item.files = result.attached; await log('firefox_upload', item.origin, 'allowed'); return { ok: true };
    } catch (error) { item.status = 'failed'; item.error = error.message; throw error; }
  }
  return {
    handles: name => NAMES.includes(name), call, pendingUploads, uploadFromUser,
    onPolicyChanged() {
      for (const [id, session] of network) {
        if (!managed.has(id) || !policy.can(session.origin, ['read', 'debug'])) network.delete(id);
        else session.version = policy.version;
      }
      images.clear();
      for (const item of uploads.values()) if (item.status === 'pending_user' && (!managed.has(item.args.tabId) || !policy.can(item.origin, ['read']) || policy.decision(item.origin, 'upload') === 'block')) item.status = 'cancelled';
    },
    clear(tabId) {
      for (const id of network.keys()) if (tabId === undefined || id === tabId) network.delete(id);
      for (const [id, item] of images) if (tabId === undefined || item.tabId === tabId) images.delete(id);
      for (const item of uploads.values()) if ((tabId === undefined || item.args.tabId === tabId) && item.status === 'pending_user') item.status = 'cancelled';
    },
    onNavigation(details) {
      for (const [id, item] of images) if (item.tabId === details.tabId) images.delete(id);
      const session = network.get(details.tabId);
      if (session && details.frameId === 0) {
        try { if (originOf(details.url) !== session.origin) network.delete(details.tabId); }
        catch { network.delete(details.tabId); }
      }
    },
    dismissUpload(id) { const item = uploads.get(id); if (item) item.status = 'cancelled'; return { ok: true }; },
    recordScreenshot(tabId, observation, data) {
      const bytes = Uint8Array.from(atob(data.slice(0, 64)), c => c.charCodeAt(0));
      const view = new DataView(bytes.buffer); const imageWidth = view.getUint32(16); const imageHeight = view.getUint32(20);
      const id = crypto.randomUUID(); if (images.size > 50) images.clear();
      images.set(id, { tabId, observation, imageWidth, imageHeight, version: policy.version, expires: Date.now() + 60000 });
      return { screenshotId: id, width: imageWidth, height: imageHeight, coordinateSpace: 'image_pixels' };
    }
  };
}
