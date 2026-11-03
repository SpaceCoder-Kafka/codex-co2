// Invitation credentials stay in this module's memory for the life of this page.
const fragment = new URLSearchParams(window.location.hash.slice(1));
let roomId = fragment.get('room') || '';
let inviteToken = fragment.get('invite') || '';
const validScope = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
let scopeId = validScope(fragment.get('scope')) ? fragment.get('scope') : '';
fragment.delete('room');
fragment.delete('invite');
window.history.replaceState(null, '', window.location.pathname);

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'connection-status', 'connection-label', 'notice', 'thread-title', 'agent-status',
  'history-note', 'conversation', 'new-replies-button', 'empty-state', 'empty-title', 'empty-description',
  'messages', 'sync-label', 'join-panel', 'join-form', 'display-name', 'join-button',
  'join-feedback', 'member-panel', 'member-title', 'member-name', 'member-avatar',
  'member-description', 'reconnect-button', 'proposal-form', 'proposal-text',
  'character-count', 'send-button', 'proposal-feedback', 'proposals-panel',
  'proposal-count', 'proposals', 'proposal-help',
  'recovery-input', 'recovery-panel', 'recovery-note', 'recovery-code', 'copy-recovery',
  'identity-notice', 'download-recovery', 'import-recovery',
  'collaboration-toggle', 'collaboration-panel', 'collaboration-navigation',
  'collaboration-menu', 'collaboration-proposals', 'collaboration-backup', 'collaboration-help',
  'collaboration-back', 'collaboration-close', 'open-proposals', 'open-backup', 'open-help',
  'submission-summary', 'proposals-empty', 'backup-summary', 'backup-name', 'backup-unavailable',
  'identity-warning', 'open-backup-warning', 'manual-recovery', 'recovery-feedback', 'send-mode',
  'attach-button', 'attachment-input', 'compose-attachments',
].map((id) => [id, byId(id)]));

const proposals = new Map();
const selectedUploads = [], uploadWaiters = new Map();
let uploadEnabled = false, uploadGeneration = 0, uploadRunning = false;
const uploadLimit = 32 * 1024 * 1024, uploadChunkBytes = 30 * 1024;
let documentThumbnailCount = 0;
function isValidInvitation(room, token) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(room || '')
    && /^[A-Za-z0-9_-]{32,128}$/.test(token || '');
}
let validInvitation = isValidInvitation(roomId, inviteToken);
let invitationRecovery = null;
let invitationReloadPending = false;
let socket = null;
let connectTimer = null;
let admitted = false;
let hostOnline = false;
let terminal = false;
let connecting = false;
let reconnectTimer = null, reconnectAttempts = 0, heartbeatTimer = null, lastActivity = 0;
const draftKey = 'co2.unsent-draft';
const visitorKey = 'co2.visitor-identity';
const identitiesKey = 'co2.visitor-identities';
const validRecovery = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const newVisitorToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let visitorToken = newVisitorToken(), savedVisitor = false;
let recoveryRecord = null;
let displayName = '';
let lastRevision = null;
let receivedSnapshot = false;
let policyKnown = false;
let requireApproval = true; // Until the host reports its policy (compatible with older hosts).
let assistantTexts = new Map();
let contentCapabilities = [], markdownDisposers = [];
const messageFolds = new Map(), workFolds = new Map();
let fitMessageFolds = [], presentationSerial = 0;
const images = window.createThreadImages?.({ send, canRead: () => canPropose(), capabilities: () => contentCapabilities });
function clearRichText() { for (const dispose of markdownDisposers) dispose?.(); markdownDisposers = []; fitMessageFolds = []; }
function enhanceRichText(node) {
  if (!node.querySelector?.('[data-math], [data-mermaid], code[class]')) return;
  let live = true, cleanup; markdownDisposers.push(() => { live = false; cleanup?.(); });
  const load = window.co2PreviewLoader || (() => import('/vendor/previews.mjs'));
  Promise.resolve().then(load).then(api => live && api.enhanceMarkdown(node, { isCurrent: () => live && canPropose() }))
    .then(result => { cleanup = typeof result === 'function' ? result : result?.dispose; if (!live) cleanup?.(); }).catch(() => {});
}
const taskNotifications = window.createTaskNotifications?.({
  canReceive: () => canPropose(),
  onView: () => { closeCollaboration(false); viewLatestReply(); ui.conversation.focus(); },
  onSettings: () => showCollaboration('help'),
});
// The collaboration panel only changes presentation, never admission or policy.
function showCollaboration(view = 'menu') {
  const panel = ui['collaboration-panel'];
  panel.hidden = false;
  panel.dataset.view = view;
  panel.scrollTop = 0;
  if (view !== 'backup') {
    ui['manual-recovery'].open = false;
    ui['recovery-code'].type = 'password';
  }
  ui['collaboration-toggle'].setAttribute('aria-expanded', 'true');
  ui['collaboration-navigation'].hidden = view === 'menu';
  for (const name of ['menu', 'proposals', 'backup', 'help']) {
    ui[`collaboration-${name}`].hidden = name !== view;
  }
  (view === 'menu' ? ui['open-proposals'] : ui['collaboration-back']).focus();
}
function closeCollaboration(restoreFocus = true) {
  if (ui['collaboration-panel'].hidden) return;
  ui['collaboration-panel'].hidden = true;
  ui['collaboration-toggle'].setAttribute('aria-expanded', 'false');
  // Never leave a revealed fallback credential around on the next visit.
  ui['manual-recovery'].open = false;
  ui['recovery-code'].type = 'password';
  if (restoreFocus) ui['collaboration-toggle'].focus();
}
function refreshCollaboration() {
  const available = Boolean(validIdentity(recoveryRecord));
  ui['open-backup'].disabled = !available;
  ui['backup-unavailable'].hidden = available;
  ui['recovery-panel'].hidden = !available;
  ui['backup-name'].textContent = displayName || '尚未加入';
  ui['backup-summary'].textContent = available
    ? (ui['identity-warning'].hidden ? '此浏览器已保存你的身份' : '请下载恢复文件，避免身份丢失')
    : '当前没有可用的身份备份';
  ui['send-mode'].textContent = policyKnown ? (requireApproval ? '需确认' : '直接发送') : '同步中';
}
function resizeComposer() {
  const input = ui['proposal-text'];
  input.style.height = 'auto';
  input.style.height = `${Math.min(160, Math.max(48, input.scrollHeight))}px`;
  input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden';
  ui['character-count'].hidden = input.value.length < 7200;
}
function proposalFeedback(message, warning = false) {
  ui['proposal-feedback'].textContent = message;
  ui['proposal-feedback'].dataset.kind = warning ? 'warning' : 'info';
}

function validIdentity(saved) {
  return saved && validRecovery(saved.token) && typeof saved.name === 'string'
    && saved.name.trim() && [...saved.name].length <= 40 && !/[\u0000-\u001f\u007f-\u009f]/u.test(saved.name)
    && saved.approved === true && Number.isSafeInteger(saved.expiresAt) && saved.expiresAt > Date.now()
    && saved.expiresAt <= Date.now() + 86400000 && validScope(saved.roomId)
    && (saved.scopeId === '' || validScope(saved.scopeId));
}
function sameIdentity(saved) {
  return scopeId ? saved.scopeId === scopeId : saved.roomId === roomId;
}
function storedIdentities() {
  try {
    const records = JSON.parse(window.localStorage?.getItem(identitiesKey) || '[]');
    return Array.isArray(records) ? records.filter(validIdentity).slice(0, 50) : [];
  } catch { return []; }
}
function rememberIdentity(record) {
  let persistent = false;
  try {
    const records = [record, ...storedIdentities().filter(old => record.scopeId
      ? old.scopeId !== record.scopeId : old.roomId !== record.roomId)].slice(0, 50);
    window.localStorage?.setItem(identitiesKey, JSON.stringify(records));
    persistent = storedIdentities().some(old => old.token === record.token && old.roomId === record.roomId);
  } catch { /* Private browsing and full storage must not block admission. */ }
  try { window.sessionStorage?.setItem(visitorKey, JSON.stringify(record)); } catch { /* Keep the in-memory backup available. */ }
  return persistent;
}
function forgetIdentity() {
  try { window.localStorage?.setItem(identitiesKey, JSON.stringify(storedIdentities().filter(old => !sameIdentity(old)))); } catch {}
  try {
    const saved = JSON.parse(window.sessionStorage?.getItem(visitorKey) || 'null');
    if (saved && sameIdentity(saved)) window.sessionStorage.removeItem(visitorKey);
  } catch {}
  recoveryRecord = null;
  ui['recovery-code'].value = '';
  ui['recovery-panel'].hidden = true;
  ui['identity-notice'].hidden = true;
  ui['identity-warning'].hidden = true;
  ui['recovery-feedback'].textContent = '';
  ui['manual-recovery'].open = false;
  ui['recovery-code'].type = 'password';
}
try {
  let tab;
  try { tab = JSON.parse(window.sessionStorage?.getItem(visitorKey) || 'null'); } catch {}
  const saved = storedIdentities().find(sameIdentity)
    || (tab?.roomId === roomId && validRecovery(tab.token) && typeof tab.name === 'string'
      && tab.name.trim() && [...tab.name].length <= 40 && !/[\u0000-\u001f\u007f-\u009f]/u.test(tab.name)
      && tab.approved === true && (tab.expiresAt === undefined || validIdentity(tab)) ? tab : null);
  if (validInvitation && saved) {
    visitorToken = saved.token; displayName = saved.name; savedVisitor = true;
    ui['display-name'].value = displayName;
    ui['recovery-input'].value = visitorToken;
    ui['join-feedback'].textContent = '已找到此会话的身份记录，正在自动恢复连接…';
  }
} catch { /* Missing storage leaves joining and backup-file recovery available. */ }
// Only the author's unsent text, scoped to this tab and room. Never store an
// invitation credential, received transcript or a submitted message for replay.
try {
  const saved = JSON.parse(window.sessionStorage?.getItem(draftKey) || 'null');
  if (saved?.roomId === roomId && validInvitation && typeof saved.text === 'string' && saved.text.length <= 8000) {
    ui['proposal-text'].value = saved.text;
    ui['character-count'].textContent = `${saved.text.length.toLocaleString('en-US')} / 8,000`;
  }
} catch { /* Private mode or invalid tab storage must not block joining. */ }
function saveDraft() {
  try {
    const text = ui['proposal-text'].value;
    if (text && text.length <= 8000 && roomId) window.sessionStorage?.setItem(draftKey, JSON.stringify({ roomId, text }));
    else window.sessionStorage?.removeItem(draftKey);
  } catch { /* The in-memory composer still retains the unsent draft. */ }
}
function cancelReconnect() {
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
function scheduleReconnect() {
  if (terminal || invitationReloadPending || !displayName || reconnectTimer !== null) return;
  if (reconnectAttempts >= 8) {
    notice('自动重连未成功。请检查网络，或让分享者确认邀请是否仍有效。草稿已保留。', 'warning'); return;
  }
  const wait = Math.min(1000 * 2 ** reconnectAttempts++, 30000);
  setStatus('连接中断，等待重连', 'warning');
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, wait);
}
function stopHeartbeat() {
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}
function checkHeartbeat() {
  if (terminal || socket?.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastActivity > 75000) { socket.close(); return; }
  send({ type: 'ping' });
}

function nearConversationBottom(distance = 100) {
  return ui.conversation.scrollHeight - ui.conversation.scrollTop
    - ui.conversation.clientHeight < distance;
}

function viewLatestReply() {
  ui.conversation.scrollTop = ui.conversation.scrollHeight;
  ui['new-replies-button'].hidden = true;
}

function setStatus(label, state = 'neutral') {
  ui['connection-label'].textContent = label;
  ui['connection-status'].dataset.state = state;
}

function notice(message, kind = 'info') {
  ui.notice.textContent = message;
  ui.notice.dataset.kind = kind;
  ui.notice.hidden = !message;
}

function emptyState(title, description) {
  ui['empty-title'].textContent = title;
  ui['empty-description'].textContent = description;
}

function canPropose() {
  return admitted && hostOnline && !terminal && socket?.readyState === WebSocket.OPEN;
}

function updateControls() {
  refreshCollaboration();
  ui['proposal-text'].disabled = !canPropose();
  ui['send-button'].disabled = !canPropose() || (!ui['proposal-text'].value.trim() && !selectedUploads.length)
    || selectedUploads.some(a => a.status !== 'ready');
  ui['attach-button'].disabled = !canPropose() || !uploadEnabled || selectedUploads.length >= 8;
  ui['attach-button'].title = uploadEnabled ? '添加文件，也可粘贴或拖放；单个最大 32 MiB' : '当前共享暂不支持发送附件';
  ui['join-button'].disabled = !validInvitation || terminal || connecting || admitted;
  ui['display-name'].disabled = connecting || admitted || terminal;
  ui['recovery-input'].disabled = connecting || admitted || terminal;
  ui['reconnect-button'].hidden = terminal || connecting || !displayName
    || socket?.readyState === WebSocket.OPEN;
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function clearConnectionTimer() {
  if (connectTimer !== null) window.clearTimeout(connectTimer);
  connectTimer = null;
}

function markPendingUnknown() {
  pauseUploads();
  for (const proposal of proposals.values()) {
    if (['pending', 'processing'].includes(proposal.status)) {
      proposal.status = 'unknown';
      proposal.message = '连接已中断，尚未确认提交结果。不会自动重发。';
    }
  }
  renderProposals();
}

function detachSocket() {
  pauseUploads();
  clearConnectionTimer();
  stopHeartbeat();
  const previous = socket;
  socket = null;
  if (previous) previous.close();
}

function disconnect(message) {
  taskNotifications?.reset();
  connecting = false;
  admitted = false;
  hostOnline = false;
  images?.pause(); clearRichText();
  ui['agent-status'].hidden = true;
  ui['sync-label'].textContent = receivedSnapshot ? '已暂停 · 显示上次同步内容' : '尚未同步';
  setStatus('连接已断开', 'warning');
  ui['member-title'].textContent = '连接已断开';
  notice(message || '连接已断开，正在尝试恢复原准入；凭据失效时需分享者确认。已有消息不会自动重发。', 'warning');
  ui['member-description'].textContent = '重连时核对个人恢复凭据，未获准的访问仍需分享者确认。';
  markPendingUnknown();
  updateControls();
  scheduleReconnect();
}

function renderUploads() {
  const list = ui['compose-attachments'];
  list.hidden = selectedUploads.length === 0;
  const rows = [];
  for (const item of selectedUploads) {
    if (!item.row) createUploadCard(item);
    const { row, statusNode: status } = item;
    row.dataset.status = item.status;
    status.textContent = item.status === 'ready' ? '已上传' : item.status === 'failed' ? '上传失败，请重新添加'
      : item.status === 'queued' ? '等待上传' : `上传中 ${Math.floor(item.received / (item.file.size || 1) * 100)}%`;
    rows.push(row);
  }
  if (list.children.length !== rows.length || rows.some((row, index) => list.children[index] !== row)) list.replaceChildren(...rows);
}
function createUploadCard(item) {
  const ext = item.file.name.split('.').at(-1).toLowerCase();
  const family = ['doc', 'docx'].includes(ext) ? 'word' : ['xls', 'xlsx', 'csv', 'tsv'].includes(ext) ? 'spreadsheet'
    : ['ppt', 'pptx'].includes(ext) ? 'presentation' : ext === 'pdf' ? 'pdf'
      : ['mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext) ? 'media' : 'text';
  const row = document.createElement('div'); row.className = 'compose-attachment'; row.title = item.file.name;
  row.dataset.preview = 'none'; row.dataset.family = family;
  const preview = document.createElement('div'); preview.className = 'compose-attachment-preview'; preview.setAttribute('aria-hidden', 'true');
  const footer = document.createElement('div'); footer.className = 'compose-attachment-footer';
  const icon = document.createElement('span'); icon.className = 'compose-file-icon'; icon.setAttribute('aria-hidden', 'true');
  icon.textContent = /^[a-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : 'FILE';
  const name = document.createElement('span'); name.className = 'compose-attachment-name'; name.textContent = item.file.name;
  const status = document.createElement('span'); status.className = 'compose-attachment-status';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'compose-attachment-remove';
  remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${item.file.name}`);
  remove.addEventListener('click', () => {
    const index = selectedUploads.indexOf(item); if (index < 0) return;
    selectedUploads.splice(index, 1); disposeUploadPreview(item);
    if (canPropose()) send({ type: 'upload-cancel', uploadId: item.id });
    uploadWaiters.get(item.id)?.reject(new Error('已移除'));
    renderUploads(); updateControls();
  });
  footer.append(icon, name); row.append(preview, footer, status, remove);
  Object.assign(item, { row, statusNode: status, preview, previewCleanups: [] });
  void prepareUploadPreview(item, ext);
}
function disposeUploadPreview(item) {
  item.previewDisposed = true;
  for (const cleanup of item.previewCleanups ?? []) { try { cleanup(); } catch { /* Thumbnail cleanup cannot change upload authorization. */ } }
  item.previewCleanups = [];
  item.preview?.replaceChildren();
  if (item.row) item.row.dataset.preview = 'none';
}
async function prepareUploadPreview(item, ext) {
  const current = () => !item.previewDisposed && selectedUploads.includes(item);
  const fallback = () => { if (current()) { item.preview.replaceChildren(); item.row.dataset.preview = 'none'; } };
  try {
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'mp4', 'mov', 'webm'].includes(ext)) {
      const video = ['mp4', 'mov', 'webm'].includes(ext), media = document.createElement(video ? 'video' : 'img');
      const url = URL.createObjectURL(item.file); item.previewCleanups.push(() => { if (video) { media.pause(); media.removeAttribute('src'); media.load(); } URL.revokeObjectURL(url); });
      media.addEventListener('error', fallback);
      media.addEventListener(video ? 'loadeddata' : 'load', () => { if (current()) item.row.dataset.preview = video ? 'video' : 'image'; });
      if (video) { media.muted = true; media.playsInline = true; media.preload = 'metadata'; }
      else media.alt = item.file.name;
      item.preview.append(media); media.src = url;
      // Keep the preview in layout while the browser decodes its first frame.
      item.row.dataset.preview = video ? 'video' : 'image';
      return;
    }
    if (['pdf', 'docx', 'pptx', 'xlsx'].includes(ext) && item.file.size <= 4*1024*1024 && documentThumbnailCount < 2) {
      documentThumbnailCount++;
      item.previewCleanups.push(() => { documentThumbnailCount--; });
      const bytes = new Uint8Array(await item.file.arrayBuffer()); if (!current()) return;
      const load = window.co2PreviewLoader || (() => import('/vendor/previews.mjs')), api = await load(); if (!current()) return;
      const box = document.createElement('div'); box.className = 'file-rich-preview compose-attachment-document'; item.preview.append(box);
      const result = await api.mountPreview({ container: box, bytes, name: item.file.name, kind: ext, isCurrent: current });
      if (!current()) { result?.dispose?.(); return; }
      item.previewCleanups.push(() => result?.dispose?.()); item.row.dataset.preview = 'document'; return;
    }
    if (['txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'swift', 'dart', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'toml', 'diff', 'patch'].includes(ext)) {
      const bytes = await item.file.slice(0, 4096).arrayBuffer(); if (!current()) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.trim() || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) return;
      const pre = document.createElement('pre'); pre.className = 'compose-attachment-text'; pre.textContent = text;
      item.preview.append(pre); item.row.dataset.preview = 'text';
    }
  } catch { fallback(); disposeUploadPreview(item); }
}
function pauseUploads() {
  uploadEnabled = false; uploadGeneration++;
  for (const waiter of uploadWaiters.values()) waiter.reject(new Error('连接已中断'));
  for (const item of selectedUploads) { item.status = 'failed'; disposeUploadPreview(item); }
  renderUploads();
}
function uploadRequest(item, message, expected) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('上传超时')), 30000);
    function finish(error, payload) {
      window.clearTimeout(timer); uploadWaiters.delete(item.id);
      error ? reject(error) : resolve(payload);
    }
    uploadWaiters.set(item.id, { expected, resolve: payload => finish(null, payload), reject: error => finish(error) });
    if (!send(message)) finish(new Error('无法上传'));
  });
}
async function drainUploads() {
  if (uploadRunning) return;
  uploadRunning = true;
  try {
    for (;;) {
      const item = selectedUploads.find(a => a.status === 'queued');
      if (!item || !canPropose() || !uploadEnabled) break;
      const generation = uploadGeneration;
      const current = () => generation === uploadGeneration && selectedUploads.includes(item) && canPropose() && uploadEnabled;
      item.status = 'uploading'; renderUploads(); updateControls();
      try {
        await uploadRequest(item, { type: 'upload-start', uploadId: item.id, name: item.file.name, size: item.file.size }, { status: 'uploading', index: 0 });
        let index = 0;
        for (let offset = 0; offset < item.file.size; offset += uploadChunkBytes) {
          if (!current()) throw new Error('上传已中止');
          const bytes = new Uint8Array(await item.file.slice(offset, offset + uploadChunkBytes).arrayBuffer());
          if (!current()) throw new Error('上传已中止');
          const data = btoa(String.fromCharCode(...bytes));
          await uploadRequest(item, { type: 'upload-chunk', uploadId: item.id, index, data }, { status: 'uploading', index: ++index });
          item.received = offset + bytes.length; renderUploads();
        }
        if (!current()) throw new Error('上传已中止');
        await uploadRequest(item, { type: 'upload-finish', uploadId: item.id }, { status: 'ready', index });
        if (current()) item.status = 'ready';
      } catch (error) {
        item.status = 'failed';
        if (current()) { send({ type: 'upload-cancel', uploadId: item.id }); proposalFeedback(`附件上传未完成：${error.message || '请移除后重新添加。'}`, true); }
      }
      renderUploads(); updateControls();
    }
  } finally { uploadRunning = false; }
}
function addUploadFiles(files) {
  if (!canPropose() || !uploadEnabled) return;
  for (const file of Array.from(files ?? [])) {
    if (selectedUploads.length >= 8 || file.size > uploadLimit
      || selectedUploads.reduce((n,a) => n+a.file.size, 0)+file.size > 64*1024*1024
      || file.name.length > 240 || /[\x00-\x1f\x7f-\x9f/\\]/.test(file.name)) {
      proposalFeedback('每条消息最多 8 个文件，单个文件最多 32 MiB，合计最多 64 MiB。', true); continue;
    }
    selectedUploads.push({ id: requestId(), file, status: 'queued', received: 0 });
  }
  renderUploads(); updateControls(); void drainUploads();
}

function setTerminal(message, label, { preserveIdentity = false } = {}) {
  taskNotifications?.reset();
  if (!preserveIdentity) forgetIdentity();
  terminal = true;
  cancelReconnect(); stopHeartbeat();
  connecting = false;
  admitted = false;
  hostOnline = false;
  inviteToken = '';
  roomId = '';
  detachSocket();
  ui.messages.replaceChildren();
  images?.clear(); clearRichText(); contentCapabilities = [];
  assistantTexts.clear();
  messageFolds.clear(); workFolds.clear();
  ui['new-replies-button'].hidden = true;
  ui['empty-state'].hidden = false;
  ui['thread-title'].textContent = '会话访问已结束';
  ui['agent-status'].hidden = true;
  ui['history-note'].hidden = true;
  ui['sync-label'].textContent = '访问已结束';
  emptyState(label, message);
  setStatus(label, 'warning');
  ui['member-title'].textContent = label;
  notice(message, 'warning');
  ui['member-description'].textContent = message;
  markPendingUnknown();
  proposalFeedback('访问已结束，旧建议不会自动重发。', true);
  updateControls();
}

function useRecoveredInvitation(next, request) {
  if (invitationReloadPending) return;
  cancelReconnect(); detachSocket(); taskNotifications?.reset();
  forgetIdentity();
  roomId = next.roomId; inviteToken = next.inviteToken; scopeId = next.scopeId;
  validInvitation = isValidInvitation(roomId, inviteToken);
  terminal = false; connecting = false; admitted = false; hostOnline = false;
  savedVisitor = false; visitorToken = request.visitorToken; displayName = request.name;
  lastRevision = null; receivedSnapshot = false; policyKnown = false; requireApproval = true;
  reconnectAttempts = 0;
  // A new grant starts a fresh conversation connection, never a replay queue.
  proposals.clear(); selectedUploads.length = 0; renderUploads(); renderProposals(); ui.messages.replaceChildren(); images?.clear(); clearRichText(); contentCapabilities = []; assistantTexts.clear(); messageFolds.clear(); workFolds.clear();
  ui['proposal-text'].value = ''; saveDraft(); resizeComposer();
  ui['proposal-feedback'].textContent = ''; ui['history-note'].hidden = true; ui['new-replies-button'].hidden = true;
  ui['empty-state'].hidden = false; ui['thread-title'].textContent = '共享会话';
  ui['display-name'].value = displayName; ui['recovery-input'].value = '';
  emptyState('邀请已更新', '正在连接，完成准入和同步后即可协作。');
  connect();
}

function userMessageBody(text, item) {
  let body;
  if (item.presentation?.kind === 'question_reply' && Array.isArray(item.presentation.replies)) {
    body = document.createElement('div'); body.className = 'message-body question-replies';
    for (const reply of item.presentation.replies.slice(0, 64)) {
      if (typeof reply?.question !== 'string' || typeof reply?.answer !== 'string') continue;
      const pair = document.createElement('div'); pair.className = 'question-reply';
      const question = document.createElement('div'); question.className = 'question-reply-question';
      question.textContent = reply.question; question.title = reply.question;
      const answer = document.createElement('div'); answer.className = 'question-reply-answer'; answer.textContent = reply.answer;
      pair.append(question, answer); body.append(pair);
    }
    if (!body.children.length) body = null;
  }
  if (!body) {
    body = document.createElement('div'); body.className = 'message-body';
    if (window.renderMarkdown) {
      body.className += ' markdown';
      // Structured attachments already appear above the bubble. Suppress only
      // duplicate Markdown placeholders; user text never grants a file read.
      window.renderMarkdown(body, item.text, { renderImage: (_parent, index) => item.attachmentImageIndices?.includes(index) === true });
    } else body.textContent = item.text;
  }
  body.id = `message-body-${++presentationSerial}`;
  text.append(body);
  if (item.text.length < 300 && item.text.split('\n').length <= 20) return;
  const ellipsis = document.createElement('div'); ellipsis.className = 'message-ellipsis'; ellipsis.textContent = '…';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'message-fold-toggle';
  toggle.setAttribute('aria-controls', body.id);
  text.append(ellipsis, toggle);
  let collapsible = false;
  const draw = () => {
    const expanded = messageFolds.get(item.id) === true;
    text.dataset.collapsed = String(collapsible && !expanded);
    ellipsis.hidden = !collapsible || expanded; toggle.hidden = !collapsible;
    toggle.textContent = expanded ? '收起 ⌃' : '显示更多 ⌄';
    toggle.setAttribute('aria-expanded', String(expanded || !collapsible));
  };
  const fit = () => {
    const lineHeight = parseFloat(window.getComputedStyle?.(body).lineHeight) || 27.2;
    let height = lineHeight * 20;
    collapsible = typeof body.getBoundingClientRect === 'function'
      ? body.scrollHeight > height + 1 : item.text.split('\n').length > 20 || item.text.length > 1600;
    if (collapsible && body.getBoundingClientRect) {
      const top = body.getBoundingClientRect().top;
      // Keep a code block crossing the fold boundary intact.
      for (const code of body.querySelectorAll('pre')) {
        const box = code.getBoundingClientRect(), start = box.top - top, end = box.bottom - top;
        if (start < height && end > height) { height = end; break; }
      }
      // End at a complete visible line rather than slicing a glyph or list row.
      if (document.createTreeWalker && document.createRange) {
        const walker = document.createTreeWalker(body, 4), range = document.createRange();
        let node, bottom = 0, count = 0;
        while ((node = walker.nextNode()) && count++ < 1000) {
          range.selectNodeContents(node);
          for (const box of range.getClientRects()) if (box.height && box.bottom - top <= height + .5) bottom = Math.max(bottom, box.bottom - top);
        }
        if (bottom > 0) height = Math.ceil(bottom);
      }
    }
    body.style.setProperty('--message-fold-height', `${height}px`); draw();
  };
  toggle.addEventListener('click', () => { messageFolds.set(item.id, messageFolds.get(item.id) !== true); draw(); });
  fitMessageFolds.push(fit); fit();
}

function planExecutionPreview(item, parent) {
  const plan = item.presentation?.kind === 'plan_execution' && item.presentation.plan;
  if (typeof plan !== 'string' || !plan.trim()) return;
  const card = document.createElement('section'); card.className = 'plan-execution-card';
  card.setAttribute('aria-label', '执行的计划');
  const caption = document.createElement('div'); caption.className = 'plan-card-caption'; caption.textContent = '☼  计划';
  const body = document.createElement('div'); body.className = 'plan-card-body markdown'; body.id = `plan-body-${++presentationSerial}`;
  if (window.renderMarkdown) window.renderMarkdown(body, plan); else body.textContent = plan;
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'plan-card-toggle';
  toggle.setAttribute('aria-controls', body.id);
  const key = `plan:${item.id}`;
  const draw = () => { const expanded = messageFolds.get(key) === true; card.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起计划 ⌃' : '展开计划 ⌄'; };
  toggle.addEventListener('click', () => { messageFolds.set(key, messageFolds.get(key) !== true); draw(); });
  draw(); card.append(caption, body, toggle); parent.append(card);
}

function messageTime(item) {
  return Number.isFinite(item.createdAt) && item.createdAt >= 946684800000 && item.createdAt <= Date.now() + 86400000
    ? new Date(item.createdAt) : null;
}

function appendDaySeparator(item, parent, previousDay) {
  const time = messageTime(item);
  if (!time) return previousDay;
  const day = `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}`;
  if (day === previousDay) return day;
  const today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const sameDay = value => value.getFullYear() === time.getFullYear() && value.getMonth() === time.getMonth() && value.getDate() === time.getDate();
  const date = sameDay(today) ? '今天' : sameDay(yesterday) ? '昨天' : `${time.getFullYear()}/${time.getMonth() + 1}/${time.getDate()}`;
  const label = document.createElement('div'); label.className = 'conversation-day';
  label.textContent = `${date} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  parent.append(label); return day;
}

function renderMessage(item, parent) {
  const article = document.createElement('article');
  article.dataset.messageId = item.id;
  if (item.role === 'activity') {
    article.className = 'message message-activity'; article.dataset.kind = item.kind;
    if (contentCapabilities.includes('activity-details')) images?.render([{ id: item.detailId, name: item.text, kind: 'activity', activityKind: item.kind, status: item.status, summary: item.summary, preview: item.preview }], article);
    parent.append(article); return;
  }
  const author = item.author;
  if (item.role === 'user') planExecutionPreview(item, parent);
  const kind = item.role === 'user' && ['host', 'guest'].includes(author?.kind) ? author.kind : 'unknown';
  article.className = `message message-${item.role} message-${kind}`;
  if (item.phase === 'commentary' || item.phase === 'final_answer') article.dataset.phase = item.phase;
  const label = document.createElement('div'); label.className = 'message-author';
  if (item.role === 'user' && kind === 'unknown') label.className += ' message-author-unknown';
  const name = typeof author?.name === 'string' ? [...author.name].slice(0, 40).join('') : '';
  label.textContent = item.role === 'assistant' ? 'Codex'
    : name && kind !== 'unknown' ? `${name} · ${kind === 'host' ? '分享者' : '协作者'}`
    : name === '作者待确认' ? name : '历史消息 · 作者未知';
  const text = document.createElement('div'); text.className = 'message-text';
  if (item.role === 'user') userMessageBody(text, item);
  else if (window.renderMarkdown) {
    text.className += ' markdown';
    window.renderMarkdown(text, item.text, { renderImage(parent, index) {
      const ref = item.images?.find(image => image.syntax !== 'link' && image.index === index);
      if (!images || !ref) return false;
      return images.render([ref], parent, { inline: true }) > 0;
    }, renderFile(parent, index, syntax, context) {
      const image = syntax === 'link' && item.images?.find(image => image.syntax === 'link' && image.linkIndex === index);
      if (image) return !!images?.render([image], parent, { inline: true, link: true });
      const ref = item.files?.find(file => file.index === index && file.syntax === syntax);
      const card = syntax === 'link' && context?.standalone === true
        && /\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|md|markdown|txt|json)$/i.test(ref?.name ?? '');
      return !!(images && ref && images.render([ref], parent, { inline: true, card }));
    } });
    enhanceRichText(text);
  } else text.textContent = item.text;
  article.append(label, text);
  if (item.role === 'user' && ['chatgpt', 'cross_chat'].includes(item.source?.kind)) {
    const source = document.createElement('div'); source.className = 'message-source';
    source.textContent = item.source.kind === 'chatgpt' ? '由 ChatGPT 从另一个聊天发送' : '从另一个聊天发送'; article.append(source);
  }
  const time = item.role === 'user' && messageTime(item);
  if (time) { const timestamp = document.createElement('div'); timestamp.className = 'message-timestamp';
    timestamp.textContent = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`; article.append(timestamp); }
  images?.render([...(item.role === 'assistant' && window.renderMarkdown ? [] : item.images ?? []), ...(item.files ?? []).filter(file => item.role !== 'assistant' || !window.renderMarkdown || file.syntax === undefined)], article, { attachment: item.role === 'user' });
  parent.append(article);
}

function renderTranscript(items, parent) {
  const turnMetadata = new Map(), seenWork = new Set(), pendingReplies = new Set(), responses = new Set();
  for (const item of items) {
    if (!/^[a-f0-9]{64}$/.test(item.turnId ?? '')) continue;
    const metadata = turnMetadata.get(item.turnId) ?? {};
    if (item.turnStatus) metadata.turnStatus = item.turnStatus;
    if (Number.isFinite(item.turnDurationMs)) metadata.turnDurationMs = item.turnDurationMs;
    turnMetadata.set(item.turnId, metadata);
    if (item.role === 'user' && (seenWork.has(item.turnId) || item.presentation?.kind === 'question_reply'
        || ['chatgpt', 'cross_chat'].includes(item.source?.kind))) pendingReplies.add(item.turnId);
    if (item.role === 'assistant') {
      // A response to an explicit mid-turn answer belongs beside that answer,
      // even when the earlier execution history was collapsed.
      if (pendingReplies.delete(item.turnId)) responses.add(item);
      seenWork.add(item.turnId);
    } else if (item.role === 'activity') seenWork.add(item.turnId);
  }
  const foldable = item => /^[a-f0-9]{64}$/.test(item.turnId ?? '') && (item.role === 'activity' && !['diff', 'plan'].includes(item.kind)
    || item.role === 'assistant' && item.phase === 'commentary' && !responses.has(item) && !item.images?.length && !item.files?.length);
  const groups = new Map();
  for (const item of items) if (foldable(item)) {
    let group = groups.get(item.turnId);
    if (!group) { group = { items: [], segments: [], toggle: null }; groups.set(item.turnId, group); }
    group.items.push(item);
  }
  let previousDay = null;
  for (let index = 0; index < items.length;) {
    const first = items[index];
    previousDay = appendDaySeparator(first, parent, previousDay);
    if (!foldable(first)) { renderMessage(first, parent); index++; continue; }
    const group = groups.get(first.turnId), key = first.turnId;
    const segment = [];
    while (index < items.length && items[index].turnId === key && foldable(items[index])) segment.push(items[index++]);
    const body = document.createElement('div'); body.className = 'work-content'; body.id = `work-content-${++presentationSerial}`;
    group.segments.push({ body, items: segment, rendered: false });
    if (!group.toggle) {
      const metadata = turnMetadata.get(key) ?? {};
      const running = metadata.turnStatus === 'running';
      group.expanded = workFolds.has(key) ? workFolds.get(key) : running;
      const section = document.createElement('section'); section.className = 'work-group'; section.dataset.running = String(running);
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'work-summary'; group.toggle = toggle;
      const duration = Number.isFinite(metadata.turnDurationMs) && metadata.turnDurationMs >= 0 ? metadata.turnDurationMs : undefined;
      const seconds = duration === undefined ? null : Math.floor(duration / 1000);
      const time = seconds === null ? '' : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      toggle.textContent = running ? '活动' : time ? `用时 ${time}` : '执行过程';
      if (!running && metadata.turnStatus === 'failed') toggle.textContent += ' · 失败';
      else if (!running && metadata.turnStatus === 'interrupted') toggle.textContent += ' · 已中断';
      const chevron = document.createElement('span'); chevron.className = 'work-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true'); toggle.append(chevron);
      group.draw = () => {
        toggle.setAttribute('aria-expanded', String(!!group.expanded));
        toggle.setAttribute('aria-controls', group.segments.map(part => part.body.id).join(' '));
        for (const part of group.segments) {
          part.body.hidden = !group.expanded;
          if (group.expanded && !part.rendered) { part.rendered = true; for (const item of part.items) renderMessage(item, part.body); }
        }
      };
      toggle.addEventListener('click', () => { group.expanded = !group.expanded; workFolds.set(key, group.expanded); group.draw(); images?.mounted(); });
      section.append(toggle, body); parent.append(section);
    } else { body.className += ' work-continuation'; parent.append(body); }
    group.draw();
  }
  for (const key of workFolds.keys()) if (!groups.has(key)) workFolds.delete(key);
  const messageIds = new Set(items.filter(item => item.role === 'user').map(item => item.id));
  for (const id of messageFolds.keys()) if (!messageIds.has(id.startsWith('plan:') ? id.slice(5) : id)) messageFolds.delete(id);
}

function renderSnapshot(payload) {
  if (!admitted || !Array.isArray(payload.items)
      || !['idle', 'running', 'offline'].includes(payload.status)) return;
  if (typeof payload.revision === 'number' && Number.isFinite(payload.revision)) {
    if (lastRevision !== null && payload.revision < lastRevision) return;
    lastRevision = payload.revision;
  }
  clearRichText();
  contentCapabilities = Array.isArray(payload.capabilities) ? payload.capabilities.filter(c => ['file-original', 'activity-details'].includes(c)) : [];
  const nearBottom = nearConversationBottom();
  const previousScrollTop = ui.conversation.scrollTop;
  const firstSnapshot = !receivedSnapshot;
  const allItems = payload.items.filter((item) => item && ['user', 'assistant', 'activity'].includes(item.role)
    && typeof item.text === 'string' && (item.role !== 'activity' || contentCapabilities.includes('activity-details')));
  const items = allItems.slice(-500);
  hostOnline = payload.status !== 'offline';
  images?.retain(new Set(items.flatMap(item => [...(item.images ?? []), ...(item.files ?? []), ...(item.role === 'activity' ? [{ id: item.detailId }] : [])].map(file => file.id))));
  const nextAssistantTexts = new Map(items.filter(item => item.role === 'assistant')
    .map(item => [item.id, item.text]));
  const hasNewReply = !firstSnapshot && [...nextAssistantTexts].some(([id, text]) =>
    text.trim() && assistantTexts.get(id) !== text);
  assistantTexts = nextAssistantTexts;
  const content = document.createDocumentFragment();
  renderTranscript(items, content);
  ui.messages.replaceChildren(content);
  for (const fit of fitMessageFolds) fit();
  images?.mounted();
  ui['empty-state'].hidden = items.length > 0;
  emptyState('已加入，等待第一条消息', '分享者的对话内容会同步到这里。你也可以先提交一条建议。');
  ui['thread-title'].textContent = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.slice(0, 240) : '共享会话';
  ui['history-note'].hidden = allItems.length <= 500 && payload.historyTruncated !== true;
  ui['history-note'].textContent = allItems.length > 500
    ? '当前展示最近 500 条文字消息，较早内容未包含在此视图中。'
    : Number.isSafeInteger(payload.omittedActivities) && payload.omittedActivities > 0
      ? `为优先展示聊天正文，${payload.omittedActivities} 条较早活动未包含在当前视图中。`
      : '当前仅展示最近的共享文字，较早或过长的内容可能已截断。';
  receivedSnapshot = true;
  hostOnline = payload.status !== 'offline';
  ui['agent-status'].hidden = false;
  const running = payload.status === 'running';
  ui['agent-status'].textContent = hostOnline ? (running ? 'Agent 执行中' : 'Agent 空闲') : '分享者离线';
  ui['agent-status'].dataset.running = String(running && hostOnline);
  if (hostOnline) {
    setStatus('已连接', 'connected');
    notice('');
    ui['member-description'].textContent = '你正在查看分享者开放的这条会话。';
    ui['sync-label'].textContent = '刚刚同步';
  } else {
    setStatus('分享者离线', 'warning');
    notice('分享者当前离线，暂时无法提交建议。页面保留上次同步内容。', 'warning');
    ui['sync-label'].textContent = '已暂停 · 显示上次同步内容';
  }
  updateControls();
  if (nearBottom || firstSnapshot) {
    viewLatestReply();
  } else {
    ui.conversation.scrollTop = previousScrollTop;
    if (hasNewReply) ui['new-replies-button'].hidden = false;
  }
  taskNotifications?.observe(payload.status);
}

const proposalLabels = {
  pending: '等待分享者确认',
  processing: '正在提交给 Agent',
  accepted: '已交给 Agent',
  rejected: '分享者未接受',
  failed: '提交失败',
  unknown: '结果待确认',
};

function renderProposals() {
  ui['proposals-panel'].hidden = proposals.size === 0;
  ui['proposal-count'].textContent = String(proposals.size);
  ui['submission-summary'].textContent = proposals.size ? `${proposals.size} 条提交` : '暂无提交';
  ui['proposals-empty'].hidden = proposals.size > 0;
  const content = document.createDocumentFragment();
  for (const proposal of [...proposals.values()].reverse()) {
    const entry = document.createElement('li');
    entry.className = 'proposal-entry';
    const status = document.createElement('span');
    status.className = 'proposal-status';
    status.dataset.status = proposal.status;
    status.textContent = proposalLabels[proposal.status];
    const text = document.createElement('p');
    text.className = 'proposal-content';
    text.textContent = proposal.text;
    entry.append(status, text);
    if (proposal.message) {
      const detail = document.createElement('p');
      detail.className = 'proposal-detail';
      detail.textContent = proposal.message;
      entry.append(detail);
    }
    content.append(entry);
  }
  ui.proposals.replaceChildren(content);
}

function handleMessage(message) {
  if (!message || typeof message !== 'object' || terminal) return;
  switch (message.type) {
    case 'pong':
      break;
    case 'pending':
      if (message.heartbeat === true && heartbeatTimer === null) {
        heartbeatTimer = window.setInterval(checkHeartbeat, 25000);
      }
      connecting = false;
      admitted = false;
      setStatus('等待分享者确认', 'pending');
      ui['join-panel'].hidden = true;
      ui['member-panel'].hidden = false;
      ui['member-title'].textContent = '申请已送达';
      ui['member-description'].textContent = savedVisitor ? '正在核对原准入；未匹配时需分享者确认。' : '分享者确认后，你就能查看对话并提交建议。';
      if (!receivedSnapshot) emptyState('等待分享者确认', '申请已送达。确认后，共享对话会自动显示在这里。');
      updateControls();
      break;
    case 'admitted':
      reconnectAttempts = 0; cancelReconnect();
      connecting = false;
      admitted = true;
      void taskNotifications?.admitted();
      // Wait for the host's snapshot before enabling submission.
      hostOnline = false;
      setStatus('正在同步会话', 'pending');
      ui['join-panel'].hidden = true;
      ui['member-panel'].hidden = false;
      ui['member-title'].textContent = '你已加入';
      ui['member-description'].textContent = '正在读取这条会话的共享内容。';
      notice('');
      send({ type: 'snapshot-request' });
      updateControls();
      break;
    case 'denied':
      invitationRecovery?.revoke();
      setTerminal('分享者未同意这次加入。请联系分享者，获取新的邀请后再试。', '未获准加入');
      break;
    case 'revoked':
      invitationRecovery?.revoke();
      setTerminal('分享者已结束你的访问。若要继续参与，请重新获取邀请。', '访问已撤销');
      break;
    case 'expired':
      setTerminal('邀请已到期。请让分享者重新分享，并发送新邀请。', '邀请已到期');
      invitationRecovery?.probe();
      break;
    case 'interrupted':
      setTerminal('共享因故中断，正在检查能否申请恢复邀请。', '共享因故中断');
      invitationRecovery?.probe();
      break;
    case 'paused':
      setTerminal('共享已暂停，正在检查能否申请恢复邀请。', '共享已暂停', { preserveIdentity: true });
      invitationRecovery?.probe();
      break;
    case 'join-rejected':
      detachSocket();
      disconnect('邀请当前不可用，正在尝试恢复。若持续失败，请让分享者检查共享状态或发送新邀请。');
      invitationRecovery?.probe();
      break;
    case 'not-admitted':
    case 'authentication-timeout':
      detachSocket(); disconnect('连接已中断，需要重新申请加入。旧建议不会自动重发。');
      break;
    case 'rate-limited':
    case 'invalid-message':
      setTerminal('连接已停止，请联系分享者检查后获取新邀请。', '连接已停止');
      break;
    case 'offline':
      taskNotifications?.reset();
      hostOnline = false;
      images?.pause(); clearRichText();
      setStatus('分享者离线', 'warning');
      notice('分享者当前离线，协作已暂停。建议不会在离线时发送或自动重发。', 'warning');
      ui['agent-status'].textContent = '分享者离线';
      ui['agent-status'].hidden = !admitted;
      ui['sync-label'].textContent = receivedSnapshot ? '已暂停 · 显示上次同步内容' : '等待分享者上线';
      markPendingUnknown();
      updateControls();
      break;
    case 'error':
      notice(typeof message.message === 'string' ? message.message.slice(0, 500) : '操作未完成，请稍后重试。', 'warning');
      break;
    case 'data': {
      if (!admitted || !message.payload || typeof message.payload !== 'object') return;
      const payload = message.payload;
      if (payload.type === 'upload-policy') {
        uploadEnabled = payload.enabled === true && payload.maxFileBytes === uploadLimit && payload.maxAttachments === 8 && payload.chunkBytes === uploadChunkBytes;
        updateControls();
      }
      if (payload.type === 'upload-status') {
        const waiter = uploadWaiters.get(payload.uploadId);
        if (waiter) {
          if (payload.status === 'failed' || payload.status === 'cancelled') waiter.reject(new Error(typeof payload.message === 'string' ? payload.message.slice(0,200) : '上传失败，请移除后重新添加。'));
          else if (payload.status === waiter.expected.status && payload.index === waiter.expected.index) waiter.resolve(payload);
        }
      }
      if (payload.type === 'share-ended' && ['expired', 'interrupted', 'paused'].includes(payload.reason)) {
        const expired = payload.reason === 'expired';
        setTerminal(expired ? '邀请已到期，正在检查能否申请恢复。' : '共享因故中断，正在检查能否申请恢复邀请。',
          expired ? '邀请已到期' : '共享因故中断', { preserveIdentity: payload.reason === 'paused' });
        invitationRecovery?.probe(); return;
      }
      if (payload.type === 'share-paused') {
        setTerminal('共享入口已暂停。同一网站的新邀请会自动恢复身份；如果更换域名，请从协作详情中备份身份。旧消息不会重发。', '共享已暂停', { preserveIdentity: true });
        invitationRecovery?.probe();
        return;
      }
      if (payload.type === 'visitor-recovery' && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > Date.now()) {
        savedVisitor = true;
        if (typeof payload.name === 'string' && payload.name.trim() && [...payload.name].length <= 40
          && !/[\u0000-\u001f\u007f-\u009f]/u.test(payload.name)) {
          displayName = payload.name; ui['member-name'].textContent = displayName;
          ui['member-avatar'].textContent = [...displayName][0];
        }
        // Only the host-confirmed scope is persisted. A URL identifier alone
        // never grants admission or extends the host's original expiry.
        recoveryRecord = { scopeId: validScope(payload.scopeId) ? payload.scopeId : '', roomId,
          token: visitorToken, name: displayName, approved: true, expiresAt: payload.expiresAt };
        const persistent = rememberIdentity(recoveryRecord);
        ui['recovery-input'].value = '';
        ui['identity-notice'].hidden = false;
        ui['identity-notice'].textContent = persistent
          ? `${payload.resumed ? '已自动恢复身份。' : '已在此浏览器自动保存身份。'}换浏览器或域名前，请下载一份恢复文件。`
          : '浏览器未能长期保存身份。请下载恢复文件，下次打开邀请时选择该文件即可恢复。';
        ui['identity-warning'].hidden = persistent;
        ui['recovery-panel'].hidden = false; ui['recovery-code'].value = visitorToken;
        ui['recovery-note'].textContent = `身份有效至 ${new Date(payload.expiresAt).toLocaleString()}。`;
        refreshCollaboration();
      }
      if (['image-chunk', 'image-unavailable', 'file-chunk', 'file-unavailable', 'activity-chunk', 'activity-unavailable'].includes(payload.type)) images?.receive(payload);
      if (payload.type === 'snapshot') renderSnapshot(payload);
      if (payload.type === 'message-policy' && typeof payload.requireApproval === 'boolean') {
        requireApproval = payload.requireApproval;
        policyKnown = true;
        refreshCollaboration();
        ui['proposal-help'].textContent = requireApproval ? '分享者已开启消息审批，确认后才交给 Agent。' : '消息将直接交给 Agent，无需逐条审批。';
      }
      if (payload.type === 'proposal-status' && proposals.has(payload.requestId)
          && Object.hasOwn(proposalLabels, payload.status)) {
        const proposal = proposals.get(payload.requestId);
        proposal.status = payload.status;
        proposal.message = typeof payload.message === 'string' ? payload.message.slice(0, 500) : '';
        proposalFeedback(proposalLabels[payload.status], ['failed', 'rejected', 'unknown'].includes(payload.status));
        renderProposals();
      }
      break;
    }
    default:
      break;
  }
}

function connect() {
  if (!validInvitation || terminal || connecting) return;
  taskNotifications?.reset();
  cancelReconnect();
  detachSocket();
  images?.clear(); clearRichText(); contentCapabilities = [];
  admitted = false;
  hostOnline = false;
  connecting = true;
  lastRevision = null;
  notice('');
  setStatus('正在连接', 'pending');
  ui['join-feedback'].textContent = '';
  ui['member-name'].textContent = displayName;
  ui['member-avatar'].textContent = [...displayName][0] || '访';
  ui['member-title'].textContent = '正在申请加入';
  updateControls();

  const url = new URL('/guest', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.hash = '';
  url.search = '';
  let current;
  try {
    current = new WebSocket(url);
    socket = current;
  } catch {
    disconnect('无法建立连接，请检查网络和邀请链接。');
    return;
  }
  connectTimer = window.setTimeout(() => {
    if (socket !== current || current.readyState === WebSocket.OPEN) return;
    detachSocket();
    disconnect('连接超时，请检查网络后重新申请连接。');
  }, 15000);
  current.addEventListener('open', () => {
    if (socket !== current) return;
    clearConnectionTimer();
    lastActivity = Date.now();
    send({ type: 'join', roomId, inviteToken, name: displayName, sessionId: visitorToken });
    setStatus('等待分享者确认', 'pending');
  });
  current.addEventListener('message', (event) => {
    if (socket !== current || typeof event.data !== 'string') return;
    lastActivity = Date.now();
    try { handleMessage(JSON.parse(event.data)); } catch { /* Ignore malformed messages. */ }
  });
  current.addEventListener('error', () => {
    if (socket !== current) return;
    notice('连接遇到问题。请检查网络；页面不会自动重发建议。', 'warning');
  });
  current.addEventListener('close', () => {
    if (socket !== current) return;
    socket = null;
    stopHeartbeat();
    clearConnectionTimer();
    disconnect();
  });
}

function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

ui['join-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const recovery = ui['recovery-input'].value.trim();
  if (recovery && !validRecovery(recovery)) { ui['join-feedback'].textContent = '恢复凭据格式不正确，请完整粘贴。'; return; }
  const name = ui['display-name'].value.trim() || (recovery ? '恢复中的同伴' : '');
  if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test(ui['display-name'].value)) {
    ui['join-feedback'].textContent = '请填写 1–40 个字符的显示名称。';
    ui['display-name'].focus();
    return;
  }
  displayName = name;
  if (recovery) { visitorToken = recovery; savedVisitor = true; ui['recovery-input'].value = ''; }
  connect();
});
ui['recovery-input'].addEventListener('input', () => {
  ui['display-name'].required = !validRecovery(ui['recovery-input'].value.trim());
});
ui['copy-recovery'].addEventListener('click', () => {
  const input = ui['recovery-code'];
  const fallback = () => {
    input.type = 'text'; input.select();
    ui['recovery-feedback'].textContent = '请复制个人恢复凭据，只在分享者的新邀请页面输入。';
  };
  if (window.navigator?.clipboard) window.navigator.clipboard.writeText(input.value).then(() => { ui['recovery-feedback'].textContent = '恢复凭据已复制，请勿转发给他人。'; }).catch(fallback);
  else fallback();
});
ui['download-recovery'].addEventListener('click', () => {
  if (!validIdentity(recoveryRecord)) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ type: 'codex-co2-recovery', version: 1, ...recoveryRecord })], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'Codex-Co2-身份恢复.json'; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  ui['recovery-feedback'].textContent = '已请求下载恢复文件。换浏览器后，在新邀请页面选择该文件即可；请勿转发。';
});
ui['import-recovery'].addEventListener('change', async () => {
  const input = ui['import-recovery'];
  const file = input.files?.[0];
  if (!file || connecting || admitted || terminal) return;
  try {
    if (file.size > 4096) throw new Error();
    const record = JSON.parse(await file.text());
    if (record.type !== 'codex-co2-recovery' || record.version !== 1 || !validIdentity(record)) throw new Error();
    if (!sameIdentity(record)) {
      ui['join-feedback'].textContent = '这个恢复文件不属于当前共享，请打开对应的新邀请链接，或重新申请加入。'; return;
    }
    ui['display-name'].value = record.name;
    ui['recovery-input'].value = record.token;
    ui['display-name'].required = false;
    ui['join-button'].textContent = '恢复连接';
    ui['join-feedback'].textContent = '已读取个人身份，点击“恢复连接”即可。';
  } catch { ui['join-feedback'].textContent = '恢复文件无效或已到期，请选择此前保存的文件，或重新申请加入。'; }
  finally { input.value = ''; }
});

ui['collaboration-toggle'].addEventListener('click', () => {
  if (ui['collaboration-panel'].hidden) { refreshCollaboration(); showCollaboration(); }
  else closeCollaboration();
});
ui['collaboration-back'].addEventListener('click', () => showCollaboration());
ui['collaboration-close'].addEventListener('click', () => closeCollaboration());
ui['open-proposals'].addEventListener('click', () => showCollaboration('proposals'));
ui['open-help'].addEventListener('click', () => showCollaboration('help'));
ui['open-backup'].addEventListener('click', () => {
  refreshCollaboration();
  if (!ui['open-backup'].disabled) showCollaboration('backup');
});
ui['open-backup-warning'].addEventListener('click', () => {
  refreshCollaboration(); showCollaboration('backup');
});
document.addEventListener('pointerdown', event => {
  if (!ui['collaboration-panel'].contains(event.target) && !ui['collaboration-toggle'].contains(event.target)) closeCollaboration();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ui['collaboration-panel'].hidden) {
    event.preventDefault(); closeCollaboration();
  }
});
document.addEventListener('focusin', event => {
  if (!ui['collaboration-panel'].contains(event.target) && !ui['collaboration-toggle'].contains(event.target)) closeCollaboration(false);
});

ui['reconnect-button'].addEventListener('click', () => { reconnectAttempts = 0; connect(); });
ui['new-replies-button'].addEventListener('click', viewLatestReply);
ui.conversation.addEventListener('scroll', () => {
  if (nearConversationBottom(8)) ui['new-replies-button'].hidden = true;
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  taskNotifications?.refresh();
  if (document.visibilityState === 'visible') invitationRecovery?.visible();
  if (document.visibilityState === 'visible' && admitted && !terminal
      && socket?.readyState === WebSocket.OPEN) {
    if (heartbeatTimer !== null && Date.now() - lastActivity > 75000) socket.close();
    else send({ type: 'snapshot-request' });
  }
});
window.addEventListener('online', () => {
  invitationRecovery?.resume();
  if (!displayName || terminal || invitationReloadPending) return;
  if (socket?.readyState === WebSocket.OPEN) { if (heartbeatTimer !== null) checkHeartbeat(); return; }
  if (!connecting) { reconnectAttempts = 0; connect(); }
});
window.addEventListener('pagehide', () => {
  invitationRecovery?.suspend();
  taskNotifications?.reset();
  cancelReconnect(); detachSocket(); connecting = false; admitted = false; hostOnline = false; updateControls();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) invitationRecovery?.resume();
  if (event.persisted && displayName && !terminal && !invitationReloadPending) { reconnectAttempts = 0; connect(); }
});
window.addEventListener('hashchange', () => {
  const next = new URLSearchParams(window.location.hash.slice(1));
  if (invitationReloadPending || !isValidInvitation(next.get('room'), next.get('invite'))) return;
  // Same-document invitation navigation must create a fresh page/session. Keep
  // the new fragment for startup to consume; never mix it into the old socket.
  invitationReloadPending = true;
  invitationRecovery?.close();
  cancelReconnect(); detachSocket();
  window.location.reload();
});
ui['proposal-text'].addEventListener('input', () => {
  saveDraft();
  ui['character-count'].textContent = `${ui['proposal-text'].value.length.toLocaleString('en-US')} / 8,000`;
  resizeComposer();
  updateControls();
});
ui['proposal-text'].addEventListener('keydown', (event) => {
  // keyCode 229 also covers IMEs that clear isComposing on the commit key.
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
      || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) ui['proposal-form'].requestSubmit();
});
ui['attach-button'].addEventListener('click', () => ui['attachment-input'].click());
ui['attachment-input'].addEventListener('change', () => { addUploadFiles(ui['attachment-input'].files); ui['attachment-input'].value = ''; });
ui['proposal-text'].addEventListener('paste', event => {
  if (event.clipboardData?.files?.length && canPropose() && uploadEnabled) { event.preventDefault(); addUploadFiles(event.clipboardData.files); }
});
ui['proposal-form'].addEventListener('dragover', event => {
  if (canPropose() && uploadEnabled && Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
});
ui['proposal-form'].addEventListener('drop', event => {
  if (event.dataTransfer?.files?.length) { event.preventDefault(); addUploadFiles(event.dataTransfer.files); }
});
ui['proposal-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui['proposal-text'].value.trim();
  if (!canPropose() || (!text && !selectedUploads.length) || text.length > 8000 || selectedUploads.some(a => a.status !== 'ready')) return;
  const id = requestId();
  const attachmentIds = selectedUploads.map(a => a.id), attachmentNames = selectedUploads.map(a => a.file.name);
  if (!send({ type: 'proposal', requestId: id, text, ...(attachmentIds.length ? { attachmentIds } : {}) })) {
    proposalFeedback('尚未发送，草稿已保留。请恢复连接后再试。', true);
    return;
  }
  proposals.set(id, { text: [text, ...attachmentNames.map(name => `📎 ${name}`)].filter(Boolean).join('\n'), status: requireApproval ? 'pending' : 'processing', message: '' });
  for (const item of selectedUploads) disposeUploadPreview(item);
  selectedUploads.length = 0; renderUploads();
  renderProposals();
  ui['proposal-text'].value = '';
  saveDraft();
  ui['character-count'].textContent = '0 / 8,000';
  proposalFeedback(requireApproval ? '建议已提交，等待分享者确认。' : '消息已发送，正在提交给 Agent。');
  resizeComposer();
  updateControls();
});

invitationRecovery = window.createInviteRecovery?.({ invitation: { roomId, inviteToken },
  getName: () => displayName || ui['display-name'].value, newToken: newVisitorToken, newRequestId: requestId,
  onRecoverable: reason => {
    setTerminal(reason === 'expired' ? '邀请已到期，可以向分享者申请恢复。' : '共享因故中断，可以向分享者申请恢复。',
      reason === 'expired' ? '邀请已到期' : '共享因故中断');
    ui['join-panel'].hidden = true;
  }, onUnavailable: () => {
    setTerminal('邀请不可恢复，请联系分享者发送新邀请。', '邀请不可恢复');
    ui['join-panel'].hidden = true;
  }, onApproved: useRecoveredInvitation,
});
if (invitationRecovery?.hasRequest) {
  terminal = true; ui['join-panel'].hidden = true;
  setStatus('正在查询恢复申请', 'pending');
  emptyState('等待邀请恢复', '正在查询此前申请的处理结果。');
} else if (!validInvitation) {
  terminal = true;
  roomId = '';
  inviteToken = '';
  setStatus('需要邀请链接', 'neutral');
  notice('请从分享者发来的完整邀请链接打开此页面。刷新后的页面不会保留邀请凭据。');
  emptyState('这里需要一份邀请', '请让分享者发送邀请链接，打开后即可申请加入。');
  ui['join-feedback'].textContent = '当前链接没有有效的邀请信息。';
}
updateControls();
resizeComposer();
window.addEventListener('resize', () => { resizeComposer(); for (const fit of fitMessageFolds) fit(); });
if (validInvitation && savedVisitor && displayName && !invitationRecovery?.hasRequest) connect();
invitationRecovery?.start();

// Keep the composer above the software keyboard without changing transcript scroll.
if (window.visualViewport) {
  const resizeViewport = () => {
    document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport.height}px`);
    document.documentElement.style.setProperty('--viewport-top', `${window.visualViewport.offsetTop}px`);
    resizeComposer();
    for (const fit of fitMessageFolds) fit();
  };
  window.visualViewport.addEventListener('resize', resizeViewport);
  window.visualViewport.addEventListener('scroll', resizeViewport);
  resizeViewport();
}
