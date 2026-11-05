import { Policy, BridgeError, originOf, capabilitiesOf } from './policy.mjs';
import { validateCall, TOOLS } from './contract.mjs';
import { pageOperation } from './page-operation.mjs';
import { createAdvanced } from './advanced.mjs';
import { createDebugging } from './debugging.mjs';

export function trustedUiSender(browser, sender) {
  return sender.id === browser.runtime.id && (sender.frameId === undefined || sender.frameId === 0) && sender.url === browser.runtime.getURL('panel.html');
}

export function createController(browser, { defaults = {} } = {}) {
  const policy = new Policy();
  const managed = new Set();
  const navigationLeases = new Map();
  const topNavigations = new Map();
  const pending = new Map();
  let audit = [];
  const revisions = new Map();
  let queue = Promise.resolve();
  const ready = (async () => {
    const stored = await browser.storage.local.get(['policy', 'audit']);
    policy.load({ ...defaults, ...stored.policy });
    audit = Array.isArray(stored.audit) ? stored.audit.slice(-200) : [];
  })();
  const savePolicy = () => browser.storage.local.set({ policy: policy.serialize() });
  const log = async (operation, origin, outcome, code) => {
    audit.push({ time: new Date().toISOString(), operation, origin: origin ?? null, outcome, code: code ?? null });
    audit = audit.slice(-200);
    await browser.storage.local.set({ audit });
  };
  const serialize = job => {
    const next = queue.then(job);
    queue = next.catch(() => {});
    return next;
  };
  const safeTab = tab => ({ id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, active: tab.active, pinned: tab.pinned, controlled: managed.has(tab.id) });
  async function getTab(tabId, capabilities, frameId = 0) {
    const tab = await browser.tabs.get(tabId);
    if (tab.incognito) throw new BridgeError('PRIVATE_TAB', 'Private tabs are not exposed by this extension.');
    const ticket = policy.authorize(tab.url, frameId === 0 ? capabilities : ['read']);
    let frame = { frameId: 0, url: tab.url };
    let frameTicket = ticket;
    if (frameId !== 0) {
      frame = await browser.webNavigation.getFrame({ tabId, frameId });
      if (!frame) throw new BridgeError('FRAME_MISSING', 'The frame no longer exists. List frames again.');
      frameTicket = policy.authorize(frame.url, capabilities);
    }
    managed.add(tabId);
    return { tab, ticket, frame, frameTicket, revision: revisions.get(tabId) ?? 0 };
  }
  async function verify(target) {
    const current = await browser.tabs.get(target.tab.id);
    policy.verify(target.ticket, current.url);
    if (target.revision !== (revisions.get(current.id) ?? 0) || current.url !== target.tab.url || current.incognito) throw new BridgeError('NAVIGATION_CHANGED', 'The page changed during the operation. Read it again.');
    if (target.frame.frameId !== 0) {
      const frame = await browser.webNavigation.getFrame({ tabId: current.id, frameId: target.frame.frameId });
      if (!frame || frame.url !== target.frame.url) throw new BridgeError('NAVIGATION_CHANGED', 'The frame changed during the operation.');
      policy.verify(target.frameTicket, frame.url);
    }
    return current;
  }
  function gateRequest(details) {
    if (!managed.has(details.tabId) || !['main_frame', 'sub_frame'].includes(details.type)) return {};
    try {
      const origin = originOf(details.url);
      const lease = navigationLeases.get(details.tabId);
      const leased = policy.enabled && lease?.origin === origin && lease.expires > Date.now() && lease.version === policy.version;
      if (leased || policy.can(origin, ['read', 'navigate'])) return {};
      try {
        const ticket = policy.authorize(origin, ['read', 'navigate']);
        navigationLeases.set(details.tabId, { origin, expires: Date.now() + 15000, version: ticket.version });
        return {};
      } catch {}
      void log('navigation', origin, 'blocked', 'APPROVAL_REQUIRED');
    } catch { void log('navigation', null, 'blocked', 'INVALID_URL'); }
    return { cancel: true };
  }
  function onNavigation(details) {
    if (managed.has(details.tabId)) {
      revisions.set(details.tabId, (revisions.get(details.tabId) ?? 0) + 1);
      void debugging.clear(details.tabId, details.frameId === 0 ? undefined : details.frameId);
      advanced.onNavigation(details);
      if (details.frameId === 0 && /^https?:/.test(details.url ?? '')) topNavigations.set(details.tabId, (topNavigations.get(details.tabId) ?? 0) + 1);
    }
  }
  function onCreated(tab) { if (managed.has(tab.openerTabId)) managed.add(tab.id); }
  function onRemoved(tabId) { managed.delete(tabId); navigationLeases.delete(tabId); revisions.delete(tabId); topNavigations.delete(tabId); advanced.clear(tabId); void debugging.clear(tabId); }
  browser.webRequest.onBeforeRequest.addListener(gateRequest, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }, ['blocking']);
  browser.webNavigation.onBeforeNavigate.addListener(onNavigation);
  browser.tabs.onCreated.addListener(onCreated);
  browser.tabs.onRemoved.addListener(onRemoved);

  async function waitForPage(tabId, origin, ticket, baseline) {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      const tab = await browser.tabs.get(tabId);
      if (!policy.enabled || policy.version !== ticket.version) throw new BridgeError('AUTHORIZATION_CHANGED', 'Authorization changed during navigation.');
      if (tab.url && tab.url !== 'about:blank' && originOf(tab.url) !== origin) throw new BridgeError('NAVIGATION_CHANGED', 'The destination changed origin.');
      if (tab.status === 'complete' && tab.url !== 'about:blank' && (topNavigations.get(tabId) ?? 0) > baseline) return safeTab(tab);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new BridgeError('NAVIGATION_TIMEOUT', 'Navigation did not finish. Inspect the tab before trying again.');
  }

  async function page(target, action, args = {}) {
    await verify(target);
    const mutating = !['read', 'context', 'geometry', 'upload_probe'].includes(action) && !(action === 'media' && args.command === 'inspect');
    const executionError = error => {
      const cause = String(error?.message ?? error ?? 'The operation did not return a valid result.').slice(0, 2000);
      return new BridgeError(mutating ? 'ACTION_OUTCOME_UNCERTAIN' : 'PAGE_ERROR', mutating ? `The action may have taken effect. Inspect the tab before repeating it. Cause: ${cause}` : cause, { cause, ...(error?.code ? { causeCode: error.code } : {}) });
    };
    let results;
    try { results = await browser.scripting.executeScript({ target: { tabId: target.tab.id, frameIds: [target.frame.frameId] }, func: pageOperation, args: [{ ...args, action, expectedUrl: target.frame.url }] }); }
    catch (error) { throw executionError(error); }
    try { await verify(target); }
    catch (error) {
      if (mutating) throw executionError(error);
      throw error;
    }
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.error || results[0]?.result === undefined) throw executionError(results?.[0]?.error);
    return { ...results[0].result, frameId: target.frame.frameId };
  }

  const advanced = createAdvanced({ browser, policy, managed, getTab, verify, page, log });
  const debugging = createDebugging({ browser, policy, managed, getTab, verify });

  async function frameSignature(tabId, topOrigin) {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    if (!frames?.length) throw new BridgeError('FRAMES_UNAVAILABLE', 'Could not verify the tab documents.');
    for (const frame of frames) {
      let origin;
      if (['about:blank', 'about:srcdoc'].includes(frame.url)) {
        let parent = frames.find(x => x.frameId === frame.parentFrameId);
        const visited = new Set();
        while (parent && ['about:blank', 'about:srcdoc'].includes(parent.url) && !visited.has(parent.frameId)) {
          visited.add(parent.frameId); parent = frames.find(x => x.frameId === parent.parentFrameId);
        }
        origin = parent ? originOf(parent.url) : topOrigin;
      } else origin = originOf(frame.url);
      if (origin !== topOrigin && !policy.can(origin, ['read', 'capture'])) throw new BridgeError('FRAME_APPROVAL_REQUIRED', 'A cross-origin frame requires capture permission.', { origin, capabilities: ['read', 'capture'] });
    }
    return JSON.stringify(frames.map(x => [x.frameId, x.parentFrameId, x.url]).sort((a, b) => a[0] - b[0]));
  }

  async function dispatch(name, args) {
    await ready;
    validateCall(name, args);
    if (name === 'firefox_status') return { extensionVersion: browser.runtime.getManifest().version, enabled: policy.enabled, defaultBrowse: policy.defaultBrowse, controlledTabs: managed.size, approvedSites: Object.keys(policy.rules).length, pendingRequests: pending.size, toolsAvailable: TOOLS.length };
    if (name === 'firefox_request_access') {
      const origin = originOf(args.url);
      const capabilities = capabilitiesOf(args.capabilities);
      const existing = [...pending.values()].find(x => x.origin === origin && JSON.stringify(x.capabilities) === JSON.stringify(capabilities));
      if (existing) return { requestId: existing.id, status: 'pending_user', origin };
      if (pending.size >= 20) throw new BridgeError('TOO_MANY_REQUESTS', 'Too many pending requests. Wait for the user.');
      const item = { id: crypto.randomUUID(), origin, capabilities, reason: args.reason, created: Date.now() };
      pending.set(item.id, item);
      await browser.browserAction.setBadgeText({ text: String(pending.size) });
      return { requestId: item.id, status: 'pending_user', origin, next: 'Open Firefox Bridge in Firefox and review the request.' };
    }
    if (name === 'firefox_console' && args.action === 'stop') return debugging.call(name, args);
    if (name === 'firefox_network' && args.action === 'stop') return advanced.call(name, args);
    if (!policy.enabled) throw new BridgeError('PAUSED', 'Enable access in the Firefox Bridge panel.');
    if (name === 'firefox_list_tabs') {
      const tabs = await browser.tabs.query({});
      const allowed = tabs.filter(t => !t.incognito && policy.can(t.url, ['read']));
      return { tabs: allowed.map(safeTab), hiddenTabs: tabs.length - allowed.length };
    }
    if (name === 'firefox_release_tab') { managed.delete(args.tabId); navigationLeases.delete(args.tabId); advanced.clear(args.tabId); await debugging.clear(args.tabId); return { released: true }; }
    if (name === 'firefox_open_tab' || name === 'firefox_navigate') {
      const origin = originOf(args.url);
      const ticket = policy.authorize(origin, ['read', 'navigate']);
      let tabId;
      if (name === 'firefox_open_tab') {
        const tab = await browser.tabs.create({ url: 'about:blank', active: args.active !== false });
        tabId = tab.id;
      } else {
        const current = await browser.tabs.get(args.tabId);
        if (current.incognito || !policy.can(current.url, ['read', 'navigate'])) throw new BridgeError('SOURCE_APPROVAL_REQUIRED', 'The source tab requires persistent read and navigation access.');
        tabId = args.tabId;
      }
      managed.add(tabId);
      navigationLeases.set(tabId, { origin, expires: Date.now() + 15000, version: policy.version });
      const baseline = topNavigations.get(tabId) ?? 0;
      await browser.tabs.update(tabId, { url: new URL(args.url).href });
      return waitForPage(tabId, origin, ticket, baseline);
    }
    if (name === 'firefox_bookmarks' || name === 'firefox_history') {
      const permission = name === 'firefox_bookmarks' ? 'bookmarks' : 'history';
      if (!await browser.permissions.contains({ permissions: [permission] })) throw new BridgeError('BROWSER_PERMISSION_REQUIRED', `Enable ${permission === 'history' ? 'history' : 'bookmarks'} in the panel.`);
      if (permission === 'bookmarks' && args.action === 'create') {
        if (!args.url || !args.title) throw new BridgeError('INVALID_ARGUMENT', 'Creating a bookmark requires a URL and title.');
        policy.authorize(args.url, ['read', 'interact']);
        return browser.bookmarks.create({ url: args.url, title: args.title });
      }
      const results = permission === 'history' ? await browser.history.search({ text: args.query, maxResults: args.maxResults ?? 50, startTime: Date.now() - 30 * 86400000 }) : await browser.bookmarks.search(args.query ?? '');
      return results.filter(x => x.url && policy.can(x.url, ['read'])).slice(0, args.maxResults ?? 100).map(x => ({ id: x.id, title: x.title, url: x.url, lastVisitTime: x.lastVisitTime }));
    }
    if (debugging.handles(name)) return debugging.call(name, args);
    if (advanced.handles(name)) return advanced.call(name, args);
    if (name === 'firefox_wait') {
      if (!args.text && !args.role) throw new BridgeError('INVALID_ARGUMENT', 'Provide text or role to wait for.');
      const target = await getTab(args.tabId, ['read'], args.frameId ?? 0);
      const until = Date.now() + (args.timeoutMs ?? 5000);
      for (;;) {
        const result = await page(target, 'read', { maxChars: 50000 });
        const matches = result.elements.filter(item => (!args.role || item.role === args.role) && (!args.text || String(item.label ?? '').toLocaleLowerCase().includes(args.text.toLocaleLowerCase())));
        const found = matches.length > 0 || (!args.role && result.text.toLocaleLowerCase().includes(args.text.toLocaleLowerCase()));
        if ((args.state === 'absent') !== found) return { ...result, matches, conditionMet: true };
        if (Date.now() >= until) throw new BridgeError('WAIT_TIMEOUT', 'The condition was not observed before the timeout. Inspect the page before repeating an action.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const capabilities = name === 'firefox_read_page' ? ['read'] : name === 'firefox_screenshot' ? ['read', 'capture'] : name === 'firefox_tab_action' ? ['read', 'interact', ...(args.action === 'reload' ? ['navigate'] : [])] : ['read', 'interact'];
    const target = await getTab(args.tabId, capabilities, args.frameId ?? 0);
    if (name === 'firefox_read_page') return page(target, 'read', { maxChars: args.maxChars ?? 20000 });
    if (name === 'firefox_screenshot') {
      const before = await frameSignature(args.tabId, target.ticket.origin);
      const geometry = await page(target, 'geometry');
      await verify(target);
      const dataUrl = await browser.tabs.captureTab(args.tabId, { format: 'png' });
      await verify(target);
      const after = await frameSignature(args.tabId, target.ticket.origin);
      if (before !== after) throw new BridgeError('NAVIGATION_CHANGED', 'Frames changed during capture.');
      if (dataUrl.length > 6_990_500) throw new BridgeError('IMAGE_TOO_LARGE', 'The screenshot exceeds 5 MiB. Reduce the zoom or window size.');
      const imageData = dataUrl.split(',')[1];
      return { image: { mimeType: 'image/png', data: imageData }, url: target.tab.url, ...advanced.recordScreenshot(args.tabId, geometry, imageData) };
    }
    if (name === 'firefox_tab_action') {
      await verify(target);
      if (args.action === 'close') { await browser.tabs.remove(args.tabId); return { closed: true }; }
      if (args.action === 'reload') { navigationLeases.set(args.tabId, { origin: target.ticket.origin, expires: Date.now() + 15000, version: policy.version }); await browser.tabs.reload(args.tabId); return { reloading: true }; }
      const tab = await browser.tabs.update(args.tabId, args.action === 'activate' ? { active: true } : { pinned: args.action === 'pin' });
      return safeTab(tab);
    }
    return page(target, name.replace('firefox_', ''), args);
  }

  async function call(name, args, { expiresAt = Infinity, signal } = {}) {
    return serialize(async () => {
      try {
        if (signal?.aborted) throw new BridgeError('REQUEST_CANCELLED', 'The connection closed before this request could run.');
        if (Date.now() >= expiresAt) throw new BridgeError('REQUEST_TIMEOUT', 'The request expired before execution.');
        const result = await dispatch(name, args);
        let origin = null;
        try { origin = args.url ? originOf(args.url) : args.tabId !== undefined ? originOf((await browser.tabs.get(args.tabId)).url) : null; } catch {}
        await log(name, origin, 'allowed');
        return result;
      } catch (error) {
        await log(name, null, 'denied', error.code ?? 'OPERATION_FAILED');
        throw error;
      }
    });
  }

  async function ui(message) {
    await ready;
    if (message.action === 'state') {
      for (const [id, item] of pending) if (Date.now() - item.created > 600000) pending.delete(id);
      const current = (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      let currentOrigin = null;
      try { if (!current?.incognito) currentOrigin = originOf(current.url); } catch {}
      return { policy: policy.serialize(), pending: [...pending.values()], uploads: advanced.pendingUploads(), audit: audit.slice(-30).reverse(), controlledTabs: managed.size, currentOrigin, extras: { bookmarks: await browser.permissions.contains({ permissions: ['bookmarks'] }), history: await browser.permissions.contains({ permissions: ['history'] }), downloads: await browser.permissions.contains({ permissions: ['downloads'] }), tabGroups: await browser.permissions.contains({ permissions: ['tabGroups'] }) } };
    }
    if (message.action === 'pause') policy.pause();
    else if (message.action === 'resume') policy.resume();
    else if (message.action === 'release_all') { managed.clear(); navigationLeases.clear(); }
    else if (message.action === 'default_browse') policy.setDefaultBrowse(message.value);
    else if (message.action === 'upload_files') return advanced.uploadFromUser(message);
    else if (message.action === 'dismiss_upload') return advanced.dismissUpload(message.requestId);
    else if (message.action === 'revoke') { policy.revoke(message.origin); }
    else if (message.action === 'decision') {
      const item = message.requestId ? pending.get(message.requestId) : message;
      if (!item) throw new BridgeError('REQUEST_EXPIRED', 'The request expired.');
      if (message.decision === 'once') policy.grantOnce(item.origin, item.capabilities);
      else policy.configure(item.origin, item.capabilities, message.decision);
      if (message.requestId) pending.delete(message.requestId);
    } else throw new BridgeError('INVALID_ACTION', 'Unknown panel action.');
    advanced.onPolicyChanged();
    await debugging.onPolicyChanged();
    await savePolicy();
    await browser.browserAction.setBadgeText({ text: pending.size ? String(pending.size) : '' });
    return { ok: true };
  }
  return { call, ui, ready, policy, gateRequest, managed };
}
