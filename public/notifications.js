// Task notifications observe this admitted page only; explicit tests are generic.
// No conversation text, invitation
// or recovery credential is copied into browser notification storage.
window.createTaskNotifications = ({ canReceive, onView, onSettings = () => {} }) => {
  const byId = id => document.getElementById(id);
  const button = byId('notification-toggle');
  const status = byId('notification-status');
  const testButton = byId('notification-test');
  const toast = byId('task-toast');
  const toastText = byId('task-toast-text');
  const toastAction = byId('task-toast-action');
  const preferenceKey = 'co2.task-notifications';
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const pageToken = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const tag = `co2-task-${pageToken}`;
  let preference = '';
  try { preference = window.localStorage?.getItem(preferenceKey) || ''; } catch {}
  let previous = null, epoch = 0, prompting = false, prompted = false, admissionPrompted = false;
  let active = null, registration = null, workerPromise = null, timer = null;
  let toastKind = '', deliveryError = '', testing = false;
  const supported = () => window.isSecureContext !== false && typeof window.Notification === 'function';
  const enabled = () => supported() && window.Notification.permission === 'granted' && preference !== 'off';
  const focused = () => document.visibilityState === 'visible' && (document.hasFocus?.() ?? true);
  const remember = value => {
    preference = value;
    try { window.localStorage?.setItem(preferenceKey, value); } catch {}
  };
  function refresh() {
    const denied = supported() && window.Notification.permission === 'denied';
    button.disabled = prompting || !supported() || denied;
    testButton.disabled = testing || !enabled();
    testButton.textContent = testing ? '正在发送…' : '发送测试通知';
    button.textContent = denied ? '通知已被阻止' : enabled() ? '关闭浏览器通知' : '开启浏览器通知';
    if (!supported()) status.textContent = '当前浏览器或连接不支持系统通知，任务结束时仍会显示页内提示。';
    else if (prompting) status.textContent = '请在浏览器的通知申请中选择是否允许。';
    else if (deliveryError) status.textContent = deliveryError;
    else if (window.Notification.permission === 'denied') status.textContent = '通知已被浏览器阻止，请在此网站的通知权限中改为允许。';
    else if (enabled()) status.textContent = '已开启。页面在后台时，Agent 本轮运行结束后发送系统通知。';
    else status.textContent = '当前网站尚未开启通知。更换邀请的网站地址后，需要重新允许通知。';
  }
  function hideToast() {
    toast.hidden = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }
  function showToast(kind, persistent = false) {
    hideToast(); toastKind = kind; toast.hidden = false;
    toastText.textContent = kind === 'error' ? deliveryError : kind === 'permission-ended'
      ? 'Agent 本轮运行已结束；当前网站尚未开启浏览器通知。' : kind === 'permission'
      ? '任务较久？开启浏览器通知，运行结束后提醒你。'
      : 'Agent 本轮运行已结束。';
    toastAction.textContent = kind === 'error' ? '通知设置' : kind.startsWith('permission') ? '开启通知' : '查看结果';
    if (persistent) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (!toast.contains?.(document.activeElement)) hideToast();
    }, kind === 'permission' ? 12000 : 8000);
  }
  function clearSystemNotification() {
    try { active?.close(); } catch {}
    active = null;
    if (registration) registration.getNotifications({ tag }).then(list => list.forEach(n => n.close())).catch(() => {});
  }
  async function enable() {
    if (!supported() || prompting) return;
    if (enabled()) {
      remember('off'); epoch++; deliveryError = ''; clearSystemNotification(); refresh(); return;
    }
    if (window.Notification.permission === 'denied') { refresh(); return; }
    prompting = true; deliveryError = ''; refresh();
    try {
      // Manual enabling calls the API within the real click handler. Browsers
      // may silence the automatic admission attempt when it lacks that gesture.
      const permission = window.Notification.permission === 'granted'
        ? 'granted' : await window.Notification.requestPermission();
      if (permission === 'granted') { remember('on'); hideToast(); prepareWorker(); }
    } catch { deliveryError = '未能开启通知，请检查此网站的通知权限。'; }
    finally { prompting = false; refresh(); }
  }
  async function admitted() {
    refresh();
    // A new origin needs its own grant. Try once on confirmed admission, without
    // blocking connection/synchronization or retrying on every reconnect.
    if (admissionPrompted || prompting || !supported() || preference === 'off'
        || window.Notification.permission !== 'default') return;
    admissionPrompted = true; prompted = true;
    const generation = epoch;
    await enable();
    // Browsers can reject/silence a request without a user gesture. Keep an
    // explicit, real-click fallback instead of claiming permission was granted.
    if (generation === epoch && window.Notification.permission === 'default' && preference !== 'off') showToast('permission', true);
  }
  function worker() {
    if (!window.navigator?.serviceWorker) return Promise.reject(new Error('Notifications unavailable'));
    if (!workerPromise) {
      workerPromise = (async () => {
        // Registration/activation may be blocked. Never wait indefinitely.
        let timeout;
        try {
          registration = await Promise.race([
            window.navigator.serviceWorker.register('/notification-worker.js', { scope: '/' })
              .then(() => window.navigator.serviceWorker.ready),
            new Promise((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Notification worker timed out')), 5000); }),
          ]);
          return registration;
        } finally { if (timeout !== undefined) window.clearTimeout(timeout); }
      })().catch(error => { workerPromise = null; throw error; });
    }
    return workerPromise;
  }
  function prepareWorker() {
    if (enabled() && canReceive() && window.navigator?.serviceWorker) void worker().catch(() => {});
  }
  function failedDelivery(generation, test = false) {
    if (generation !== epoch || !enabled() || (!test && !canReceive())) return;
    deliveryError = '系统通知未能发送，请检查此网站的通知权限及系统中的 Chrome 通知设置。';
    refresh(); showToast('error');
  }
  async function deliver(generation, test = false) {
    // A test checks browser delivery only. Admission and host connectivity are
    // required for real run notifications and for viewing conversation results.
    const current = () => enabled() && (test || canReceive()) && (test || !focused()) && generation === epoch;
    if (!current()) return;
    try { active?.close(); } catch {}
    active = null;
    // Prefer a persistent notification on desktop too. The worker holds the
    // originating WindowClient id and can activate that exact browser tab.
    if (window.navigator?.serviceWorker) {
      try {
        const reg = await worker();
        if (!current()) return;
        await new Promise((resolve, reject) => {
          const channel = new window.MessageChannel();
          const timeout = window.setTimeout(() => { channel.port1.close(); reject(new Error('Notification delivery timed out')); }, 5000);
          channel.port1.onmessage = event => {
            window.clearTimeout(timeout); channel.port1.close();
            event.data?.ok === true ? resolve() : reject(new Error('Notification delivery failed'));
          };
          try { reg.active.postMessage({ type: 'co2-task-ended', pageToken, ...(test ? { test: true } : {}) }, [channel.port2]); }
          catch (error) { window.clearTimeout(timeout); channel.port1.close(); reject(error); }
        });
        if (!enabled() || (!test && !canReceive()) || generation !== epoch) clearSystemNotification();
        else { deliveryError = test ? '测试通知已交给浏览器。若未看到，请检查系统中的 Chrome 通知设置和专注模式。' : ''; refresh(); }
        return;
      } catch { /* A browser without worker notifications can still use its page notification API. */ }
    }
    if (!current()) return;
    try {
      const notification = new window.Notification('Codex Co²', {
        body: test ? '这是一条测试通知，点击返回对应的协作标签页。' : 'Agent 本轮运行已结束，点击查看结果。', tag, renotify: true,
      });
      active = notification;
      notification.onclick = () => {
        // Focusing the existing page does not grant access. Even a temporarily
        // disconnected tab should activate; viewing content still checks admission.
        try { window.focus(); } catch {}
        hideToast();
        if (canReceive()) onView();
        notification.close();
        if (active === notification) active = null;
      };
      notification.onshow = () => {
        if (generation !== epoch || !enabled() || (!test && !canReceive())) return;
        deliveryError = test ? '测试通知已交给浏览器。若未看到，请检查系统中的 Chrome 通知设置和专注模式。' : ''; refresh();
      };
      notification.onerror = () => failedDelivery(generation, test);
    } catch {
      failedDelivery(generation, test);
    }
  }
  function observe(value) {
    if (!canReceive() || value === 'offline') { reset(); return; }
    refresh();
    prepareWorker();
    const ended = previous === 'running' && value === 'idle';
    previous = value;
    if (ended) {
      showToast(supported() && window.Notification.permission === 'default' && preference !== 'off' ? 'permission-ended' : 'completion');
      void deliver(epoch);
    } else if (!prompted && supported() && window.Notification.permission === 'default' && preference !== 'off') {
      prompted = true; showToast('permission');
    }
  }
  function reset() {
    previous = null; epoch++; hideToast(); clearSystemNotification();
  }
  button.addEventListener('click', enable);
  testButton.addEventListener('click', async () => {
    if (!enabled() || testing) return;
    testing = true; deliveryError = ''; refresh();
    try { await deliver(epoch, true); }
    finally { testing = false; refresh(); }
  });
  toastAction.addEventListener('click', () => {
    if (toastKind.startsWith('permission')) void enable();
    else if (toastKind === 'error') { hideToast(); onSettings(); }
    else { hideToast(); if (canReceive()) onView(); }
  });
  byId('task-toast-dismiss').addEventListener('click', () => {
    if (toastKind.startsWith('permission')) remember('off');
    hideToast(); refresh();
  });
  // The browser may focus before dispatching notificationclick. Do not remove
  // the notification here and race its click handler. Reset/mute still clear it.
  window.addEventListener('focus', refresh);
  window.navigator?.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type !== 'co2-task-notification-click' || event.data.pageToken !== pageToken || !canReceive()) return;
    hideToast(); onView();
  });
  refresh();
  return { observe, reset, refresh, admitted };
};
