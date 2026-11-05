import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pageOperation } from '../src/page-operation.mjs';

function page() {
  const dom = new JSDOM('<!doctype html><body><h1>Test</h1><label for="name">Name</label><input id="name"><input id="password" type="password" value="SECRET"><input autocomplete="one-time-code" value="OTP"><button id="send">Send</button><a href="javascript:alert(1)">Special</a><select><option value="a">A</option><option value="b">B</option></select><div hidden>HIDDEN</div></body>', { url: 'https://allowed.test/page', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }; };
  dom.window.HTMLElement.prototype.scrollIntoView = function () { dom.window.document.elementFromPoint = () => this; };
  return { dom, run: request => dom.window.eval(`(${pageOperation.toString()})`)({ expectedUrl: dom.window.location.href, ...request }) };
}
test('snapshots redact passwords and codes and omit hidden content', () => {
  const { dom, run } = page(); const result = run({ action: 'read', maxChars: 20000 });
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.ok(!JSON.stringify(result).includes('OTP')); assert.ok(!result.text.includes('HIDDEN'));
  assert.equal(result.elements.filter(e => e.sensitive).length, 2); dom.window.close();
});
test('fill changes an observed field and invalidates references', async () => {
  const { dom, run } = page(); const read = run({ action: 'read', maxChars: 20000 });
  const input = read.elements.find(e => e.label === 'Name');
  await run({ action: 'fill', snapshotId: read.snapshotId, ref: input.ref, value: '<script>literal</script>' });
  assert.equal(dom.window.document.querySelector('#name').value, '<script>literal</script>');
  assert.throws(() => run({ action: 'fill', snapshotId: read.snapshotId, ref: input.ref, value: 'again' }), /expired/); dom.window.close();
});
test('removed elements, secrets, and special links are rejected', () => {
  const { dom, run } = page(); let read = run({ action: 'read', maxChars: 20000 });
  const password = read.elements.find(e => e.type === 'password');
  assert.throws(() => run({ action: 'fill', snapshotId: read.snapshotId, ref: password.ref, value: 'x' }), /manual/);
  const anchor = read.elements.find(e => e.tag === 'a');
  assert.throws(() => run({ action: 'click', snapshotId: read.snapshotId, ref: anchor.ref }), /Special/);
  const button = read.elements.find(e => e.tag === 'button'); dom.window.document.querySelector('#send').remove();
  assert.throws(() => run({ action: 'click', snapshotId: read.snapshotId, ref: button.ref }), /removed/); dom.window.close();
});
test('selection preserves select semantics and emits one change', async () => {
  const { dom, run } = page(); const read = run({ action: 'read', maxChars: 20000 });
  const select = read.elements.find(e => e.tag === 'select'); let changes = 0;
  dom.window.document.querySelector('select').addEventListener('change', () => changes++);
  await run({ action: 'select', snapshotId: read.snapshotId, ref: select.ref, values: ['b'] });
  assert.equal(dom.window.document.querySelector('select').value, 'b'); assert.equal(changes, 1); dom.window.close();
});

test('changed button meaning and manual field edits invalidate references', () => {
  const { dom, run } = page(); const read = run({ action: 'read', maxChars: 20000 });
  const button = read.elements.find(e => e.tag === 'button');
  dom.window.document.querySelector('#send').textContent = 'Delete account';
  assert.throws(() => run({ action: 'click', snapshotId: read.snapshotId, ref: button.ref }), /changed/);
  const input = read.elements.find(e => e.label === 'Name'); dom.window.document.querySelector('#name').value = 'User typed';
  assert.throws(() => run({ action: 'fill', snapshotId: read.snapshotId, ref: input.ref, value: 'overwrite' }), /changed/); dom.window.close();
});

test('screenshot clicks reject mutations and file inputs use their dedicated workflow', () => {
  const { dom, run } = page(); const observation = run({ action: 'geometry' });
  dom.window.document.querySelector('#send').textContent = 'Changed';
  assert.throws(() => run({ action: 'point', observation, command: 'click', x: 10, y: 10 }), /expired/);
  const file = dom.window.document.createElement('input'); file.type = 'file'; file.style.display = 'none'; dom.window.document.body.append(file);
  const snapshot = run({ action: 'read', maxChars: 20000 }); const item = snapshot.elements.find(e => e.type === 'file');
  assert.ok(item); assert.equal(run({ action: 'upload_probe', ref: item.ref, snapshotId: snapshot.snapshotId }).multiple, false);
  dom.window.close();
});

test('snapshots include open shadow DOM, accessible names, and control state', async () => {
  const { dom, run } = page();
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<span id="label">Preference</span><input type="checkbox" aria-labelledby="label" checked><p>Component text</p>';
  const read = run({ action: 'read' });
  const item = read.elements.find(e => e.label === 'Preference');
  assert.equal(item.role, 'checkbox');
  assert.equal(item.checked, true);
  assert.equal(item.shadowRoot, true);
  assert.ok(read.text.includes('Component text'));
  const events = [];
  host.addEventListener('click', event => events.push({ composed: event.composed, trusted: event.isTrusted }));
  await run({ action: 'click', snapshotId: read.snapshotId, ref: item.ref });
  assert.equal(root.querySelector('input').checked, false);
  assert.deepEqual(events, [{ composed: true, trusted: false }]);
  dom.window.close();
});

test('click dispatches a pointer sequence with coordinates and one activation', async () => {
  const { dom, run } = page();
  const button = dom.window.document.querySelector('#send');
  const order = [];
  for (const type of ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) button.addEventListener(type, event => {
    order.push(type);
    if (type !== 'focus') { assert.equal(event.clientX, 60); assert.equal(event.clientY, 20); assert.equal(event.isTrusted, false); }
  });
  const read = run({ action: 'read' });
  await run({ action: 'click', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'button').ref });
  assert.deepEqual(order, ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']);
  dom.window.close();
});

test('overlays reject clicks before dispatching events', async () => {
  const { dom, run } = page();
  const button = dom.window.document.querySelector('#send');
  const overlay = dom.window.document.createElement('div');
  dom.window.document.body.append(overlay);
  button.scrollIntoView = () => { dom.window.document.elementFromPoint = () => overlay; };
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  const read = run({ action: 'read' });
  await assert.rejects(run({ action: 'click', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'button').ref }), /covered/);
  assert.equal(clicks, 0);
  dom.window.close();
});

test('pointerdown target changes abort before activating a changed button', async () => {
  const { dom, run } = page();
  const button = dom.window.document.querySelector('#send');
  button.addEventListener('pointerdown', () => { button.textContent = 'Delete all'; });
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  const read = run({ action: 'read' });
  await assert.rejects(run({ action: 'click', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'button').ref }), /changed/);
  assert.equal(clicks, 0);
  assert.equal(dom.window.__firefoxBridgeDocument.snapshotId, null);
  dom.window.close();
});

test('unstable animation and navigation during a wait prevent mutation', async () => {
  const { dom, run } = page();
  const button = dom.window.document.querySelector('#send');
  let position = 10;
  button.getBoundingClientRect = () => ({ x: position++, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 });
  const read = run({ action: 'read' });
  await assert.rejects(run({ action: 'click', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'button').ref }), /moving/);
  const read2 = run({ action: 'read' });
  const pending = run({ action: 'fill', snapshotId: read2.snapshotId, ref: read2.elements.find(e => e.label === 'Name').ref, value: 'new' });
  dom.window.history.pushState({}, '', '/other');
  await assert.rejects(pending, /page changed/);
  assert.equal(dom.window.document.querySelector('#name').value, '');
  dom.window.close();
});

test('canceled beforeinput preserves values and native setters bypass framework overrides', async () => {
  const { dom, run } = page();
  const field = dom.window.document.querySelector('#name');
  const cancel = event => event.preventDefault();
  field.addEventListener('beforeinput', cancel);
  let read = run({ action: 'read' });
  const canceled = await run({ action: 'fill', snapshotId: read.snapshotId, ref: read.elements.find(e => e.label === 'Name').ref, value: 'blocked' });
  assert.equal(canceled.performed, false);
  assert.equal(field.value, '');
  field.removeEventListener('beforeinput', cancel);
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value');
  Object.defineProperty(field, 'value', { get() { return descriptor.get.call(this); }, set() { throw new Error('framework setter'); } });
  let seen;
  field.addEventListener('input', event => { seen = { data: event.data, inputType: event.inputType, composed: event.composed }; });
  read = run({ action: 'read' });
  await run({ action: 'fill', snapshotId: read.snapshotId, ref: read.elements.find(e => e.label === 'Name').ref, value: 'native' });
  assert.equal(field.value, 'native');
  assert.deepEqual(seen, { data: 'native', inputType: 'insertReplacementText', composed: true });
  dom.window.close();
});

test('readonly, disabled fieldsets, and disabled optgroups are respected', async () => {
  const { dom, run } = page();
  const field = dom.window.document.querySelector('#name');
  field.readOnly = true;
  let read = run({ action: 'read' });
  assert.equal(read.elements.find(e => e.label === 'Name').readonly, true);
  await assert.rejects(run({ action: 'fill', snapshotId: read.snapshotId, ref: read.elements.find(e => e.label === 'Name').ref, value: 'new' }), /read-only/);
  const group = dom.window.document.createElement('fieldset');
  group.disabled = true;
  dom.window.document.body.append(group);
  group.append(field);
  read = run({ action: 'read' });
  const item = read.elements.find(e => e.label === 'Name');
  assert.equal(item.disabled, true);
  assert.throws(() => run({ action: 'fill', snapshotId: read.snapshotId, ref: item.ref, value: 'new' }), /disabled/);
  dom.window.document.querySelector('select').innerHTML = '<option value="a">A</option><optgroup disabled><option value="b">B</option></optgroup>';
  read = run({ action: 'read' });
  await assert.rejects(run({ action: 'select', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'select').ref, values: ['b'] }), /disabled/);
  dom.window.close();
});

test('shadow DOM participates in screenshot invalidation and respects hidden hosts', () => {
  const { dom, run } = page();
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button>Shadow action</button>';
  const observation = run({ action: 'geometry' });
  root.querySelector('button').textContent = 'Changed action';
  assert.throws(() => run({ action: 'point', observation, command: 'click', x: 20, y: 20 }), /expired/);
  host.hidden = true;
  assert.ok(!run({ action: 'read' }).text.includes('Changed action'));
  dom.window.close();
});

test('sensitive autocomplete tokens and file labels cannot bypass manual input', () => {
  const { dom, run } = page();
  dom.window.document.body.insertAdjacentHTML('beforeend', '<input autocomplete="section-checkout shipping cc-number" value="CARD_SECRET"><div contenteditable="true" autocomplete="one-time-code">EDITABLE_SECRET</div><label for="upload" tabindex="0">Upload</label><input id="upload" type="file">');
  const read = run({ action: 'read' });
  assert.ok(!JSON.stringify(read).includes('CARD_SECRET'));
  assert.ok(!JSON.stringify(read).includes('EDITABLE_SECRET'));
  const label = read.elements.find(e => e.tag === 'label');
  assert.throws(() => run({ action: 'click', snapshotId: read.snapshotId, ref: label.ref }), /manual/);
  dom.window.close();
});

test('Enter activates buttons and canceled keydown prevents default activation', async () => {
  const { dom, run } = page();
  const button = dom.window.document.querySelector('#send');
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  let read = run({ action: 'read' });
  await run({ action: 'key', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'button').ref, key: 'Enter' });
  assert.equal(clicks, 1);
  button.addEventListener('keydown', event => event.preventDefault());
  read = run({ action: 'read' });
  await run({ action: 'key', snapshotId: read.snapshotId, ref: read.elements.find(e => e.tag === 'button').ref, key: 'Enter' });
  assert.equal(clicks, 1);
  dom.window.close();
});
