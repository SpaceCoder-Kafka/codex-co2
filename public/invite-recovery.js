// This channel can request a new invitation, never read or operate a conversation.
// Receipts identify one request; invitation credentials remain in page memory.
(() => {
  const recordsKey = 'co2.invitation-requests';
  const pointerKey = 'co2.invitation-request';
  const DAY = 86400000;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const validRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const validName = value => typeof value === 'string' && value.trim() && [...value].length <= 40 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  const validRecord = value => value && validId(value.originalRoomId) && validRequestId(value.requestId)
    && validToken(value.receiptToken) && validToken(value.visitorToken) && validName(value.name)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + DAY;
  const records = () => {
    try {
      const saved = JSON.parse(window.localStorage?.getItem(recordsKey) || '[]');
      return Array.isArray(saved) ? saved.filter(validRecord).slice(0, 50).map(value => ({
        originalRoomId: value.originalRoomId, requestId: value.requestId, receiptToken: value.receiptToken,
        visitorToken: value.visitorToken, name: value.name, expiresAt: value.expiresAt, confirmed: value.confirmed === true,
      })) : [];
    } catch { return []; }
  };
  const invitationFrom = value => {
    try {
      const url = new URL(value), current = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.slice(1));
      if (url.origin !== current.origin || url.username || url.password || url.pathname !== '/' || url.search
        || [...hash.keys()].some(key => !['room', 'invite', 'scope'].includes(key))
        || hash.getAll('room').length !== 1 || hash.getAll('invite').length !== 1 || hash.getAll('scope').length > 1
        || !validId(hash.get('room')) || !validToken(hash.get('invite'))
        || (hash.has('scope') && !validId(hash.get('scope')))) return null;
      return { roomId: hash.get('room'), inviteToken: hash.get('invite'), scopeId: hash.get('scope') || '' };
    } catch { return null; }
  };

  window.createInviteRecovery = ({ invitation, getName, newToken, newRequestId, onRecoverable, onUnavailable, onApproved }) => {
    const ids = ['invite-recovery-panel', 'invite-recovery-title', 'invite-recovery-description', 'invite-recovery-form',
      'invite-recovery-name', 'invite-recovery-button', 'invite-recovery-feedback', 'invite-recovery-storage'];
    const ui = Object.fromEntries(ids.map(id => [id.replace('invite-recovery-', ''), document.getElementById(id)]));
    if (Object.values(ui).some(element => !element)) return null;
    let original = { ...invitation }, nextInvitation = null;
    let record = null, socket = null, timer = null, retryTimer = null, heartbeat = null;
    let retryCount = 0, closed = false, suspended = false, handedOff = false, blocked = false;
    let persistent = true, supported = false, recoveryExpiresAt = 0, queuedRequest = false, approved = null;
    let lastActivity = 0;
    const canVerify = () => validId(original.roomId) && validToken(original.inviteToken);
    const persist = () => {
      if (!record) return;
      try {
        const saved = [...(validRecord(record) ? [record] : []), ...records().filter(old => old.originalRoomId !== record.originalRoomId)].slice(0, 50);
        window.localStorage?.setItem(recordsKey, JSON.stringify(saved));
        persistent = !validRecord(record) || records().some(old => old.requestId === record.requestId);
      } catch { persistent = false; }
      try { window.sessionStorage?.setItem(pointerKey, JSON.stringify({ originalRoomId: record.originalRoomId, requestId: record.requestId })); } catch {}
      ui.storage.hidden = persistent;
      ui.storage.textContent = '浏览器未能保存此申请。请保持本页打开，关闭后无法找回申请。';
    };
    const stop = () => {
      window.clearTimeout(timer); timer = null;
      window.clearTimeout(retryTimer); retryTimer = null;
      window.clearInterval(heartbeat); heartbeat = null;
      const previous = socket; socket = null; previous?.close();
    };
    const send = message => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
    };
    const panel = (title, description, { form = false, feedback = '' } = {}) => {
      ui.panel.hidden = false; ui.title.textContent = title; ui.description.textContent = description;
      ui.form.hidden = !form; ui.button.disabled = !form; ui.feedback.textContent = feedback;
      ui.name.disabled = Boolean(record);
      ui.storage.hidden = !record || persistent;
    };
    const transient = () => {
      if (closed || suspended || handedOff || blocked) return;
      if (record) panel('暂时无法查询申请', '连接恢复后会继续查询，不会重复提交申请。', {
        form: !record.confirmed && canVerify(), feedback: record.confirmed ? '申请结果尚未确认。' : '尚未确认申请已送达，请检查连接后重试。',
      });
      else if (supported) panel('暂时无法联系分享者', '请检查网络或联系分享者确认 Co² 仍在运行。');
      if (record && retryCount < 8 && retryTimer === null) {
        retryTimer = window.setTimeout(() => { retryTimer = null; connect(); }, Math.min(1000 * 2 ** retryCount++, 30000));
      }
    };
    const deliver = () => {
      if (!approved || handedOff || blocked || document.visibilityState === 'hidden') return;
      if (!record || record.expiresAt <= Date.now()) { approved = null; panel('申请已到期', '请重新打开原邀请，检查是否还能申请恢复。'); return; }
      handedOff = true; stop(); ui.panel.hidden = true;
      nextInvitation = { ...approved };
      onApproved(approved, { ...record }); approved = null;
    };
    const result = message => {
      if (!record || message.requestId !== record.requestId) return;
      if (Number.isSafeInteger(message.expiresAt) && message.expiresAt > Date.now() && message.expiresAt <= Date.now() + DAY) {
        record.expiresAt = Math.min(record.expiresAt, message.expiresAt);
      }
      switch (message.status) {
        case 'pending':
        case 'processing':
        case 'failed':
          record.confirmed = true; persist();
          panel(message.status === 'failed' ? '等待分享者重试' : '等待分享者处理', message.status === 'failed'
            ? '分享者暂未能恢复共享，需要在管理页检查后重试。'
            : '分享者同意后将更新邀请，并允许本次申请加入。', {
            feedback: persistent ? '申请已送达。稍后可用同一浏览器重新打开原邀请查看结果。' : '申请已送达。请保持本页打开。',
          });
          break;
        case 'approved': {
          const next = invitationFrom(message.inviteUrl);
          if (!next || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= Date.now() || message.expiresAt > Date.now() + DAY) {
            panel('暂时无法更新邀请', '返回的邀请不可用，请联系分享者。'); stop(); return;
          }
          record.confirmed = true; persist(); approved = next;
          panel('邀请已更新', '分享者已同意。返回本页后将自动连接，完成同步后即可协作。');
          deliver(); break;
        }
        case 'rejected':
          record.confirmed = true; persist(); blocked = true; stop();
          panel('申请未获同意', '分享者拒绝了本次恢复申请。请联系分享者。'); break;
        case 'expired':
          record.expiresAt = 0; persist(); blocked = true; stop();
          panel('申请已到期', '请重新打开原邀请，检查是否还能申请恢复。'); break;
        case 'unavailable':
          stop();
          if (!record.confirmed && canVerify()) {
            panel(message.code === 'rate-limited' || message.code === 'capacity-reached' ? '暂时无法提交申请' : '尚未确认申请',
              '请稍后重试；重试使用同一申请，不会重复创建。', { form: true, feedback: '尚未确认申请已送达。' });
            ui.button.textContent = '重试提交';
          } else {
            blocked = true;
            panel('申请已不可用', '服务可能已退出、入口已改变，或共享已被停止。请联系分享者获取邀请。');
          }
          break;
      }
    };
    const receive = message => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'recovery-request') { result(message); return; }
      if (message.type !== 'recovery-status' || record) return;
      supported = true;
      if (message.status === 'recoverable' && ['expired', 'interrupted', 'paused'].includes(message.reason)
        && Number.isSafeInteger(message.recoveryExpiresAt) && message.recoveryExpiresAt > Date.now()) {
        recoveryExpiresAt = message.recoveryExpiresAt;
        onRecoverable(message.reason);
        ui.name.value = getName() || ui.name.value;
        panel(message.reason === 'expired' ? '邀请已到期' : '共享因故中断', '可以请求分享者恢复邀请。同意后，你将直接加入这条会话。', { form: true });
        ui.button.textContent = '请求恢复邀请';
      } else if (message.status === 'unavailable') {
        onUnavailable?.();
        panel('邀请不可恢复', '请联系分享者发送新邀请。原入口必须仍可访问，才能申请恢复。'); stop();
      } else {
        // Healthy and temporarily disconnected shares retain their normal join/reconnect behavior.
        ui.panel.hidden = true; stop();
      }
    };
    function connect() {
      if (closed || suspended || handedOff || blocked || (!record && !canVerify())) return;
      stop();
      const url = new URL('/recovery', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      let current;
      try { current = new WebSocket(url); socket = current; } catch { transient(); return; }
      timer = window.setTimeout(() => { if (socket === current) { stop(); transient(); } }, 15000);
      current.addEventListener('open', () => {
        if (socket !== current) return;
        window.clearTimeout(timer); timer = null; lastActivity = Date.now();
        if (queuedRequest && record && canVerify()) {
          queuedRequest = false;
          send({ type: 'request', roomId: original.roomId, inviteToken: original.inviteToken,
            requestId: record.requestId, receiptToken: record.receiptToken, visitorToken: record.visitorToken, name: record.name });
        } else if (record) send({ type: 'watch', requestId: record.requestId, receiptToken: record.receiptToken });
        else send({ type: 'status', roomId: original.roomId, inviteToken: original.inviteToken });
        heartbeat = window.setInterval(() => {
          if (socket !== current) return;
          if (Date.now() - lastActivity > 75000) { stop(); transient(); }
          else send({ type: 'ping' });
        }, 25000);
      });
      current.addEventListener('message', event => {
        if (socket !== current || typeof event.data !== 'string') return;
        lastActivity = Date.now(); retryCount = 0;
        try { receive(JSON.parse(event.data)); } catch { /* Invalid replies cannot grant local access. */ }
      });
      current.addEventListener('error', () => { if (socket === current && record) ui.feedback.textContent = '连接遇到问题，申请结果尚未确认。'; });
      current.addEventListener('close', () => { if (socket !== current) return; stop(); transient(); });
    }
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      if (blocked || handedOff || ui.button.disabled || !canVerify()) return;
      const name = ui.name.value.trim();
      if (!validName(name)) { ui.feedback.textContent = '请填写 1–40 个字符的显示名称。'; ui.name.focus(); return; }
      if (!record) {
        if (recoveryExpiresAt <= Date.now()) { panel('恢复窗口已结束', '请联系分享者发送新的邀请。'); return; }
        record = { originalRoomId: original.roomId, requestId: newRequestId(), receiptToken: newToken(), visitorToken: newToken(),
          name, expiresAt: Math.min(Date.now() + DAY, recoveryExpiresAt), confirmed: false };
      }
      persist(); queuedRequest = true;
      panel('正在提交申请', '正在联系分享者的 Co² 服务，尚未确认送达。'); connect();
    });
    try {
      let pointer;
      try { pointer = JSON.parse(window.sessionStorage?.getItem(pointerKey) || 'null'); } catch {}
      record = records().find(saved => canVerify() ? saved.originalRoomId === original.roomId
        : saved.originalRoomId === pointer?.originalRoomId && saved.requestId === pointer?.requestId) || null;
      if (record) { ui.name.value = record.name; persist(); panel('正在查询申请', '正在读取此前申请的处理结果。'); }
    } catch {}
    return {
      get hasRequest() { return Boolean(record); },
      start() { connect(); },
      probe() {
        if (handedOff && nextInvitation && !blocked) {
          original = nextInvitation; nextInvitation = null; handedOff = false;
          record = null; supported = false; recoveryExpiresAt = 0;
        }
        if (!record && !handedOff && !blocked) connect();
      },
      suspend() { suspended = true; stop(); },
      resume() { suspended = false; if (record && !handedOff && !blocked) connect(); },
      visible() { deliver(); if (record && !handedOff && !socket && !blocked) connect(); },
      revoke() {
        blocked = true; stop(); approved = null; ui.panel.hidden = true;
        if (record) { record.confirmed = true; record.expiresAt = 0; persist(); }
        original.inviteToken = '';
      },
      close() { closed = true; stop(); },
    };
  };
})();
