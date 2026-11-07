// Run: node --test tests/extension.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function background(config = {}) {
  let listener;
  const calls = [];
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: { local: {
      setAccessLevel: async (value) => { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
      get: async () => config,
      set: async (values) => Object.assign(config, values),
    } },
    cookies: { getAll: async () => [{ name: 'test', value: 'synthetic-cookie' }] },
  };
  const context = vm.createContext({ chrome, AbortSignal, fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  } });
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  const send = (message, senderId = 'test-extension') => new Promise((resolve) => {
    const result = listener(message, { id: senderId }, resolve);
    if (result !== true) resolve(undefined);
  });
  return { send, calls };
}

test('default local mode and query-bearing incremental sync', async () => {
  const { send, calls } = background();
  assert.equal((await send({ type: 'api', path: '/api/sync_state?uid=123' })).ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/api/sync_state?uid=123');
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('remote ingest and cookies use configured credentials without following redirects', async () => {
  const { send, calls } = background({ serverUrl: 'https://nas.example', apiToken: 'test-secret' });
  await send({ type: 'api', path: '/api/ingest', method: 'POST', body: { uid: '123', messages: [] } });
  const reply = await send({ type: 'send_cookies' });
  assert.equal(reply.apiToken, undefined);
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://nas.example/api/'));
    assert.equal(call.options.headers.Authorization, 'Bearer test-secret');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
  }
  assert.equal(JSON.parse(calls[1].options.body).cookie, 'test=synthetic-cookie');
});

test('rejects external paths and senders before attaching credentials', async () => {
  const { send, calls } = background({ apiToken: 'test-secret' });
  for (const path of ['https://other.example/api/health', '//other.example/api/health', '/api/../media/x']) {
    assert.equal((await send({ type: 'api', path })).ok, false);
  }
  assert.equal(await send({ type: 'api', path: '/api/health' }, 'another-extension'), undefined);
  assert.equal(calls.length, 0);
});

test('content-script preferences remain usable without exposing or overwriting credentials', async () => {
  const config = { apiToken: 'private-token', autoIncremental: true, lastIncrementalAt: 10 };
  const { send } = background(config);
  const reply = await send({ type: 'get_preferences' });
  assert.equal(reply.data.autoIncremental, true);
  assert.equal(reply.data.apiToken, undefined);
  await send({ type: 'set_preferences', values: { autoIncremental: false, lastIncrementalAt: 20, apiToken: 'overwrite' } });
  assert.equal(config.autoIncremental, false);
  assert.equal(config.lastIncrementalAt, 20);
  assert.equal(config.apiToken, 'private-token');
});

function popup(granted = true) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', href: '',
      addEventListener(event, handler) { this[event] = handler; } });
    return elements.get(id);
  };
  const saved = [], permissions = [];
  const chrome = {
    storage: { local: { get: async () => ({}), set: async (config) => saved.push(config) } },
    permissions: { request: async (value) => { permissions.push(value); return granted; } },
    runtime: { sendMessage: async ({ path }) => ({ ok: true, data: path === '/api/health'
      ? { service: 'weibo-dm-backup' } : { messages: 10, contacts: 2 } }) },
  };
  const context = vm.createContext({ chrome, URL, document: { getElementById: element } });
  vm.runInContext(fs.readFileSync('extension/popup.js', 'utf8'), context);
  return { element, saved, permissions };
}

test('popup requests selected host permission and saves tested NAS settings', async () => {
  const p = popup();
  await new Promise(setImmediate);
  p.element('server-url').value = 'https://nas.example:8443/';
  p.element('api-token').value = 'secret';
  await p.element('save-settings').click();
  assert.equal(p.permissions[0].origins[0], 'https://nas.example:8443/*');
  assert.equal(p.saved[0].serverUrl, 'https://nas.example:8443');
  assert.equal(p.element('manage-link').href, 'https://nas.example:8443');
  assert.match(p.element('settings-result').textContent, /连接成功/);
});

test('denied permissions and malformed URL never overwrite settings', async () => {
  const p = popup(false);
  await new Promise(setImmediate);
  p.element('server-url').value = 'https://nas.example';
  await p.element('save-settings').click();
  assert.equal(p.saved.length, 0);
  p.element('server-url').value = 'https://user:password@nas.example';
  await p.element('save-settings').click();
  assert.equal(p.saved.length, 0);
  assert.equal(p.permissions.length, 1);
});
