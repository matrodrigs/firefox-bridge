export function debugPageOperation(request) {
  if (location.href !== request.expectedUrl) throw new Error('The page changed. Query it again.');
  const finite = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const safeUrl = value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : null; } catch { return null; }
  };
  if (request.action === 'performance') {
    const timing = entry => ({
      url: safeUrl(entry.name), initiatorType: entry.initiatorType ?? null,
      startTime: finite(entry.startTime), duration: finite(entry.duration),
      dnsMs: finite(entry.domainLookupEnd - entry.domainLookupStart),
      connectMs: finite(entry.connectEnd - entry.connectStart),
      requestMs: entry.requestStart ? finite(entry.responseStart - entry.requestStart) : null,
      downloadMs: entry.responseStart ? finite(entry.responseEnd - entry.responseStart) : null,
      transferSize: finite(entry.transferSize), encodedBodySize: finite(entry.encodedBodySize),
      decodedBodySize: finite(entry.decodedBodySize), protocol: entry.nextHopProtocol ?? null
    });
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    return {
      timeOrigin: performance.timeOrigin, readyState: document.readyState,
      navigation: navigation ? { ...timing(navigation), type: navigation.type, domContentLoadedMs: finite(navigation.domContentLoadedEventEnd), loadMs: finite(navigation.loadEventEnd), redirectCount: navigation.redirectCount } : null,
      paint: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, startTime: finite(entry.startTime) })),
      resources: resources.slice(-500).map(timing), resourceBufferLimited: resources.length >= 250,
      contentTrust: 'untrusted_webpage'
    };
  }
  let element;
  if (request.selector) {
    const matches = [];
    const roots = [document];
    let visited = 0;
    while (roots.length && visited++ < 1000) {
      const root = roots.shift();
      matches.push(...root.querySelectorAll(request.selector));
      if (matches.length > 1) throw new Error('Ambiguous selector. Use a unique selector or an observed reference.');
      for (const candidate of root.querySelectorAll('*')) if (candidate.shadowRoot) roots.push(candidate.shadowRoot);
    }
    if (roots.length) throw new Error('The document is too complex. Use an observed reference.');
    [element] = matches;
  } else {
    const state = globalThis.__firefoxBridgeDocument;
    if (!state || request.snapshotId !== state.snapshotId) throw new Error('The snapshot expired. Read the page again.');
    const observed = state.refs.get(request.ref);
    element = observed?.element;
    if (element && state.signature && state.signature(element) !== observed.signature) throw new Error('The element changed since the snapshot. Read it again.');
  }
  if (!element?.isConnected) throw new Error('Element not found. Read the page again.');
  let sensitive = false;
  let hidden = false;
  let disabled = element.matches(':disabled');
  for (let current = element; current; current = current.parentElement ?? current.getRootNode().host ?? null) {
    if (current.matches('input[type="password"],input[type="file"]') || (current.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).some(token => token === 'one-time-code' || token.startsWith('cc-'))) sensitive = true;
    const ancestorStyle = getComputedStyle(current);
    if (current.matches('[hidden],[inert]') || ancestorStyle.display === 'none' || ['hidden', 'collapse'].includes(ancestorStyle.visibility) || ancestorStyle.opacity === '0' || ancestorStyle.contentVisibility === 'hidden') hidden = true;
    if (current.matches('[inert],[aria-disabled="true"]')) disabled = true;
  }
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const attributes = Object.fromEntries(['id', 'class', 'role', 'type', 'name', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-expanded', 'aria-checked', 'aria-disabled', 'aria-hidden', 'tabindex'].filter(name => element.hasAttribute(name)).map(name => [name, element.getAttribute(name).slice(0, 500)]));
  const styles = Object.fromEntries(['display', 'visibility', 'opacity', 'position', 'z-index', 'pointer-events', 'overflow', 'overflow-x', 'overflow-y', 'color', 'background-color', 'font-size', 'font-family', 'line-height', 'padding', 'margin', 'border-width', 'box-sizing', 'transform'].map(name => [name, style.getPropertyValue(name).slice(0, 300)]));
  let hit = document.elementFromPoint?.(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
  while (hit?.shadowRoot?.elementFromPoint) {
    const next = hit.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!next || next === hit) break;
    hit = next;
  }
  const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  const blocked = !!hit && hit !== element && !element.contains(hit);
  const labelIds = (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean);
  const root = element.getRootNode();
  const label = labelIds.map(id => root.getElementById?.(id)?.textContent ?? '').join(' ').trim() || element.getAttribute('aria-label') || element.labels?.[0]?.textContent || (!sensitive ? element.textContent : '') || '';
  const issues = [];
  if (!label.trim()) issues.push('missing_accessible_name');
  if (element.getAttribute('aria-hidden') === 'true' && element.tabIndex >= 0) issues.push('focusable_aria_hidden');
  if (labelIds.some(id => !root.getElementById?.(id))) issues.push('missing_label_reference');
  if (blocked) issues.push('center_obscured');
  return {
    tag: element.tagName.toLowerCase(), attributes, sensitive,
    box: Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, finite(rect[key])])),
    styles, inViewport, disabled,
    visible: rect.width > 0 && rect.height > 0 && !hidden,
    obscuredBy: blocked ? { tag: hit.tagName.toLowerCase(), id: hit.id.slice(0, 200) } : null,
    accessibility: { name: label.trim().slice(0, 300), role: element.getAttribute('role'), issues, completeAudit: false },
    contentTrust: 'untrusted_webpage'
  };
}
