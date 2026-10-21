import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const script = fs.readFileSync(new URL('../public/notifications.js', import.meta.url), 'utf8');
const workerScript = fs.readFileSync(new URL('../public/notification-worker.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ permission = 'granted', focused = false, preference, supported = true, allowed = true,
  secure = true, mobile = false, workerAvailable = mobile, workerFailure = false, storageBlocked = false } = {}) {
  const elements = new Map();
  const byId = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      click() { if (!this.disabled) return this.listeners.click?.(); } });
    return elements.get(id);
  };
  const shown = [], workerMessages = [], registrations = [], timers = new Map();
  const storage = new Map(preference ? [['co2.task-notifications', preference]] : []);
  const state = { focused, allowed, views: 0, focuses: 0, requests: 0, settings: 0 };
  class Notification {
    static permission = permission;
    static requestPermission() { state.requests++; this.permission = 'granted'; return Promise.resolve(this.permission); }
    constructor(title, options) {
      if (mobile) throw new TypeError('Use service worker notifications');
      this.title = title; this.options = options; this.closed = false; shown.push(this);
    }
    close() { this.closed = true; }
  }
  class MessageChannel {
    constructor() {
      this.port1 = { close() {}, onmessage: null };
      this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  }
  const registration = { active: { postMessage(data, ports) { workerMessages.push(data); ports[0].postMessage({ ok: !workerFailure }); } },
    getNotifications: () => Promise.resolve([]) };
  const serviceWorker = {
    listeners: {}, ready: Promise.resolve(registration),
    register: (...args) => { registrations.push(args); return Promise.resolve(registration); },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  };
  let timer = 0;
  const window = {
    ...(supported ? { Notification } : {}), isSecureContext: secure, MessageChannel,
    navigator: workerAvailable ? { serviceWorker } : {}, listeners: {},
    localStorage: {
      getItem: key => { if (storageBlocked) throw new Error('blocked'); return storage.get(key); },
      setItem: (key, value) => { if (storageBlocked) throw new Error('blocked'); storage.set(key, value); },
    },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout(id) { timers.delete(id); },
    focus() { state.focuses++; },
  };
  const document = { getElementById: byId, visibilityState: focused ? 'visible' : 'hidden', hasFocus: () => state.focused };
  vm.runInNewContext(script, { window, document, crypto: webcrypto, Promise });
  const controller = window.createTaskNotifications({ canReceive: () => state.allowed, onView: () => { state.views++; }, onSettings: () => { state.settings++; } });
  return { byId, controller, Notification, state, shown, storage, window, registrations, workerMessages, timers, serviceWorker, document };
}

test('only an observed live running-to-idle transition notifies, once per run', () => {
  const f = fixture();
  f.controller.observe('idle'); assert.equal(f.shown.length, 0);
  f.controller.observe('running'); f.controller.observe('running'); assert.equal(f.shown.length, 0);
  f.controller.observe('idle'); f.controller.observe('idle'); assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].title, 'Codex Co²');
  assert.equal(f.shown[0].options.body, 'Agent 本轮运行已结束，点击查看结果。');
  assert.equal(Object.hasOwn(f.shown[0].options, 'data'), false);
  f.controller.observe('running'); f.controller.observe('idle'); assert.equal(f.shown.length, 2);
  assert.equal(f.shown[0].closed, true);
});

test('disconnect, offline, reconnection baselines and revoked access cannot produce historical or late alerts', () => {
  const f = fixture();
  f.controller.observe('running'); f.controller.reset(); f.controller.observe('idle');
  f.controller.observe('running'); f.controller.observe('offline'); f.controller.observe('idle');
  assert.equal(f.shown.length, 0);
  f.controller.observe('running'); f.controller.observe('idle');
  assert.equal(f.shown.length, 1);
  f.state.allowed = false; f.controller.reset();
  assert.equal(f.shown[0].closed, true);
  f.shown[0].onclick(); assert.equal(f.state.views, 0);
  f.controller.observe('running'); f.controller.observe('idle'); assert.equal(f.shown.length, 1);
});

test('foreground completion uses a page toast and viewing results is explicit', () => {
  const f = fixture({ focused: true });
  f.controller.observe('running'); f.controller.observe('idle');
  assert.equal(f.shown.length, 0);
  assert.equal(f.byId('task-toast').hidden, false);
  assert.equal(f.byId('task-toast-text').textContent, 'Agent 本轮运行已结束。');
  assert.equal(f.state.views, 0);
  f.byId('task-toast-action').click();
  assert.equal(f.state.views, 1);
  assert.equal(f.byId('task-toast').hidden, true);
});

test('notification click focuses only the admitted page and views its latest reply', () => {
  const f = fixture(); f.controller.observe('running'); f.controller.observe('idle');
  f.shown[0].onclick();
  assert.equal(f.shown[0].closed, true);
  assert.equal(f.state.focuses, 1); assert.equal(f.state.views, 1);
});

test('permission is requested only from an explicit enable click and a grant does not replay completion', async () => {
  const f = fixture({ permission: 'default' });
  f.controller.observe('idle'); f.controller.observe('running'); f.controller.observe('idle');
  assert.equal(f.state.requests, 0); assert.equal(f.shown.length, 0);
  await f.byId('notification-toggle').click();
  assert.equal(f.state.requests, 1); assert.equal(f.storage.get('co2.task-notifications'), 'on');
  assert.equal(f.shown.length, 0);
  f.controller.observe('idle'); assert.equal(f.shown.length, 0);
  f.controller.observe('running'); f.controller.observe('idle'); assert.equal(f.shown.length, 1);
});

test('denied, unsupported, insecure and muted notifications keep page reminders usable', async () => {
  for (const options of [{ permission: 'denied' }, { supported: false }, { secure: false }, { preference: 'off' }]) {
    const f = fixture(options); f.controller.observe('running'); f.controller.observe('idle');
    assert.equal(f.shown.length, 0); assert.equal(f.byId('task-toast').hidden, false);
    assert.equal(f.state.requests, 0);
    if (options.permission === 'denied') {
      await f.byId('notification-toggle').click(); assert.equal(f.state.requests, 0);
      assert.match(f.byId('notification-status').textContent, /通知权限/);
    }
  }
  const f = fixture(); await f.byId('notification-toggle').click();
  assert.equal(f.storage.get('co2.task-notifications'), 'off');
  f.controller.observe('running'); f.controller.observe('idle'); assert.equal(f.shown.length, 0);
});

test('dismissing the opt-in prompt suppresses it, and blocked storage does not prevent enabling', async () => {
  const dismissed = fixture({ permission: 'default' }); dismissed.controller.observe('running');
  dismissed.byId('task-toast-dismiss').click();
  assert.equal(dismissed.storage.get('co2.task-notifications'), 'off');
  assert.equal(dismissed.byId('task-toast').hidden, true);
  const f = fixture({ permission: 'default', storageBlocked: true });
  await f.byId('notification-toggle').click();
  f.controller.observe('running'); f.controller.observe('idle'); assert.equal(f.shown.length, 1);
});

test('mobile constructor failures use a bounded worker message without transcript or credentials', async () => {
  const f = fixture({ mobile: true }); f.controller.observe('running'); f.controller.observe('idle'); await settle();
  assert.equal(f.registrations[0][0], '/notification-worker.js');
  assert.deepEqual(Object.keys(f.workerMessages[0]).sort(), ['pageToken', 'type']);
  const pageToken = f.workerMessages[0].pageToken;
  f.serviceWorker.listeners.message({ data: { type: 'co2-task-notification-click', pageToken: 'another-page' } });
  assert.equal(f.state.views, 0);
  f.serviceWorker.listeners.message({ data: { type: 'co2-task-notification-click', pageToken } });
  assert.equal(f.state.views, 1);
  f.state.allowed = false;
  f.serviceWorker.listeners.message({ data: { type: 'co2-task-notification-click', pageToken } });
  assert.equal(f.state.views, 1);
});

test('a pending worker activation is cancelled by disconnect and delivery failures keep the toast', async () => {
  const f = fixture({ mobile: true });
  let ready; f.serviceWorker.ready = new Promise(resolve => { ready = resolve; });
  f.controller.observe('running'); f.controller.observe('idle'); f.controller.reset();
  ready({ active: { postMessage() { throw new Error('must not be reached'); } }, getNotifications: () => Promise.resolve([]) });
  await settle(); assert.equal(f.workerMessages.length, 0);
  const failed = fixture({ mobile: true, workerFailure: true });
  failed.controller.observe('running'); failed.controller.observe('idle'); await settle();
  assert.match(failed.byId('notification-status').textContent, /系统通知未能发送/);
  assert.equal(failed.byId('task-toast').hidden, false);
  assert.equal(failed.byId('task-toast-action').textContent, '通知设置');
  failed.byId('task-toast-action').click(); assert.equal(failed.state.settings, 1);
});

test('notification worker targets the original client only and never opens a new invitation', async () => {
  const listeners = {}, shown = [], replies = [], focused = [], messages = [];
  const pageToken = '11111111-1111-4111-8111-111111111111';
  const clients = new Map([['original', { url: 'https://synthetic.invalid/', focus: async () => focused.push('original'), postMessage: data => messages.push(data) }]]);
  const self = { location: { origin: 'https://synthetic.invalid' },
    addEventListener(name, listener) { listeners[name] = listener; },
    clients: { get: async id => clients.get(id), claim: async () => {} }, skipWaiting: async () => {},
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } } };
  vm.runInNewContext(workerScript, { self, URL });
  const dispatch = async (name, event) => {
    const pending = []; listeners[name]({ ...event, waitUntil: value => pending.push(value) }); await Promise.all(pending);
  };
  await dispatch('message', { data: { type: 'co2-task-ended', pageToken }, source: { id: 'original', url: 'https://synthetic.invalid/' }, ports: [{ postMessage: data => replies.push(data) }] });
  assert.equal(shown.length, 1); assert.equal(replies[0].ok, true);
  assert.deepEqual(Object.keys(shown[0].options.data).sort(), ['clientId', 'pageToken']);
  const notification = { data: shown[0].options.data, close() {} };
  await dispatch('notificationclick', { notification });
  assert.deepEqual(focused, ['original']); assert.equal(messages[0].pageToken, pageToken);
  clients.set('same-url-decoy', { url: 'https://synthetic.invalid/', focus: async () => focused.push('wrong-tab'), postMessage: () => assert.fail('wrong tab received a result selection') });
  clients.get('original').focus = async () => { throw new Error('synthetic focus rejection'); };
  await dispatch('notificationclick', { notification });
  assert.equal(messages.length, 2, 'queue result selection even if the browser rejects focus');
  clients.delete('original'); await dispatch('notificationclick', { notification });
  assert.deepEqual(focused, ['original'], 'do not fall back to a different tab with the same URL');
  await dispatch('message', { data: { type: 'co2-task-ended', pageToken }, source: { id: 'foreign', url: 'https://other.invalid/' }, ports: [] });
  assert.equal(shown.length, 1);
  assert.equal(Object.hasOwn(listeners, 'fetch'), false); assert.equal(Object.hasOwn(listeners, 'push'), false);
});

test('desktop also prefers the worker so its notification retains the originating browser client', async () => {
  const f = fixture({ workerAvailable: true });
  f.controller.observe('running'); f.controller.observe('idle'); await settle();
  assert.equal(f.workerMessages.length, 1);
  assert.equal(f.shown.length, 0, 'do not use window.focus notifications when a worker is available');
  assert.equal(f.registrations[0][0], '/notification-worker.js');
});

test('browser focus does not remove a notification before its click handler runs', () => {
  const f = fixture(); f.controller.observe('running'); f.controller.observe('idle');
  f.window.listeners.focus();
  assert.equal(f.shown[0].closed, false);
  f.shown[0].onclick();
  assert.equal(f.state.focuses, 1); assert.equal(f.state.views, 1);
  assert.equal(f.shown[0].closed, true);
});

test('failed worker delivery falls back to a page notification and can activate a disconnected original tab', async () => {
  const f = fixture({ workerAvailable: true, workerFailure: true });
  f.controller.observe('running'); f.controller.observe('idle'); await settle();
  assert.equal(f.shown.length, 1);
  f.state.allowed = false;
  f.shown[0].onclick();
  assert.equal(f.state.focuses, 1, 'activation of the existing tab is not an admission capability');
  assert.equal(f.state.views, 0, 'revoked content must not be displayed');
});

test('prepare the worker during the live run, before the background completion', async () => {
  const f = fixture({ workerAvailable: true, focused: true });
  f.controller.observe('running'); await settle();
  assert.equal(f.registrations.length, 1);
  assert.equal(f.workerMessages.length, 0);
  f.document.visibilityState = 'hidden'; f.state.focused = false;
  f.controller.observe('idle'); await settle();
  assert.equal(f.registrations.length, 1);
  assert.equal(f.workerMessages.length, 1);
});

test('a hung registration has a timeout and still falls back to the page notification', async () => {
  const f = fixture({ workerAvailable: true });
  f.serviceWorker.register = () => new Promise(() => {});
  f.controller.observe('running'); f.controller.observe('idle');
  const deadline = [...f.timers.values()].find(timer => timer.ms === 5000);
  assert.ok(deadline); deadline.fn(); await settle();
  assert.equal(f.shown.length, 1);
  assert.equal(f.workerMessages.length, 0);
});

test('explicit test notifications work in the foreground and do not fabricate task completion', async () => {
  const f = fixture({ workerAvailable: true, focused: true });
  await f.byId('notification-test').click();
  assert.equal(f.workerMessages.length, 1);
  assert.equal(f.workerMessages[0].test, true);
  assert.match(f.byId('notification-status').textContent, /测试通知已交给浏览器/);
  f.controller.observe('idle'); await settle();
  assert.equal(f.workerMessages.length, 1);
  f.state.allowed = false; await f.byId('notification-test').click();
  assert.equal(f.workerMessages.length, 2, 'generic browser tests do not require conversation access');
});

test('new-origin default permission explains why the run did not create a system notification', async () => {
  const f = fixture({ permission: 'default' });
  assert.match(f.byId('notification-status').textContent, /更换邀请的网站地址/);
  assert.equal(f.byId('notification-test').disabled, true);
  await f.byId('notification-test').click(); assert.equal(f.state.requests, 0);
  f.controller.observe('running'); f.controller.observe('idle');
  assert.match(f.byId('task-toast-text').textContent, /运行已结束.*尚未开启/);
  assert.equal(f.byId('task-toast-action').textContent, '开启通知');
  f.byId('task-toast-action').click(); await settle();
  assert.equal(f.state.requests, 1);
  assert.equal(f.shown.length, 0, 'no historical completion is replayed after granting permission');
});

test('late native delivery errors cannot reopen reminders after access is revoked', () => {
  const f = fixture(); f.controller.observe('running'); f.controller.observe('idle');
  f.state.allowed = false; f.controller.reset();
  f.shown[0].onerror(); f.shown[0].onshow();
  assert.equal(f.byId('task-toast').hidden, true);
});

test('granting notification permission enables a real test click before admission or while disconnected', async () => {
  for (const workerAvailable of [false, true]) {
    const f = fixture({ permission: 'default', allowed: false, workerAvailable });
    assert.equal(f.byId('notification-test').disabled, true);
    await f.byId('notification-toggle').click();
    assert.equal(f.Notification.permission, 'granted');
    assert.equal(f.byId('notification-test').disabled, false);
    await f.byId('notification-test').click();
    assert.equal(f.byId('notification-test').disabled, false);
    if (workerAvailable) {
      assert.equal(f.workerMessages.length, 1);
      assert.equal(f.workerMessages[0].test, true);
      assert.match(f.byId('notification-status').textContent, /测试通知已交给浏览器/);
      const {pageToken} = f.workerMessages[0];
      f.serviceWorker.listeners.message({ data: { type: 'co2-task-notification-click', pageToken } });
    } else {
      assert.equal(f.shown.length, 1);
      assert.match(f.shown[0].options.body, /测试通知/);
      f.shown[0].onshow();
      assert.match(f.byId('notification-status').textContent, /测试通知已交给浏览器/);
      f.shown[0].onclick();
      assert.equal(f.state.focuses, 1);
    }
    assert.equal(f.state.views, 0, 'test clicks cannot display an unadmitted conversation');
    f.controller.observe('running'); f.controller.observe('idle'); await settle();
    assert.equal(workerAvailable ? f.workerMessages.length : f.shown.length, 1, 'real task notifications still require admission');
  }
});

test('unadmitted test delivery errors remain visible and disabling permission disables the test button', async () => {
  const f = fixture({ allowed: false });
  await f.byId('notification-test').click(); f.shown[0].onerror();
  assert.match(f.byId('notification-status').textContent, /系统通知未能发送/);
  assert.equal(f.byId('task-toast').hidden, false);
  await f.byId('notification-toggle').click();
  assert.equal(f.byId('notification-test').disabled, true);
  await f.byId('notification-test').click(); assert.equal(f.shown.length, 1);
});

test('confirmed admission automatically requests once, and reconnects or duplicate admissions do not repeat it', async () => {
  const f = fixture({ permission: 'default', allowed: false });
  assert.equal(f.state.requests, 0);
  await f.controller.admitted();
  assert.equal(f.state.requests, 1);
  assert.equal(f.storage.get('co2.task-notifications'), 'on');
  assert.equal(f.byId('notification-test').disabled, false);
  assert.equal(f.shown.length, 0);
  await f.controller.admitted(); f.controller.reset(); await f.controller.admitted();
  assert.equal(f.state.requests, 1);
  assert.equal(f.shown.length, 0);
});

test('automatic admission respects previous grants, denials, mute and unsupported browsers', async () => {
  for (const options of [{}, { permission: 'denied' }, { permission: 'default', preference: 'off' }, { supported: false }, { secure: false }]) {
    const f = fixture(options); await f.controller.admitted();
    assert.equal(f.state.requests, 0);
    assert.equal(f.shown.length, 0);
    if (options.preference === 'off') assert.equal(f.storage.get('co2.task-notifications'), 'off');
    if (!Object.keys(options).length) assert.equal(f.byId('notification-test').disabled, false, 'an existing grant is not toggled off');
  }
});

test('browsers that silence automatic permission requests retain a persistent real-click fallback', async () => {
  const f = fixture({ permission: 'default' });
  const manual = f.Notification.requestPermission.bind(f.Notification);
  f.Notification.requestPermission = () => { f.state.requests++; return Promise.resolve('default'); };
  await f.controller.admitted();
  assert.equal(f.state.requests, 1);
  assert.equal(f.byId('task-toast').hidden, false);
  assert.equal(f.byId('task-toast-action').textContent, '开启通知');
  assert.equal(f.timers.size, 0, 'the fallback does not disappear while awaiting a real click');
  assert.equal(f.storage.has('co2.task-notifications'), false);
  f.controller.observe('running'); f.controller.observe('idle'); f.controller.reset(); await f.controller.admitted();
  assert.equal(f.state.requests, 1, 'do not retry on snapshots or reconnects');
  f.Notification.requestPermission = manual;
  await f.byId('notification-toggle').click();
  assert.equal(f.state.requests, 2);
  assert.equal(f.Notification.permission, 'granted');
});

test('an unresolved admission request cannot block state observation or restore reminders after revocation', async () => {
  const f = fixture({ permission: 'default' });
  let finish;
  f.Notification.requestPermission = () => { f.state.requests++; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.controller.admitted();
  assert.equal(f.state.requests, 1);
  assert.match(f.byId('notification-status').textContent, /浏览器的通知申请/);
  f.controller.observe('running'); f.controller.observe('idle');
  f.state.allowed = false; f.controller.reset(); finish('default'); await pending;
  assert.equal(f.byId('task-toast').hidden, true);
  assert.equal(f.shown.length, 0);
});
