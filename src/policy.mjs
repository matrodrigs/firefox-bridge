export const BROWSE = Object.freeze(['read', 'interact', 'navigate', 'capture']);
const CAPABILITIES = Object.freeze([...BROWSE, 'download', 'upload', 'debug']);

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('INVALID_URL', 'Provide a complete HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new BridgeError('INVALID_URL', 'Only HTTP/HTTPS URLs without embedded credentials are allowed.');
  }
  return url.origin;
}

export function capabilitiesOf(value) {
  if (!Array.isArray(value) || !value.length || value.some(x => !CAPABILITIES.includes(x))) {
    throw new BridgeError('INVALID_CAPABILITIES', 'Choose a supported capability.');
  }
  return [...new Set(value)];
}

export class Policy {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.enabled = false;
    this.rules = {};
    this.defaultBrowse = 'ask';
    this.once = [];
    this.version = 0;
  }

  load(value) {
    this.enabled = value?.enabled === true;
    this.defaultBrowse = value?.defaultBrowse === 'allow' ? 'allow' : 'ask';
    this.rules = {};
    for (const [origin, rule] of Object.entries(value?.rules ?? {})) {
      try {
        if (originOf(origin) !== origin) continue;
        this.rules[origin] = Object.fromEntries(CAPABILITIES.filter(cap => Object.hasOwn(rule, cap)).map(cap => [cap, ['allow', 'block'].includes(rule[cap]) ? rule[cap] : 'ask']));
      } catch {}
    }
    this.once = [];
    this.version++;
  }

  serialize() { return { enabled: this.enabled, defaultBrowse: this.defaultBrowse, rules: this.rules }; }

  decision(origin, cap) { return this.rules[origin]?.[cap] ?? (BROWSE.includes(cap) ? this.defaultBrowse : 'ask'); }
  setDefaultBrowse(value) {
    if (!['allow', 'ask'].includes(value)) throw new BridgeError('INVALID_DECISION', 'Invalid browsing default.');
    this.defaultBrowse = value; this.once = []; this.version++;
  }

  configure(origin, capabilities, decision) {
    origin = originOf(origin);
    capabilities = capabilitiesOf(capabilities);
    if (!['allow', 'ask', 'block', 'inherit'].includes(decision)) throw new BridgeError('INVALID_DECISION', 'Invalid decision.');
    const rule = this.rules[origin] ?? {};
    for (const cap of capabilities) { if (decision === 'inherit') delete rule[cap]; else rule[cap] = decision; }
    this.rules[origin] = rule;
    this.once = this.once.filter(x => x.origin !== origin);
    this.version++;
  }

  grantOnce(origin, capabilities) {
    origin = originOf(origin);
    capabilities = capabilitiesOf(capabilities);
    if (capabilities.some(cap => this.rules[origin]?.[cap] === 'block')) {
      throw new BridgeError('SITE_BLOCKED', 'Remove the block on this site before granting access.');
    }
    this.once.push({ origin, capabilities, expires: this.clock() + 300_000 });
    this.version++;
  }

  revoke(origin) {
    origin = originOf(origin);
    delete this.rules[origin];
    this.once = this.once.filter(x => x.origin !== origin);
    this.version++;
  }

  pause() { this.enabled = false; this.once = []; this.version++; }
  resume() { this.enabled = true; this.version++; }

  can(origin, capabilities) {
    if (!this.enabled) return false;
    try { origin = originOf(origin); } catch { return false; }
    return capabilities.every(cap => this.decision(origin, cap) === 'allow');
  }

  authorize(origin, capabilities) {
    origin = originOf(origin);
    capabilities = capabilitiesOf(capabilities);
    if (!this.enabled) throw new BridgeError('PAUSED', 'The extension is paused. Enable access in the Firefox panel.');
    if (capabilities.some(cap => this.rules[origin]?.[cap] === 'block')) {
      throw new BridgeError('SITE_BLOCKED', 'The user blocked this operation on this site.', { origin, capabilities });
    }
    const missing = capabilities.filter(cap => this.decision(origin, cap) !== 'allow');
    const index = this.once.findIndex(x => x.origin === origin && x.expires > this.clock() && missing.every(cap => x.capabilities.includes(cap)));
    if (missing.length && index < 0) throw new BridgeError('APPROVAL_REQUIRED', 'Authorize the site in the Firefox panel.', { origin, capabilities: missing });
    if (missing.length) this.once.splice(index, 1);
    return { origin, capabilities, version: this.version, expires: this.clock() + 30_000 };
  }

  verify(ticket, currentUrl) {
    if (!this.enabled || ticket.version !== this.version || ticket.expires < this.clock()) {
      throw new BridgeError('AUTHORIZATION_CHANGED', 'Permission changed or expired during the operation.');
    }
    if (originOf(currentUrl) !== ticket.origin) throw new BridgeError('NAVIGATION_CHANGED', 'The tab changed origin during the operation.');
  }
}
