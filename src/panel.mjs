import { BROWSE } from './policy.mjs';

const $ = selector => document.querySelector(selector);
const labels = { read: 'Use this site', interact: 'Use this site', navigate: 'Use this site', capture: 'Use this site', download: 'Download files', upload: 'Attach files', debug: 'Debug this site' };
const names = { firefox_read_page: 'Read page', firefox_click: 'Click', firefox_fill: 'Fill field', firefox_select: 'Select option', firefox_key: 'Keyboard', firefox_scroll: 'Scroll', firefox_screenshot: 'Screenshot', firefox_open_tab: 'Open tab', firefox_navigate: 'Navigate', navigation: 'Navigate', firefox_list_tabs: 'List tabs', firefox_tab_action: 'Tab action', firefox_request_access: 'Request access', firefox_status: 'Status', firefox_release_tab: 'Release tab', firefox_history: 'History', firefox_bookmarks: 'Bookmarks', firefox_console: 'Console', firefox_network: 'Network', firefox_inspect: 'Inspect element', firefox_performance: 'Performance', firefox_wait: 'Wait for page', firefox_download: 'Download', firefox_upload: 'Upload', firefox_point: 'Pointer', firefox_frames: 'Frames', firefox_media: 'Media', firefox_tab_group: 'Tab groups' };
const rendered = new Map();
const busy = new WeakSet();
let state = null;
let refreshing = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
async function send(message) {
  const result = await browser.runtime.sendMessage(message);
  if (!result) throw new Error('Firefox Bridge did not respond. Reload the extension and try again.');
  if (result.error) throw new Error(result.error);
  return result;
}
async function perform(control, job) {
  const focusKey = document.activeElement === control ? control.dataset.focusKey : null;
  busy.add(control);
  control.disabled = true;
  try { await job(); notice(''); await refresh(); }
  catch (error) { notice(error.message); }
  finally {
    busy.delete(control);
    if (control.isConnected) control.disabled = control.id === 'release-all' && !state?.controlledTabs;
    if (focusKey && (document.activeElement === document.body || document.activeElement === control)) [...document.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey)?.focus();
  }
}
function button(text, className, job, accessibleLabel) {
  const element = node('button', text, className);
  element.type = 'button';
  if (accessibleLabel) element.setAttribute('aria-label', accessibleLabel);
  element.addEventListener('click', () => { void perform(element, job); });
  return element;
}
function changed(key, value) {
  const serialized = JSON.stringify(value);
  if (rendered.get(key) === serialized) return false;
  rendered.set(key, serialized);
  return true;
}
function renderSites(passive) {
  const entries = Object.entries(state.policy.rules).sort(([a], [b]) => a.localeCompare(b));
  $('#site-count').textContent = String(entries.length);
  if (passive && $('#sites-list').contains(document.activeElement)) return;
  if (!changed('sites', entries)) return;
  const container = $('#sites-list');
  container.replaceChildren();
  if (!entries.length) container.append(node('p', 'No site exceptions.', 'empty'));
  for (const [origin, rule] of entries) {
    const row = node('div', undefined, 'site-row');
    const heading = node('div', undefined, 'site-title');
    heading.append(node('span', origin, 'site-origin'), button('Remove', 'quiet', () => send({ action: 'revoke', origin }), `Remove the rule for ${origin} and restore default access`));
    const grid = node('div', undefined, 'capability-grid');
    for (const [capability, label] of [['browse', 'Browsing'], ['download', 'Downloads'], ['upload', 'Uploads'], ['debug', 'Debugging']]) {
      const field = node('label', label);
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${label} on ${origin}`);
      select.dataset.origin = origin;
      select.dataset.capability = capability;
      select.dataset.focusKey = `${origin}:${capability}`;
      for (const [value, text] of [['inherit', 'Default'], ['ask', 'Ask'], ['allow', 'Allow'], ['block', 'Block']]) { const option = node('option', text); option.value = value; select.append(option); }
      const values = capability === 'browse' ? new Set(BROWSE.map(cap => rule[cap] ?? 'inherit')) : new Set([rule[capability] ?? 'inherit']);
      if (values.size > 1) { const option = node('option', 'Custom'); option.value = 'custom'; option.disabled = true; select.append(option); }
      select.value = values.size > 1 ? 'custom' : [...values][0];
      select.addEventListener('change', () => { void perform(select, () => send({ action: 'decision', origin, capabilities: capability === 'browse' ? BROWSE : [capability], decision: select.value })); });
      field.append(select); grid.append(field);
    }
    row.append(heading, grid); container.append(row);
  }
}
function renderPending() {
  $('#pending-section').hidden = !state.pending.length;
  $('#pending-count').textContent = String(state.pending.length);
  if (!changed('pending', state.pending)) return;
  const container = $('#pending-list');
  for (const row of [...container.children]) if (!state.pending.some(item => item.id === row.dataset.requestId)) row.remove();
  for (const item of state.pending) {
    if ([...container.children].some(row => row.dataset.requestId === item.id)) continue;
    const row = node('div', undefined, 'request-row');
    row.dataset.requestId = item.id;
    const capabilities = [...new Set(item.capabilities.map(capability => labels[capability]))].join(' · ');
    const reason = node('p', item.reason, 'request-reason');
    reason.setAttribute('aria-label', `Assistant's reason: ${item.reason}`);
    row.append(node('div', item.origin, 'request-origin'), node('p', capabilities, 'request-capabilities'), reason);
    const actions = node('div', undefined, 'request-actions');
    for (const [decision, text, style] of [['once', 'Allow once', ''], ['allow', 'Always allow', 'secondary'], ['block', 'Block', 'danger']]) actions.append(button(text, style, () => send({ action: 'decision', requestId: item.id, decision }), `${text}: ${item.origin}; ${capabilities}`));
    row.append(actions); container.append(row);
  }
}
function renderUploads() {
  const items = state.uploads ?? [];
  $('#upload-section').hidden = !items.length;
  const container = $('#upload-list');
  for (const row of [...container.children]) if (!items.some(item => item.id === row.dataset.requestId)) row.remove();
  for (const item of items) {
    if ([...container.children].some(row => row.dataset.requestId === item.id)) continue;
    const row = node('div', undefined, 'request-row');
    row.dataset.requestId = item.id;
    row.append(node('div', item.origin, 'request-origin'));
    const label = node('label', item.label || 'Files');
    const input = document.createElement('input');
    input.type = 'file'; input.accept = item.accept ?? ''; input.multiple = item.multiple;
    input.id = `upload-file-${item.id}`; input.hidden = true; label.htmlFor = input.id;
    input.setAttribute('aria-label', `Choose files for ${item.origin}`);
    const picker = node('div', undefined, 'file-picker');
    const selection = node('span', 'No file selected', 'file-selection');
    selection.setAttribute('aria-live', 'polite');
    const choose = node('button', item.multiple ? 'Choose files' : 'Choose file', 'secondary');
    choose.type = 'button';
    choose.setAttribute('aria-label', `Choose files for ${item.origin}`);
    choose.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { selection.textContent = [...input.files].map(file => file.name).join(', ') || 'No file selected'; });
    picker.append(choose, selection, input);
    const attach = button('Attach', '', async () => {
      const files = [...input.files];
      if (!files.length) throw new Error('Choose a file first.');
      if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024) throw new Error('Choose up to 10 files, totaling no more than 5 MiB.');
      const encoded = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result).split(',')[1] });
        reader.onerror = () => reject(new Error('The selected file could not be read. Choose it again.'));
        reader.readAsDataURL(file);
      })));
      await send({ action: 'upload_files', requestId: item.id, files: encoded });
      input.value = '';
    }, `Attach files to ${item.origin}`);
    const actions = node('div', undefined, 'request-actions');
    actions.append(attach, button('Cancel', 'quiet', async () => { await send({ action: 'dismiss_upload', requestId: item.id }); input.value = ''; }, `Cancel upload to ${item.origin}`));
    row.append(label, picker, node('p', 'This site may send files as soon as you attach them. Up to 5 MiB.', 'hint'), actions);
    container.append(row);
  }
}
function renderAudit() {
  if (!changed('audit', state.audit)) return;
  const container = $('#audit-list'); container.replaceChildren();
  if (!state.audit.length) container.append(node('li', 'No activity yet.', 'empty'));
  for (const item of state.audit) {
    const row = node('li');
    const time = node('time', new Date(item.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }));
    time.dateTime = item.time;
    row.append(node('strong', names[item.operation] ?? item.operation.replace(/^firefox_/, '').replaceAll('_', ' ')), document.createTextNode(` · ${item.outcome === 'allowed' ? 'Allowed' : 'Stopped'} · `), time);
    if (item.origin) row.append(node('div', item.origin, 'audit-origin'));
    if (item.code) row.append(node('div', item.code, 'audit-origin'));
    container.append(row);
  }
}
async function refresh({ passive = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await send({ action: 'state' });
    $('#access-status').textContent = state.policy.enabled ? 'Access enabled' : 'Access paused';
    $('#access-detail').textContent = state.policy.enabled ? state.policy.defaultBrowse === 'allow' ? 'All sites, except your blocked sites.' : 'Only sites you allow.' : 'Your assistant cannot read or act.';
    $('#toggle-access').textContent = state.policy.enabled ? 'Pause' : 'Enable';
    $('#toggle-access').disabled = busy.has($('#toggle-access'));
    if (!passive || document.activeElement !== $('#default-browse')) $('#default-browse').value = state.policy.defaultBrowse;
    $('#site-summary').textContent = state.policy.defaultBrowse === 'allow' ? 'All sites' : 'Ask each site';
    $('#connection-state').textContent = state.connection.paired ? 'Connected' : state.connection.error ? 'Connection unavailable' : 'Connecting…';
    $('#connection-state').classList.toggle('connected', state.connection.paired);
    $('#connection-help').hidden = !state.connection.error;
    $('#connection-error').textContent = state.connection.error || '';
    $('#managed-section').hidden = !state.controlledTabs;
    $('#managed-description').textContent = `${state.controlledTabs} ${state.controlledTabs === 1 ? 'tab' : 'tabs'} in use`;
    $('#release-all').disabled = !state.controlledTabs || busy.has($('#release-all'));
    $('#release-all').setAttribute('aria-label', `Release ${state.controlledTabs} controlled ${state.controlledTabs === 1 ? 'tab' : 'tabs'}`);
    $('#use-current').hidden = !state.currentOrigin;
    $('#version').textContent = state.version ? `v${state.version}` : '';
    for (const key of ['bookmarks', 'history', 'downloads', 'tabGroups']) {
      const control = $(`#extra-${key}`);
      if (!busy.has(control)) control.checked = Boolean(state.extras[key]);
    }
    renderPending(); renderSites(passive); renderUploads(); renderAudit();
  } catch (error) { notice(error.message); }
  finally { refreshing = false; }
}

$('#toggle-access').addEventListener('click', event => { void perform(event.currentTarget, () => send({ action: state.policy.enabled ? 'pause' : 'resume' })); });
$('#release-all').addEventListener('click', event => { void perform(event.currentTarget, () => send({ action: 'release_all' })); });
$('#default-browse').addEventListener('change', event => { void perform(event.currentTarget, () => send({ action: 'default_browse', value: event.currentTarget.value })); });
$('#retry-connection').addEventListener('click', event => { void perform(event.currentTarget, () => send({ action: 'retry_connection' })); });
$('#site-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(event.submitter, async () => { await send({ action: 'decision', origin: $('#site-url').value, capabilities: BROWSE, decision: $('#site-decision').value }); $('#site-url').value = ''; $('#add-site').open = false; $('#add-site summary').focus(); });
});
$('#use-current').addEventListener('click', () => { $('#site-url').value = state.currentOrigin; $('#site-url').focus(); });
for (const permission of ['bookmarks', 'history', 'downloads', 'tabGroups']) {
  $(`#extra-${permission}`).addEventListener('change', event => {
    const checkbox = event.currentTarget;
    const granted = checkbox.checked ? browser.permissions.request({ permissions: [permission] }) : browser.permissions.remove({ permissions: [permission] });
    void perform(checkbox, async () => { await granted; });
  });
}
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh({ passive: true });
}, 3000);
