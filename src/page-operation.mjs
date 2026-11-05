export function pageOperation(request) {
  if (location.href !== request.expectedUrl) throw new Error('The page changed before the operation. Read it again.');
  const parent = element => element.parentElement ?? element.getRootNode().host ?? null;
  const closest = (element, selector) => {
    for (let current = element; current; current = parent(current)) if (current.matches(selector)) return current;
    return null;
  };
  const disabled = element => element.matches(':disabled') || closest(element, 'button,input,select,textarea')?.matches(':disabled') === true || Boolean(closest(element, '[inert],[aria-disabled="true"]'));
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let current = element; current; current = parent(current)) {
      const style = getComputedStyle(current);
      if (current.matches('[hidden],[inert]') || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  const secret = element => {
    for (let current = element; current; current = parent(current)) {
      if (current.matches('input[type="password"],input[type="file"]')) return true;
      if ((current.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).some(token => token === 'one-time-code' || token.startsWith('cc-'))) return true;
    }
    return false;
  };
  const label = element => {
    const root = element.getRootNode();
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => root.getElementById?.(id)?.textContent ?? '').join(' ').trim();
    const pieces = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && pieces.join('').length < 300) {
      if (node.parentElement && !secret(node.parentElement) && !closest(node.parentElement, 'textarea,input,script,style,noscript,[hidden],[inert]')) pieces.push(node.textContent);
    }
    return (labelledBy || element.getAttribute('aria-label') || [...(element.labels ?? [])].map(item => item.textContent).join(' ') || pieces.join(' ') || element.getAttribute('placeholder') || element.getAttribute('title') || '').trim().slice(0, 300);
  };
  const role = element => element.getAttribute('role') || ({ BUTTON: 'button', A: element.hasAttribute('href') ? 'link' : null, TEXTAREA: 'textbox', SELECT: element.multiple ? 'listbox' : 'combobox', SUMMARY: 'button' }[element.tagName]) || (element.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button' }[element.type] ?? 'textbox') : null);
  const signature = element => JSON.stringify([element.tagName, role(element), label(element), ...['href', 'type', 'name', 'formaction', 'target', 'download', 'aria-expanded', 'aria-checked'].map(name => element.getAttribute(name)), element.href, element.form?.action, element.form?.method, disabled(element), element.readOnly, element.checked, element.textContent, secret(element) ? null : element.value, element instanceof HTMLSelectElement ? [...element.selectedOptions].map(option => option.value) : null]);
  let state = globalThis.__firefoxBridgeDocument;
  if (!state) {
    state = { id: crypto.randomUUID(), refs: new Map(), snapshotId: null, mutation: 0, roots: new WeakSet() };
    state.observer = new MutationObserver(records => { if (records.length) state.mutation++; });
    globalThis.__firefoxBridgeDocument = state;
  }
  state.signature = signature;
  const roots = [document];
  let inspectedRoots = 0;
  for (const root of roots) {
    if (!state.roots.has(root)) {
      state.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      state.roots.add(root);
      state.mutation++;
    }
    for (const element of root.querySelectorAll('*')) {
      if (++inspectedRoots > 20000) break;
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  if (state.observer.takeRecords().length) state.mutation++;
  const invalidate = () => { state.refs.clear(); state.snapshotId = null; };
  const hit = (x, y) => {
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot?.elementFromPoint) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element;
  };
  const contains = (element, target) => {
    for (let current = target; current; current = parent(current)) if (current === element) return true;
    return false;
  };
  const validate = (element, observed) => {
    if (location.href !== request.expectedUrl) throw new Error('The page changed during the operation. Read it again.');
    if (!element?.isConnected || !visible(element) || disabled(element)) throw new Error('Element removed, hidden, or disabled. Read the page again.');
    if (signature(element) !== observed.signature) throw new Error('The element changed since the snapshot. Read the page again.');
  };
  const safeActivation = element => {
    const control = closest(element, 'label')?.control;
    if (secret(element) || (control && (secret(control) || disabled(control)))) throw new Error('This field requires manual input from the user.');
    const anchor = closest(element, 'a[href]');
    if (anchor && !['http:', 'https:'].includes(new URL(anchor.href).protocol)) throw new Error('Special links require manual interaction.');
    if (anchor?.hasAttribute('download')) throw new Error('Downloads require the download workflow or manual interaction in Firefox.');
  };
  const actionable = async (element, observed) => {
    validate(element, observed);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    let previous = element.getBoundingClientRect();
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 40));
      validate(element, observed);
      const rect = element.getBoundingClientRect();
      if (['x', 'y', 'width', 'height'].every(key => Math.abs(rect[key] - previous[key]) < 0.5)) {
        const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
        const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
        if (right <= left || bottom <= top) throw new Error('Element is outside the viewport after scrolling.');
        for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const point = { x: left + (right - left) * fx, y: top + (bottom - top) * fy };
          if (contains(element, hit(point.x, point.y))) return point;
        }
        throw new Error('Element is covered or cannot receive pointer events. Close the overlay and read the page again.');
      }
      previous = rect;
    }
    throw new Error('Element is still moving. Wait and read the page again.');
  };
  const mouse = (element, type, point, extra = {}) => element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: point.x, clientY: point.y, ...extra }));
  const pointer = (element, type, point, extra = {}) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: point.x, clientY: point.y, ...extra }));
  const hover = (element, point) => {
    pointer(element, 'pointerover', point);
    pointer(element, 'pointerenter', point, { bubbles: false });
    mouse(element, 'mouseover', point);
    mouse(element, 'mouseenter', point, { bubbles: false });
    pointer(element, 'pointermove', point);
    mouse(element, 'mousemove', point);
  };
  const click = (element, point, observed, detail = 1) => {
    validate(element, observed);
    safeActivation(element);
    if (!contains(element, hit(point.x, point.y))) throw new Error('The target changed after pointer events. Read the page again.');
    const compatibility = pointer(element, 'pointerdown', point, { buttons: 1, button: 0 });
    if (compatibility && mouse(element, 'mousedown', point, { buttons: 1, button: 0, detail })) element.focus({ preventScroll: true });
    pointer(element, 'pointerup', point, { button: 0 });
    if (compatibility) mouse(element, 'mouseup', point, { button: 0, detail });
    validate(element, observed);
    if (!contains(element, hit(point.x, point.y))) throw new Error('The target changed during the click. Inspect the page before retrying.');
    mouse(element, 'click', point, { button: 0, detail });
  };
  const input = (element, type, value, inputType = 'insertReplacementText') => element.dispatchEvent(new InputEvent(type, { bubbles: true, composed: true, cancelable: type === 'beforeinput', data: value, inputType }));
  if (request.action === 'geometry') return { documentId: state.id, mutation: state.mutation, width: innerWidth, height: innerHeight, scrollX, scrollY };
  if (request.action === 'context') return { url: location.href, title: document.title, selection: String(getSelection()).slice(0, 20000), contentTrust: 'untrusted_webpage' };
  if (request.action === 'media') {
    const media = roots.flatMap(root => [...root.querySelectorAll('video,audio')]).filter(visible);
    if (request.command === 'inspect') return { media: media.map((m, index) => ({ index, paused: m.paused, duration: Number.isFinite(m.duration) ? m.duration : null, currentTime: m.currentTime, tracks: [...m.textTracks].map(track => ({ label: track.label, language: track.language, kind: track.kind, cues: [...(track.cues ?? [])].slice(0, 2000).map(c => ({ start: c.startTime, end: c.endTime, text: c.text?.slice(0, 1000) })) })) })) };
    const m = media[request.index ?? 0]; if (!m) throw new Error('Media not found.');
    if (request.command === 'pause') m.pause();
    else if (request.command === 'seek') { if (!Number.isFinite(request.time)) throw new Error('Specify the playback time.'); m.currentTime = request.time; }
    else if (request.command === 'play') return m.play().then(() => ({ playing: true }));
    return { paused: m.paused, currentTime: m.currentTime };
  }
  if (request.action === 'point') {
    const image = request.observation;
    if (state.id !== image.documentId || state.mutation !== image.mutation || innerWidth !== image.width || innerHeight !== image.height || scrollX !== image.scrollX || scrollY !== image.scrollY) throw new Error('The image expired. Capture the page again.');
    const element = hit(request.x, request.y);
    if (!element || !visible(element) || closest(element, 'iframe,frame') || disabled(element)) throw new Error('No permitted target at this point. Use references from a page snapshot.');
    safeActivation(element);
    const observed = { signature: signature(element) };
    const point = { x: request.x, y: request.y };
    invalidate();
    hover(element, point);
    if (request.command === 'context_menu') mouse(element, 'contextmenu', point, { button: 2 });
    else if (request.command !== 'hover') {
      click(element, point, observed);
      if (request.command === 'double_click') { click(element, point, observed, 2); mouse(element, 'dblclick', point, { detail: 2 }); }
    }
    return { performed: request.command, readAgain: true, trusted: false };
  }
  if (request.action === 'read') {
    invalidate();
    state.snapshotId = crypto.randomUUID();
    const elements = [];
    let truncatedElements = false;
    for (const root of roots) for (const element of root.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable]:not([contenteditable="false"]),summary,[tabindex]')) {
      if (!visible(element) && !(element instanceof HTMLInputElement && element.type === 'file')) continue;
      if (elements.length >= 500) { truncatedElements = true; break; }
      const ref = `e${elements.length + 1}`;
      state.refs.set(ref, { element, signature: signature(element) });
      const rect = element.getBoundingClientRect();
      const item = { ref, tag: element.tagName.toLowerCase(), role: role(element), label: label(element), type: element.getAttribute('type'), disabled: disabled(element), readonly: element.readOnly === true, sensitive: secret(element), inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth, shadowRoot: root !== document };
      if (element instanceof HTMLAnchorElement) item.href = element.href;
      if ('value' in element && !secret(element)) item.value = String(element.value).slice(0, 1000);
      if ('checked' in element) item.checked = element.checked;
      if (element.hasAttribute('aria-expanded')) item.expanded = element.getAttribute('aria-expanded');
      if (element instanceof HTMLSelectElement) item.options = [...element.options].map(o => ({ value: o.value, label: o.label, selected: o.selected, disabled: o.disabled || o.parentElement?.disabled === true })).slice(0, 100);
      elements.push(item);
    }
    const pieces = [];
    let total = 0, inspected = 0;
    const maxChars = request.maxChars ?? 20000;
    for (const root of roots) {
      const walker = document.createTreeWalker(root === document ? document.body ?? document.documentElement : root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && total < maxChars && inspected++ < 100000) {
        const element = node.parentElement;
        if (!element || closest(element, 'script,style,noscript,template,textarea,input,[hidden],[inert]') || secret(element) || !visible(element)) continue;
        const value = node.textContent.replace(/\s+/g, ' ').trim();
        if (value) { pieces.push(value); total += value.length + 1; }
      }
    }
    return { url: location.href, title: document.title, snapshotId: state.snapshotId, documentId: state.id, text: pieces.join('\n').slice(0, maxChars), truncated: total >= maxChars || inspected >= 100000 || inspectedRoots > 20000, truncatedElements, elements, iframeCount: roots.reduce((sum, root) => sum + root.querySelectorAll('iframe,frame').length, 0), viewport: { width: innerWidth, height: innerHeight }, contentTrust: 'untrusted_webpage' };
  }
  if (request.action === 'scroll') {
    scrollBy({ left: request.x ?? 0, top: request.y, behavior: 'instant' });
    invalidate();
    return { scrolled: true, x: scrollX, y: scrollY };
  }
  if (request.snapshotId !== state.snapshotId) throw new Error('Snapshot expired. Read the page again.');
  const observed = state.refs.get(request.ref);
  const element = observed?.element;
  const hiddenUpload = ['upload_probe', 'upload_files'].includes(request.action) && element instanceof HTMLInputElement && element.type === 'file';
  if (!element?.isConnected || (!visible(element) && !hiddenUpload) || disabled(element)) throw new Error('Element removed, hidden, or disabled. Read the page again.');
  if (signature(element) !== observed.signature) throw new Error('The element changed since the snapshot. Read the page again.');
  if (request.action === 'upload_probe') {
    if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('The reference is not a file input.');
    return { accept: element.accept, multiple: element.multiple, label: label(element) || 'File' };
  }
  if (request.action === 'upload_files') {
    if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('The element is not a file input.');
    if (!element.multiple && request.files.length !== 1) throw new Error('This input accepts one file.');
    const transfer = new DataTransfer();
    for (const file of request.files) { const raw = atob(file.data); const bytes = Uint8Array.from(raw, char => char.charCodeAt(0)); transfer.items.add(new File([bytes], file.name, { type: file.type })); }
    invalidate();
    element.files = transfer.files;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { attached: request.files.map(f => ({ name: f.name, type: f.type })), mayHaveSubmitted: true };
  }
  safeActivation(element);
  return (async () => {
    const point = await actionable(element, observed);
    if (request.action === 'fill' && element.readOnly) throw new Error('The field is read-only.');
    if (request.action === 'fill' && !(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement) && !element.isContentEditable) throw new Error('The element is not editable.');
    if (request.action === 'fill' && element instanceof HTMLInputElement && !['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time'].includes(element.type)) throw new Error('This input type does not support fill.');
    if (request.action === 'select') {
      if (!(element instanceof HTMLSelectElement)) throw new Error('The element is not a select.');
      if (!element.multiple && request.values.length !== 1) throw new Error('This field accepts one option.');
      if (request.values.some(value => ![...element.options].some(o => o.value === value && !o.disabled && !o.parentElement?.disabled))) throw new Error('Invalid or disabled option.');
    }
    invalidate();
    if (request.action === 'click') {
      hover(element, point);
      click(element, point, observed);
    } else {
      element.focus({ preventScroll: true });
      validate(element, observed);
      if (request.action === 'fill') {
        if (!input(element, 'beforeinput', request.value)) return { performed: false, canceled: 'beforeinput', readAgain: true };
        validate(element, observed);
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, request.value);
          if (element.value !== request.value) throw new Error('Invalid value for this input type. Inspect the page before retrying.');
        } else element.textContent = request.value;
        input(element, 'input', request.value);
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (request.action === 'select') {
        for (const option of element.options) option.selected = request.values.includes(option.value);
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (request.action === 'key') {
        const key = request.key === 'Space' ? ' ' : request.key;
        const code = request.key === 'Space' ? 'Space' : key;
        const allowed = element.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, composed: true }));
        if (allowed) {
          validate(element, observed);
          if (key === 'Tab') {
            const targets = roots.flatMap(root => [...root.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[contenteditable]')]).filter(item => item.tabIndex >= 0 && visible(item) && !disabled(item));
            targets.sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
            targets[(targets.indexOf(element) + 1) % targets.length]?.focus();
          } else if (key === 'Enter' && element.matches('button,a[href],summary,input[type="button"],input[type="submit"],input[type="reset"]')) element.click();
          else if (key === 'Enter' && element instanceof HTMLInputElement && element.form) element.form.requestSubmit();
        }
        element.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true, composed: true }));
        if (allowed && key === ' ' && element.matches('button,input[type="checkbox"],input[type="radio"],summary')) { validate(element, observed); element.click(); }
      } else throw new Error('Unknown page operation.');
    }
    return { performed: request.action, ref: request.ref, readAgain: true, trusted: false };
  })();
}
