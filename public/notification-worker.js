// No fetch handler, caching, credentials, model connection or push subscription.
// A page asks for a generic test, or an admitted page asks for a run-end notice.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const { type, pageToken } = event.data ?? {};
  if (type !== 'co2-task-ended' || !/^[0-9a-f-]{36}$/.test(pageToken ?? '') || !event.source?.id) return;
  const source = event.source;
  if (new URL(source.url).origin !== self.location.origin) return;
  event.waitUntil(self.registration.showNotification('Codex Co²', {
    body: event.data.test === true ? '这是一条测试通知，点击返回对应的协作标签页。' : 'Agent 本轮运行已结束，点击查看结果。', tag: `co2-task-${pageToken}`, renotify: true,
    data: { clientId: source.id, pageToken },
  }).then(() => event.ports[0]?.postMessage({ ok: true }), () => event.ports[0]?.postMessage({ ok: false })));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { clientId, pageToken } = event.notification.data ?? {};
  if (typeof clientId !== 'string' || !/^[0-9a-f-]{36}$/.test(pageToken ?? '')) return;
  event.waitUntil((async () => {
    const client = await self.clients.get(clientId);
    // Never open a replacement page or carry invitation credentials in a URL.
    if (!client || new URL(client.url).origin !== self.location.origin) return;
    // Queue the result selection before focus: some browsers resume the page
    // only after activation, and a focus failure must not discard the selection.
    client.postMessage({ type: 'co2-task-notification-click', pageToken });
    try { await client.focus(); } catch { /* The original tab remains the only target. */ }
  })());
});
