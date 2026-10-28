const $ = s => document.querySelector(s);
const i18n = window.Co2I18n, t = i18n.t;
let activeTab = 'sessions', lastState = null, lastAttached, disconnected = false;
let connectionAction = '', rebuildArmed = false;
let shareLimitDirty = false, shareLimitSaving = false, shareLimitStatus = '', shareLimitAlert = null;
let networkDraft = null, networkDirty = false, networkSaving = false, networkStatus = '';
let nameHint = '用于新共享会话中的消息署名，1–40 个字符。';
let noticeState = { text: '正在连接…', tone: 'ready', values: {} };
const token = new URLSearchParams(location.hash.slice(1)).get('owner');
history.replaceState(null, '', location.pathname);
const ws = new WebSocket(`ws://${location.host}/owner`);
const emptyState = $('#rooms').firstElementChild.cloneNode(true);
const notice = (text, tone = 'ready', values = {}) => { noticeState = { text, tone, values }; $('#notice').textContent = t(text, values); $('.connection').dataset.tone = tone; };
const send = data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, fn, cls) => { const b = el('button', t(text), cls); b.onclick = fn; return b; };
const labels = { online: '共享中', offline: '连接中断', connecting: '正在连接', revoked: '已停止', pending: '待确认', admitted: '已加入', denied: '已拒绝', processing: '提交中', accepted: '已交给 Agent', rejected: '未采纳', unknown: '结果待核实' };
const badge = state => { const b = el('span', t(labels[state] || state), 'badge'); b.dataset.state = state; return b; };
let threads = [], selectedThreadId = '', nextCursor = null, search = '', busyThreadId = '', menuThreadId = '', searchTimer;
let pendingInviteLifetime = null;
let renderedThreadRows = [], ownerNameEdited = false;
const collapsedProjects = new Set(), searchCollapsedProjects = new Set();
const invitationInputs = new Map();
const attentionTargets = new Map();
const recoveryDecisions = new Map();
const attentionCopy = {
  guest: '访客申请加入', proposal: '协作消息待审批', tool: 'Codex 工具等待审批',
  unknown: '消息提交结果待核实', offline: '共享连接中断', connection: '公网入口不可用', 'share-stopped': '共享已异常结束或到期', 'invite-recovery': '邀请恢复申请',
};
const intranetMode = () => Boolean(lastState?.network?.intranetOnly);
const networkWorkBusy = () => networkSaving || Boolean(lastState?.networkBusy);
const attentionLabel = kind => kind === 'connection' && intranetMode() ? '内网入口不可用' : attentionCopy[kind];
function openAttention(id) {
  if (!lastState) return false;
  const item = (lastState.attention ?? []).find(item => item.id === id);
  selectTab('shared', true);
  if (!item) { notice('该提醒已处理或失效。'); return true; }
  const target = item.kind === 'connection' ? $('#public-connection')
    : attentionTargets.get(`${item.id}:${item.itemId}`) ?? attentionTargets.get(item.roomId);
  if (target) {
    target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest' });
  }
  return true;
}
// Native notifications carry an opaque attention ID, never a URL or a decision.
window.openCo2Attention = openAttention;
$('#attention-toggle').onclick = () => {
  const list = $('#attention-list'); list.hidden = !list.hidden;
  $('#attention-toggle').setAttribute('aria-expanded', String(!list.hidden));
};
$('#notification-settings').hidden = !window.webkit?.messageHandlers?.notificationSettings;
$('#notification-settings').onclick = () => window.webkit?.messageHandlers?.notificationSettings?.postMessage('enable');
function renderAttention(m) {
  const items = m.attention ?? [];
  $('#attention').hidden = items.length === 0;
  $('#attention-summary').textContent = items.length ? t('{count} 项协作提醒 · {latest}', { count: items.reduce((n, item) => n + item.count, 0), latest: t(attentionLabel(items[0].kind)) }) : '';
  $('#attention-toggle').setAttribute('aria-label', $('#attention-summary').textContent);
  $('#attention-list').replaceChildren(...items.map(item => {
    const row = button('', () => openAttention(item.id), 'attention-entry');
    const room = m.rooms.find(room => room.roomId === item.roomId)
      ?? (m.recoveryRequests ?? []).find(request => request.roomId === item.roomId);
    row.append(el('strong', t(attentionLabel(item.kind))), el('span', room?.title ?? t('共享连接')), el('span', item.count, 'count'));
    return row;
  }));
}
const tabs = ['sessions', 'shared', 'settings', 'about'];
const tabCopy = {
  sessions: ['选择会话', '共享一条 Codex 会话，一起推进工作。'],
  shared: ['共享会话', '管理正在进行的共享，也可从历史重新分享。'],
  settings: ['设置', '让协作按照你的习惯进行。'],
  about: ['关于', '了解 Codex Co²，获取最新版本。'],
};
function selectTab(name, focus = false) {
  if (!tabs.includes(name)) return;
  activeTab = name; closeMenu();
  for (const tab of tabs) {
    const active = tab === name;
    $(`#tab-${tab}`).setAttribute('aria-selected', String(active));
    $(`#tab-${tab}`).setAttribute('tabindex', active ? '0' : '-1');
    $(`#panel-${tab}`).hidden = !active;
  }
  $('#page-title').textContent = t(tabCopy[name][0]);
  $('#page-description').textContent = t(tabCopy[name][1]);
  if (focus) $(`#tab-${name}`).focus();
}
for (const [index, tab] of tabs.entries()) {
  $(`#tab-${tab}`).onclick = () => selectTab(tab);
  $(`#tab-${tab}`).onkeydown = event => {
    let next;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  };
}
// Native Settings menu uses the same navigation, with no additional runtime access.
window.showCo2Settings = () => selectTab('settings', true);
window.showCo2About = () => { selectTab('about', true); return true; };

// Update capabilities belong to the native host. Browser clients only receive
// read-only version metadata; no web request can supply a download URL or path.
const nativeUpdates = window.webkit?.messageHandlers?.appUpdates;
let appInfo = window.co2AppInfo ?? null;
let nativeAppInfoReceived = Boolean(nativeUpdates && appInfo);
const updatePhases = new Set(['idle', 'checking', 'upToDate', 'available', 'downloading', 'extracting', 'ready', 'installing', 'error']);
let updateState = updatePhases.has(window.co2UpdateState?.phase) ? window.co2UpdateState : { phase: 'idle' };
let starDismissed = false;
try { starDismissed = localStorage.getItem('co2.starDismissed') === 'true'; } catch { /* Native preference is authoritative in the app. */ }
const updateMessage = {
  idle: '启动后每天检查新版本，也可随时手动检查。', checking: '正在检查更新…', upToDate: '当前已是最新版本。',
  available: '发现新版本：{version}', downloading: '正在下载更新…', extracting: '正在校验并准备更新…',
  ready: '更新已准备就绪。', installing: '正在安装更新，即将重新打开 Codex Co²…', error: '检查更新失败，请检查网络后重试。',
};
const versionLabel = (version, build) => `${version ? `v${version}` : t('未知版本')}${build ? ` · Build ${build}` : ''}`;
function updateAction(action, extra = {}) {
  if (!nativeUpdates) return false;
  nativeUpdates.postMessage({ action, ...extra }); return true;
}
function openProjectLink(link) {
  if (!['repository', 'releases'].includes(link)) return;
  if (updateAction('openLink', { link })) return;
  window.open?.(`https://github.com/SpaceCoder-Kafka/codex-co2${link === 'releases' ? '/releases' : ''}`, '_blank', 'noopener,noreferrer');
}
function renderAbout() {
  const native = Boolean(nativeUpdates), supported = native && appInfo?.canUpdate === true;
  const phase = updateState.phase;
  const available = ['available', 'ready'].includes(phase);
  const busy = ['checking', 'downloading', 'extracting', 'installing'].includes(phase);
  const target = versionLabel(updateState.version, updateState.build);
  $('#about-version').textContent = appInfo?.version ? t('版本 {version}', { version: versionLabel(appInfo.version, appInfo.build) }) : t('正在读取版本…');
  $('#about-channel').hidden = !appInfo?.channel;
  $('#about-channel').textContent = t(appInfo?.channel === 'source' ? '源码运行' : appInfo?.channel === 'preview' ? '预览版' : '正式版');
  $('#about-star').hidden = nativeAppInfoReceived ? appInfo.starDismissed === true : starDismissed;
  $('#nav-update').hidden = !['available', 'downloading', 'extracting', 'ready', 'installing'].includes(phase);
  $('#check-update').disabled = !supported || busy;
  $('#check-update').dataset.update = String(available);
  $('#check-update').setAttribute('aria-busy', String(busy));
  $('#check-update-icon').setAttribute('href', available ? '#icon-download' : '#icon-refresh');
  $('#check-update-label').textContent = available ? t('更新到 {version}', { version: target }) : t(phase === 'checking' ? '正在检查…' : ['downloading', 'extracting', 'installing'].includes(phase) ? '正在更新…' : '检查更新');
  $('#cancel-update').hidden = !native || !['checking', 'downloading', 'extracting', 'ready'].includes(phase);
  $('#cancel-update').disabled = false;
  $('#check-again').hidden = !supported || !available;
  $('#check-again').disabled = false;
  $('#about-update-status').dataset.phase = phase;
  $('#about-update-message').textContent = !native ? t('源码运行不支持应用内更新，请从 GitHub 下载 macOS 安装包。')
    : t(updateState.message || updateMessage[phase], { version: target });
  const showProgress = ['downloading', 'extracting'].includes(phase);
  $('#about-update-progress').hidden = !showProgress;
  if (Number.isFinite(updateState.progress)) {
    const progress = Math.max(0, Math.min(1, updateState.progress));
    $('#about-update-progress').value = progress;
    $('#about-update-progress').setAttribute('aria-valuetext', `${Math.round(progress * 100)}%`);
    if (showProgress) $('#about-update-message').textContent += ` ${Math.round(progress * 100)}%`;
  }
  else $('#about-update-progress').removeAttribute?.('value');
  const checked = new Date(updateState.lastChecked ?? NaN);
  $('#about-last-check').textContent = Number.isNaN(checked.getTime()) ? '' : t('上次检查：{time}', { time: checked.toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
  $('#about-update-note').textContent = native ? t('更新会重新打开 Co²；仍有共享时，将先请你确认结束共享。') : t('协作者无需安装应用，在浏览器打开邀请即可加入。');
}
window.receiveCo2AppInfo = info => {
  if (!info || typeof info !== 'object') return;
  if (nativeAppInfoReceived && !nativeUpdates) return;
  appInfo = info; nativeAppInfoReceived = Boolean(nativeUpdates); renderAbout();
};
window.receiveCo2UpdateState = state => {
  if (!state || !updatePhases.has(state.phase)) return;
  updateState = state; renderAbout();
};
function checkUpdates() {
  if (!nativeUpdates || appInfo?.canUpdate !== true || ['checking', 'downloading', 'extracting', 'installing'].includes(updateState.phase)) return;
  updateState = { phase: 'checking', lastChecked: updateState.lastChecked }; renderAbout(); updateAction('check');
}
$('#check-update').onclick = () => {
  if ($('#check-update').disabled) return;
  if (['available', 'ready'].includes(updateState.phase)) {
    updateState = { ...updateState, phase: 'downloading', message: undefined }; renderAbout(); updateAction('install');
  } else checkUpdates();
};
$('#check-again').onclick = checkUpdates;
$('#cancel-update').onclick = () => {
  if ($('#cancel-update').disabled || !['checking', 'downloading', 'extracting', 'ready'].includes(updateState.phase)) return;
  $('#cancel-update').disabled = true; updateAction('cancel');
};
$('#about-repository').onclick = $('#about-star-link').onclick = () => openProjectLink('repository');
$('#about-releases').onclick = () => openProjectLink('releases');
$('#dismiss-star').onclick = () => {
  starDismissed = true;
  if (appInfo) appInfo = { ...appInfo, starDismissed: true };
  if (!updateAction('dismissStar')) { try { localStorage.setItem('co2.starDismissed', 'true'); } catch { /* Dismissal still works for this visit. */ } }
  $('#about-star').hidden = true;
};
if (nativeUpdates) updateAction('info');
const nativeBackground = window.webkit?.messageHandlers?.backgroundService;
let backgroundState = window.co2BackgroundState, backgroundSaving = false;
const backgroundLabels = {
  running: '后台服务正在运行', disabled: '后台运行已关闭，退出应用后停止服务',
  'requires-approval': '请在系统设置中允许 Co² 后台运行', unavailable: '后台服务暂不可用',
  starting: '正在启动后台服务…', stopped: '后台服务已停止',
  foreground: '当前以前台方式运行。退出 Co² 后共享暂停；重新打开后可申请恢复。',
  'pending-restart': '下次打开应用后启用后台运行。',
};
function renderBackground() {
  const foreground = backgroundState?.foregroundOnly === true;
  $('#background-setting').hidden = !nativeBackground;
  $('#background-title').textContent = t(foreground ? '共享恢复记录' : '后台运行');
  $('#background-description').textContent = t(foreground ? '服务随管理应用运行，退出应用后暂停共享。' : '退出管理界面后继续共享；电脑登录后自动启动本机服务。');
  $('#background-toggle-label').textContent = t(foreground ? '保留邀请恢复记录' : '后台运行并自动恢复共享服务');
  $('#background-hint').textContent = t(foreground ? '开启后，重新打开应用可在原内网地址申请恢复；关闭会撤销已保存的恢复资格。' : '默认开启。关闭后，退出应用会停止服务，且不再后台自启动。停止共享始终立即撤销访问。');
  $('#background-enabled').checked = backgroundState?.enabled !== false;
  $('#background-enabled').disabled = !nativeBackground || backgroundState?.supported !== true || backgroundSaving;
  $('#background-status').textContent = t(backgroundSaving ? '正在保存…'
    : foreground && backgroundState?.enabled === false ? '恢复记录已关闭，退出应用后停止共享。'
    : backgroundState?.message || backgroundLabels[backgroundState?.status] || '正在读取后台运行状态…');
  const registrationError = backgroundState?.registrationError;
  if (!backgroundSaving && backgroundState?.status === 'unavailable' && registrationError
    && typeof registrationError.domain === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(registrationError.domain)
    && Number.isSafeInteger(registrationError.code)) {
    $('#background-status').textContent += ` (${registrationError.domain}: ${registrationError.code})`;
  }
  $('#background-system-settings').hidden = !nativeBackground || backgroundState?.status !== 'requires-approval';
}
window.receiveCo2BackgroundState = value => {
  if (!nativeBackground || !value || typeof value.enabled !== 'boolean' || typeof value.supported !== 'boolean'
    || !Object.hasOwn(backgroundLabels, value.status)) return;
  backgroundState = value; backgroundSaving = value.saving === true; renderBackground();
};
$('#background-enabled').onchange = () => {
  if (!nativeBackground || backgroundSaving || backgroundState?.supported !== true) return;
  const enabled = $('#background-enabled').checked;
  backgroundSaving = true; renderBackground();
  try { nativeBackground.postMessage({ action: 'set', enabled }); }
  catch { backgroundSaving = false; backgroundState = { ...backgroundState, message: '后台运行设置未能保存，请重试。' }; renderBackground(); }
};
if (nativeBackground) nativeBackground.postMessage({ action: 'status' });
$('#background-system-settings').onclick = () => nativeBackground?.postMessage({ action: 'settings' });
$('#new-share').onclick = $('#empty-browse').onclick = () => selectTab('sessions', true);
$('#edit-profile').onclick = () => { selectTab('settings'); $('#owner-name').focus(); };
$('#edit-policy').onclick = () => { selectTab('settings'); $('#require-approval').focus(); };
$('#edit-share-limit').onclick = () => {
  selectTab('settings');
  $('#share-limit-setting').scrollIntoView({ block: 'center' });
  ($('#share-limit-mode').value === 'unlimited' ? $('#share-limit-mode') : $('#share-limit')).focus();
};
$('#share-limit-mode').value = 'limited';
$('#share-limit').value = '10';
function renderShareLimit(settings) {
  if (settings && !shareLimitDirty && !shareLimitSaving) {
    $('#share-limit-mode').value = settings.shareLimit === null ? 'unlimited' : 'limited';
    if (settings.shareLimit !== null) $('#share-limit').value = String(settings.shareLimit);
  }
  $('#share-limit').hidden = $('#share-limit').disabled = $('#share-limit-mode').value === 'unlimited';
  $('#save-share-limit').disabled = shareLimitSaving || disconnected;
  $('#share-limit-status').textContent = t(shareLimitStatus);
  if (settings && shareLimitAlert && settings.shareLimit !== shareLimitAlert.limit) shareLimitAlert = null;
  $('#share-limit-alert').hidden = !shareLimitAlert;
  $('#share-limit-message').textContent = shareLimitAlert ? t('已达到同时共享上限（{limit} 条）', shareLimitAlert) : '';
}
const editShareLimit = () => { shareLimitDirty = true; shareLimitStatus = ''; renderShareLimit(); };
$('#share-limit-mode').onchange = editShareLimit;
$('#share-limit').oninput = editShareLimit;
$('#save-share-limit').onclick = () => {
  if (shareLimitSaving || disconnected || ws.readyState !== WebSocket.OPEN) return;
  const shareLimit = $('#share-limit-mode').value === 'unlimited' ? null : Number($('#share-limit').value);
  if (shareLimit !== null && (!Number.isSafeInteger(shareLimit) || shareLimit < 1)) {
    shareLimitStatus = '请输入大于 0 的整数，或选择无限制。'; renderShareLimit(); $('#share-limit').focus(); return;
  }
  shareLimitDirty = true; shareLimitSaving = true; shareLimitStatus = '正在保存…'; renderShareLimit();
  send({ type: 'set-share-limit', shareLimit });
};
function networkChangeBlocked() {
  return disconnected || ws.readyState !== WebSocket.OPEN || !lastState?.network || !lastState.network.configurable
    || networkWorkBusy() || Boolean(connectionAction) || lastState.connection?.state === 'connecting'
    || Boolean(busyThreadId) || Boolean(pendingInviteLifetime) || lastState.rooms.some(room => room.state !== 'revoked');
}
function renderNetwork() {
  const network = lastState?.network;
  if (!networkDraft || (!networkDirty && !networkSaving)) {
    networkDraft = { intranetOnly: Boolean(network?.intranetOnly), lanAddress: network?.lanAddress ?? '' };
  }
  const candidates = [...new Map((network?.interfaces ?? []).map(item => [item.address, item])).values()];
  if (networkDraft.intranetOnly && !networkDraft.lanAddress && candidates.length === 1) networkDraft.lanAddress = candidates[0].address;
  const options = [el('option', t(candidates.length ? '选择内网地址' : '未找到可用内网地址'))]; options[0].value = '';
  for (const item of candidates) {
    const option = el('option', `${item.address} (${item.name})`); option.value = item.address; options.push(option);
  }
  if (networkDraft.lanAddress && !candidates.some(item => item.address === networkDraft.lanAddress)) {
    const option = el('option', t('{address}（已不可用）', { address: networkDraft.lanAddress }));
    option.value = networkDraft.lanAddress; option.disabled = true; options.push(option);
  }
  $('#lan-address').replaceChildren(...options); $('#lan-address').value = networkDraft.lanAddress;
  $('#intranet-only').checked = networkDraft.intranetOnly;
  $('#lan-address-row').hidden = !networkDraft.intranetOnly;
  const blocked = networkChangeBlocked();
  $('#intranet-only').disabled = blocked; $('#lan-address').disabled = blocked;
  $('#save-network').disabled = blocked || !networkDirty;
  $('#save-network').setAttribute('aria-busy', String(networkSaving));
  $('#save-network').textContent = t(networkSaving ? '正在保存…' : '保存访问范围');
  $('#network-current').textContent = t(!network ? '正在读取访问范围…' : network.intranetOnly ? '当前：仅内网可访问' : '当前：公网分享');
  $('#network-hint').textContent = t(networkDraft.intranetOnly
    ? '同事通过内网 IP 加入，不创建公网入口。HTTP 未加密，访客系统通知不可用。'
    : '使用现有公网分享方式，同事可通过公网邀请加入。');
  const note = !network ? '正在读取访问范围…'
    : !network.configurable ? '访问范围由启动参数管理，请退出后调整启动参数。'
    : networkWorkBusy() || connectionAction || lastState.connection?.state === 'connecting' ? '网络操作进行中，请稍候…'
    : busyThreadId || lastState.rooms.some(room => room.state !== 'revoked') ? '请先结束所有共享，再更改访问范围。'
    : networkDirty ? '尚未保存，当前邀请仍沿用已保存的访问范围。'
    : '保存后用于新邀请并保留。模型与工具的网络访问沿用原会话。';
  $('#network-note').textContent = t(note); $('#network-status').textContent = t(networkStatus);
}
$('#intranet-only').onchange = () => {
  if (networkChangeBlocked()) { renderNetwork(); return; }
  networkDraft.intranetOnly = $('#intranet-only').checked; networkDirty = true; networkStatus = ''; renderNetwork();
};
$('#lan-address').onchange = () => {
  if (networkChangeBlocked()) { renderNetwork(); return; }
  networkDraft.lanAddress = $('#lan-address').value; networkDirty = true; networkStatus = ''; renderNetwork();
};
$('#save-network').onclick = () => {
  if (networkChangeBlocked() || !networkDirty) return;
  if (networkDraft.intranetOnly && !(lastState.network.interfaces ?? []).some(item => item.address === networkDraft.lanAddress)) {
    networkStatus = '请选择当前可用的内网地址。'; renderNetwork(); $('#lan-address').focus(); return;
  }
  networkSaving = true; networkStatus = '正在保存…'; renderRooms(lastState); updateShare();
  send({ type: 'set-network-mode', intranetOnly: networkDraft.intranetOnly,
    ...(networkDraft.intranetOnly ? { lanAddress: networkDraft.lanAddress } : {}) });
};
const updateProfileName = () => { $('#profile-name').textContent = $('#owner-name').value.trim() || t('前往设置填写名称'); };
$('#owner-name').oninput = () => {
  ownerNameEdited = true; updateProfileName();
  nameHint = '使用你填写的名称为新共享署名，1–40 个字符。'; $('#name-hint').textContent = t(nameHint);
};
// Only a display-name suggestion, never an identity or an account capability.
// A delayed native suggestion must not replace anything the user has edited.
window.setCo2SuggestedName = name => {
  if (ownerNameEdited || $('#owner-name').value.trim() || typeof name !== 'string') return;
  const trimmed = name.trim();
  if (!trimmed || [...trimmed].length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return;
  $('#owner-name').value = trimmed; updateProfileName();
  nameHint = '已使用 macOS 用户名称，可自由修改；用于新共享的消息署名。'; $('#name-hint').textContent = t(nameHint);
};
$('#require-approval').onchange = () => {
  $('#policy-summary').textContent = t($('#require-approval').checked ? '新消息经你确认后交给 Agent' : '加入后，消息直接交给 Agent');
};
const updateShare = () => {
  $('#share').disabled = ws.readyState !== WebSocket.OPEN || !selectedThreadId || Boolean(busyThreadId) || Boolean(pendingInviteLifetime) || networkWorkBusy();
  $('#menu-share').disabled = ws.readyState !== WebSocket.OPEN || Boolean(busyThreadId) || Boolean(pendingInviteLifetime) || networkWorkBusy();
  $('#share').textContent = t(busyThreadId ? '正在生成邀请…' : '生成邀请 ↗');
  $('#invite-lifetime-confirm').disabled = disconnected || ws.readyState !== WebSocket.OPEN || Boolean(busyThreadId) || networkWorkBusy() || Boolean(connectionAction) || lastState?.connection?.state === 'connecting';
  renderNetwork();
};
const closeMenu = () => { $('#thread-menu').hidden = true; menuThreadId = ''; };
function selectThread(id) {
  selectedThreadId = id;
  for (const row of renderedThreadRows) {
    row.dataset.selected = String(row.dataset.threadId === id);
    row.firstElementChild?.setAttribute('aria-pressed', String(row.dataset.threadId === id));
  }
  updateSelection();
  updateShare();
}
function updateSelection() {
  const thread = threads.find(t => t.id === selectedThreadId);
  $('#selected-title').textContent = thread?.name || t('选择一条会话');
  $('#selected-project').textContent = thread?.cwd || t(thread ? 'Codex 会话' : '从左侧选择你想一起推进的工作。');
  $('#selected-project').setAttribute('title', thread?.cwd || '');
}
function openMenu(event, id) {
  event.preventDefault(); selectThread(id); menuThreadId = id;
  const menu = $('#thread-menu'); menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(event.clientX || 24, window.innerWidth - 170))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY || 80, window.innerHeight - 60))}px`;
  $('#menu-share').focus();
}
function renderThreads() {
  const projects = new Map();
  for (const thread of threads) {
    const key = thread.cwd ? thread.cwd.replace(/\/+$/, '') || '/' : '';
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(thread);
  }
  renderedThreadRows = [];
  const groups = [...projects].map(([cwd, projectThreads], index) => {
    const container = el('div', null, 'project-group'); container.setAttribute('role', 'listitem');
    const projectName = cwd.split('/').filter(Boolean).at(-1) || t(cwd ? '根目录' : '未归属项目');
    const rows = el('div', null, 'project-threads'); rows.id = `project-threads-${index}`; rows.setAttribute('role', 'list');
    rows.setAttribute('aria-label', t('{project} 的会话', { project: projectName }));
    rows.hidden = (search ? searchCollapsedProjects : collapsedProjects).has(cwd);
    const heading = button('', () => {
      closeMenu(); rows.hidden = !rows.hidden;
      const collapsed = search ? searchCollapsedProjects : collapsedProjects;
      if (rows.hidden) collapsed.add(cwd); else collapsed.delete(cwd);
      heading.setAttribute('aria-expanded', String(!rows.hidden));
    }, 'project-heading');
    heading.setAttribute('aria-expanded', String(!rows.hidden));
    heading.setAttribute('aria-controls', rows.id);
    heading.setAttribute('aria-label', t('{project}，已加载 {count} 条会话，{path}', { project: projectName, count: projectThreads.length, path: cwd || t('无项目路径') }));
    const chevron = el('span', '›', 'project-chevron'); chevron.setAttribute('aria-hidden', 'true');
    const identity = el('span', null, 'project-identity');
    identity.append(el('strong', projectName), el('span', cwd || t('无项目路径'), 'project-path'));
    const count = el('span', projectThreads.length, 'project-count'); count.setAttribute('title', t('此项目已加载的会话数'));
    heading.append(chevron, identity, count);
    for (const thread of projectThreads) {
      const row = el('div', null, 'thread-row'); row.dataset.threadId = thread.id; row.dataset.selected = String(thread.id === selectedThreadId); row.setAttribute('role', 'listitem');
      const pick = button('', () => selectThread(thread.id), 'thread-pick');
      const mark = el('span', '>_', 'thread-mark'); mark.setAttribute('aria-hidden', 'true');
      const info = el('span', null, 'thread-info'); info.append(el('strong', thread.name));
      const project = thread.cwd?.split('/').filter(Boolean).at(-1) || 'Codex';
      const path = el('span', project, 'thread-path'); path.setAttribute('title', thread.cwd || 'Codex'); info.append(path);
      pick.append(mark, info);
      if (thread.updatedAt) {
        const date = el('span', new Date(thread.updatedAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }), 'thread-date');
        date.setAttribute('title', new Date(thread.updatedAt).toLocaleString(i18n.language)); pick.append(date);
      }
      pick.setAttribute('aria-label', t('选择会话：{title}', { title: thread.name }));
      pick.setAttribute('aria-pressed', String(thread.id === selectedThreadId));
      const more = button('⋯', event => openMenu(event, thread.id), 'thread-more'); more.setAttribute('aria-label', t('会话操作：{title}', { title: thread.name }));
      row.oncontextmenu = event => openMenu(event, thread.id);
      row.onkeydown = event => { if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) openMenu(event, thread.id); };
      row.append(pick, more); rows.append(row); renderedThreadRows.push(row);
    }
    container.append(heading, rows); return container;
  });
  $('#threads').replaceChildren(...(groups.length ? groups : [el('p', t(search ? '没有匹配的会话' : '暂无可分享的会话'), 'catalog-empty')]));
  $('#load-more').hidden = nextCursor === null; updateSelection(); updateShare();
}
const inviteLifetimeValues = ['1h', '1d', '7d', 'permanent'];
const selectedInviteLifetime = () => inviteLifetimeValues.find(value => $(`#invite-lifetime-${value}`).checked);
function renderInviteLifetimeHint() {
  $('#invite-lifetime-hint').textContent = t(selectedInviteLifetime() === 'permanent'
    ? '不设固定到期时间；停止共享会撤销邀请。重启恢复取决于后台运行设置及原地址是否可用。'
    : '到期后自动结束共享，已加入的访客也会断开。');
}
function cancelInviteLifetime() {
  const pending = pendingInviteLifetime;
  pendingInviteLifetime = null;
  if ($('#invite-lifetime-dialog').open) $('#invite-lifetime-dialog').close();
  updateShare();
  pending?.trigger?.focus();
}
function createInvite(request) {
  busyThreadId = request.threadId; updateShare();
  notice(request.type === 'reshare' ? '正在重新分享，完成后将复制新邀请…' : '正在接入所选会话并生成邀请…');
  send(request);
}
function chooseInviteLifetime(request) {
  if (!intranetMode()) { createInvite(request); return; }
  pendingInviteLifetime = { request, lanAddress: lastState.network.lanAddress,
    activeRoomIds: new Set(lastState.rooms.filter(room => room.threadId === request.threadId && room.state !== 'revoked').map(room => room.roomId)),
    trigger: document.activeElement?.id === 'menu-share' ? $('#share') : document.activeElement };
  for (const value of inviteLifetimeValues) $(`#invite-lifetime-${value}`).checked = value === '1h';
  renderInviteLifetimeHint(); updateShare();
  $('#invite-lifetime-dialog').showModal(); $('#invite-lifetime-1h').focus();
}
for (const value of inviteLifetimeValues) $(`#invite-lifetime-${value}`).onchange = renderInviteLifetimeHint;
$('#invite-lifetime-cancel').onclick = cancelInviteLifetime;
$('#invite-lifetime-dialog').oncancel = event => { event.preventDefault(); cancelInviteLifetime(); };
$('#invite-lifetime-dialog').onclose = () => { if (pendingInviteLifetime && !$('#invite-lifetime-dialog').open) cancelInviteLifetime(); };
$('#invite-lifetime-confirm').onclick = () => {
  if (!pendingInviteLifetime || !intranetMode() || disconnected || ws.readyState !== WebSocket.OPEN || busyThreadId
    || networkWorkBusy() || connectionAction || lastState?.connection?.state === 'connecting') return;
  const inviteLifetime = selectedInviteLifetime();
  if (!inviteLifetimeValues.includes(inviteLifetime)) return;
  const request = { ...pendingInviteLifetime.request, inviteLifetime };
  cancelInviteLifetime(); createInvite(request);
};
function shareThread(id) {
  closeMenu();
  if (busyThreadId || pendingInviteLifetime || networkWorkBusy() || ws.readyState !== WebSocket.OPEN || !threads.some(t => t.id === id)) return;
  selectThread(id);
  const ownerName = $('#owner-name').value.trim();
  if (!ownerName || [...ownerName].length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test($('#owner-name').value)) {
    notice('请先设置 1–40 个字符的显示名称。', 'error'); selectTab('settings'); $('#owner-name').focus(); return;
  }
  chooseInviteLifetime({ type: 'share', threadId: id, ownerName, requireApproval: $('#require-approval').checked });
}
let copySequence = 0, pendingInviteCopy = null;
function manualInviteCopy(url, input) {
  const current = [...invitationInputs.values()].find(candidate => candidate.value === url) ?? input;
  current?.focus(); current?.select(); notice('请手动复制链接');
}
window.co2InviteCopyResult = result => {
  if (!result || typeof result.requestId !== 'string' || typeof result.ok !== 'boolean'
    || result.requestId !== pendingInviteCopy?.requestId) return;
  const pending = pendingInviteCopy; pendingInviteCopy = null; clearTimeout(pending.timer);
  if (result.ok) notice('邀请链接已复制');
  else manualInviteCopy(pending.url, pending.input);
};
function copyInvite(url, input) {
  if (pendingInviteCopy) { clearTimeout(pendingInviteCopy.timer); pendingInviteCopy = null; }
  if (window.webkit?.messageHandlers?.copyInvite) {
    const requestId = `copy-${++copySequence}`;
    pendingInviteCopy = { requestId, url, input, timer: setTimeout(() => {
      if (pendingInviteCopy?.requestId !== requestId) return;
      pendingInviteCopy = null; manualInviteCopy(url, input);
    }, 3000) };
    notice('正在复制邀请…');
    try { window.webkit.messageHandlers.copyInvite.postMessage({ requestId, url }); }
    catch { window.co2InviteCopyResult({ requestId, ok: false }); }
    return;
  }
  if (!navigator.clipboard) { manualInviteCopy(url, input); return; }
  navigator.clipboard.writeText(url).then(() => notice('邀请链接已复制')).catch(() => manualInviteCopy(url, input));
}
function reshare(threadId) {
  if (busyThreadId || pendingInviteLifetime || networkWorkBusy() || disconnected || ws.readyState !== WebSocket.OPEN || connectionAction || lastState?.connection?.state === 'connecting') return;
  chooseInviteLifetime({ type: 'reshare', threadId });
}
function reshareButton(threadId, cls) {
  const connecting = lastState?.connection?.state === 'connecting';
  const label = connectionAction === 'rebuild' ? '入口重建中，稍后可重新分享…'
    : connecting ? '入口建立中，稍后可重新分享…'
    : connectionAction === 'check' ? '正在检查连接，请稍候…' : '重新分享并复制邀请';
  const restore = button(label, () => reshare(threadId), cls);
  restore.disabled = disconnected || Boolean(busyThreadId) || Boolean(pendingInviteLifetime) || Boolean(connectionAction) || networkWorkBusy() || connecting;
  restore.setAttribute('aria-busy', String(Boolean(connectionAction) || connecting));
  return restore;
}
function renderHistory(m) {
  const activeIds = new Set(m.rooms.filter(room => room.state !== 'revoked').map(room => room.threadId));
  const entries = (m.history ?? []).filter(entry => !activeIds.has(entry.threadId));
  if (!entries.length) return;
  const section = el('section', null, 'share-history');
  section.append(el('h2', t('分享历史')), el('p', t('重新分享会生成新邀请；有效的个人恢复凭据可沿用准入，停止共享或移除后失效。'), 'muted'));
  for (const entry of entries) {
    const row = el('div', null, 'history-entry'), info = el('div');
    info.append(el('strong', entry.title), el('p', t('未共享 · 旧邀请已失效'), 'muted'),
      el('p', t('上次分享：{time}', { time: new Date(entry.lastSharedAt).toLocaleString(i18n.language) }), 'muted'),
      el('p', t(entry.requireApproval ? '新消息需逐条确认' : '新消息直接交给 Agent'), 'muted'));
    const restore = reshareButton(entry.threadId, 'primary');
    row.append(info, restore); section.append(row);
  }
  $('#rooms').append(section);
}
const recoveryLabels = {
  pending: '等待处理', processing: '正在恢复邀请…', failed: '恢复未完成', approved: '已同意恢复',
  rejected: '已拒绝恢复', expired: '申请已到期', unavailable: '申请已失效',
};
function recoveryActionBlocked(type, request) {
  return disconnected || ws.readyState !== WebSocket.OPEN || recoveryDecisions.has(request.requestId)
    || !['pending', 'failed'].includes(request.status) || request.expiresAt <= Date.now()
    || (type === 'approve-recovery' && (networkWorkBusy() || Boolean(connectionAction) || Boolean(busyThreadId)
      || Boolean(pendingInviteLifetime) || lastState?.connection?.state === 'connecting'));
}
function decideRecovery(type, requestId) {
  const request = (lastState?.recoveryRequests ?? []).find(item => item.requestId === requestId);
  if (!request || recoveryActionBlocked(type, request)) return;
  recoveryDecisions.set(requestId, type);
  send({ type, requestId });
  renderRooms(lastState);
}
function renderRecoveryRequests(m) {
  const requests = m.recoveryRequests ?? [];
  if (!requests.length) return false;
  const section = el('section', null, 'invite-recovery-requests');
  section.setAttribute('aria-label', t('邀请恢复申请'));
  const title = el('h2', t('邀请恢复申请'));
  title.append(el('span', requests.length, 'count'));
  section.append(title, el('p', t('同意会更新邀请，并允许本次申请者加入；不会向其他旧链接持有人开放访问。'), 'muted'));
  for (const request of requests) {
    const card = el('div', null, 'card invite-recovery'), heading = el('div', null, 'card-heading');
    card.dataset.state = request.status;
    attentionTargets.set(`${request.roomId}:invite-recovery:${request.requestId}`, card);
    const status = el('span', t(recoveryLabels[request.status] ?? '申请已失效'), 'badge');
    status.dataset.state = request.status;
    heading.append(el('strong', request.name), status);
    card.append(heading, el('p', t('申请者填写的昵称，身份未经核验。'), 'muted'),
      el('p', request.title, 'recovery-thread'),
      el('p', t('申请时间：{time}', { time: new Date(request.createdAt).toLocaleString(i18n.language) }), 'muted'),
      el('p', t('申请有效至：{time}', { time: new Date(request.expiresAt).toLocaleString(i18n.language) }), 'muted'));
    if (request.status === 'failed') card.append(el('p', t('恢复尚未完成，请检查连接后重试；不会自动重新分享。'), 'muted'));
    if (request.status === 'approved') card.append(el('p', t('已向本次申请者提供有效邀请并允许加入。'), 'muted'));
    if (['pending', 'failed'].includes(request.status)) {
      const row = el('div', null, 'row');
      const approve = button(request.status === 'failed' ? '重试并同意' : '同意并允许加入', () => decideRecovery('approve-recovery', request.requestId), 'primary');
      const reject = button('拒绝', () => decideRecovery('reject-recovery', request.requestId));
      approve.disabled = recoveryActionBlocked('approve-recovery', request);
      reject.disabled = recoveryActionBlocked('reject-recovery', request);
      approve.setAttribute('aria-busy', String(recoveryDecisions.get(request.requestId) === 'approve-recovery'));
      reject.setAttribute('aria-busy', String(recoveryDecisions.get(request.requestId) === 'reject-recovery'));
      row.append(approve, reject); card.append(row);
    }
    section.append(card);
  }
  $('#rooms').append(section);
  return true;
}
const connectionLabels = {
  recovering: '公网连接波动，正在检查；暂不更换链接',
  unavailable: '当前网络无法访问公网入口。请先检查连接；重建会使旧邀请失效。',
  stopped: '隧道已退出，旧邀请已停止。请重建入口后重新分享。',
};
const intranetConnectionLabels = {
  recovering: '内网连接波动，正在检查；暂不更换链接',
  unavailable: '当前内网入口不可用，请检查所选网络地址和网络连接。',
  stopped: '内网入口已停止，请检查网络后更新入口并重新分享。',
};
function renderConnection(m) {
  const state = m.connection?.state;
  const rebuilding = connectionAction === 'rebuild';
  const labels = intranetMode() ? intranetConnectionLabels : connectionLabels;
  if (!labels[state]) rebuildArmed = false;
  $('#public-connection').hidden = !labels[state] && !rebuilding;
  $('#public-connection').dataset.state = state || '';
  $('#public-status').textContent = t(rebuilding
    ? intranetMode() ? '内网入口更新中，稍后可重新分享…' : '入口重建中，稍后可重新分享…' : labels[state] || '');
  $('#check-connection').disabled = disconnected || networkWorkBusy() || Boolean(connectionAction) || state === 'connecting';
  const checkLabel = connectionAction === 'check' ? '正在检查…' : '检查连接';
  $('#check-connection').setAttribute('data-i18n', checkLabel);
  $('#check-connection').textContent = t(checkLabel);
  $('#check-connection').setAttribute('aria-busy', String(connectionAction === 'check'));
  $('#rebuild-relay').disabled = disconnected || networkWorkBusy() || Boolean(connectionAction) || Boolean(busyThreadId) || state === 'connecting';
  const rebuildLabel = intranetMode()
    ? rebuilding ? '正在更新…' : rebuildArmed ? '确认更新（旧邀请将失效）' : '更新内网入口…'
    : rebuilding ? '正在重建…' : rebuildArmed ? '确认重建（旧邀请将失效）' : '重建入口…';
  $('#rebuild-relay').setAttribute('data-i18n', rebuildLabel);
  $('#rebuild-relay').textContent = t(rebuildLabel);
  $('#rebuild-relay').setAttribute('aria-busy', String(rebuilding));
}
$('#check-connection').onclick = () => {
  if (disconnected || networkWorkBusy() || connectionAction || lastState?.connection?.state === 'connecting') return;
  connectionAction = 'check'; if (lastState) renderRooms(lastState);
  notice(intranetMode() ? '正在检查内网连接…' : '正在检查公网连接…'); send({ type: 'check-connection' });
};
$('#rebuild-relay').onclick = () => {
  if (disconnected || networkWorkBusy() || connectionAction || busyThreadId || lastState?.connection?.state === 'connecting') return;
  if (!rebuildArmed) { rebuildArmed = true; renderConnection(lastState ?? {}); return; }
  rebuildArmed = false; connectionAction = 'rebuild'; if (lastState) renderRooms(lastState);
  notice(intranetMode() ? '内网入口更新中，稍后可重新分享…' : '入口重建中，稍后可重新分享…'); send({ type: 'rebuild-relay' });
};
ws.onopen = () => {
  if (!token) { notice('缺少本机管理凭据，请重新打开助手生成的管理链接。', 'error'); ws.close(); return; }
  send({ type: 'auth', token }); send({ type: 'threads' }); notice('本地助手已连接'); updateShare();
};
const disableDisconnectedControls = () => {
  document.querySelectorAll('button').forEach(b => {
    if (b.getAttribute('role') !== 'tab' && b.getAttribute('aria-expanded') == null && !['new-share', 'empty-browse', 'edit-profile', 'edit-policy', 'check-update', 'check-again', 'cancel-update', 'about-repository', 'about-releases', 'about-star-link', 'dismiss-star', 'background-system-settings'].includes(b.id)) b.disabled = true;
  });
};
ws.onclose = () => {
  disconnected = true; closeMenu(); cancelInviteLifetime(); notice('本地助手已断开，请从菜单栏重新连接。', 'error');
  renderNetwork();
  disableDisconnectedControls();
};
ws.onerror = () => notice('无法连接本地助手', 'error');
$('#refresh').onclick = () => send({ type: 'threads', search });
$('#load-more').onclick = () => { if (nextCursor !== null) send({ type: 'threads', search, cursor: nextCursor }); };
$('#thread-search').oninput = () => {
  search = $('#thread-search').value.trim(); searchCollapsedProjects.clear(); clearTimeout(searchTimer); closeMenu();
  searchTimer = setTimeout(() => send({ type: 'threads', search }), 200);
};
$('#share').onclick = () => shareThread(selectedThreadId);
$('#menu-share').onclick = () => shareThread(menuThreadId);
document.addEventListener('pointerdown', event => { if (!$('#thread-menu').contains(event.target)) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);
function group(title, items, render, emptyText) {
  const container = el('div', null, 'group');
  const heading = el('h3', t(title), 'group-title'); heading.append(el('span', items.length, 'count')); container.append(heading);
  if (items.length) container.append(...items.map(render));
  else container.append(el('p', t(emptyText), 'group-empty'));
  return container;
}
function guestCard(room, guest) {
  const card = el('div', null, 'card guest'), heading = el('div', null, 'card-heading');
  attentionTargets.set(`${room.roomId}:guest:${guest.id}`, card);
  const avatar = el('span', [...guest.name][0], 'avatar'); avatar.setAttribute('aria-hidden', 'true');
  heading.append(avatar, el('strong', guest.name), badge(guest.status));
  const row = el('div', null, 'row');
  if (guest.status === 'pending') row.append(
    button('允许加入', () => send({ type: 'admit', roomId: room.roomId, guestId: guest.id }), 'primary'),
    button('拒绝', () => send({ type: 'deny', roomId: room.roomId, guestId: guest.id })));
  else row.append(button('移除访客', () => send({ type: 'remove-guest', roomId: room.roomId, guestId: guest.id }), 'danger'));
  card.append(heading, row); return card;
}
function proposalCard(room, proposal) {
  const card = el('div', null, 'card proposal'), heading = el('div', null, 'card-heading');
  for (const kind of ['proposal', 'unknown']) attentionTargets.set(`${room.roomId}:${kind}:${proposal.id}`, card);
  card.dataset.state = proposal.status;
  heading.append(el('strong', t('{name} 的建议', { name: proposal.name })), badge(proposal.status)); card.append(heading);
  if (proposal.text) card.append(el('pre', proposal.text, 'text'));
  if (proposal.status === 'pending') {
    const row = el('div', null, 'row'); row.append(
      button('确认并交给 Agent', () => send({ type: 'approve', roomId: room.roomId, proposalId: proposal.id }), 'primary'),
      button('不采纳', () => send({ type: 'reject', roomId: room.roomId, proposalId: proposal.id })));
    card.append(row);
  }
  if (proposal.status === 'unknown') card.append(el('p', t('提交结果不确定。请在 Codex 确认是否已执行；不会自动重试。'), 'muted'));
  return card;
}
ws.onmessage = event => {
  let m; try { m = JSON.parse(event.data); } catch { return; }
  if (m.type === 'error') {
    if (['approve-recovery', 'reject-recovery'].includes(m.operation)) {
      for (const [requestId, operation] of recoveryDecisions) if (operation === m.operation) recoveryDecisions.delete(requestId);
    }
    if (['share', 'reshare'].includes(m.operation)) { busyThreadId = ''; updateShare(); }
    if (['check-connection', 'rebuild-relay'].includes(m.operation)) connectionAction = '';
    if (m.operation === 'set-network-mode') { networkSaving = false; networkStatus = '访问范围未能保存，请重试。'; }
    if (lastState) renderRooms(lastState);
    if (m.operation === 'set-share-limit') { shareLimitSaving = false; shareLimitStatus = '共享上限未能保存，请重试。'; }
    if (m.code === 'SHARE_LIMIT_REACHED') shareLimitAlert = { limit: m.values.limit };
    renderShareLimit(); notice(m.message, 'error', m.values ?? {}); return;
  }
  if (m.type === 'recovery-result') {
    recoveryDecisions.delete(m.requestId);
    if (lastState) renderRooms(lastState);
    notice('邀请恢复申请已处理'); return;
  }
  if (m.type === 'settings-result') {
    shareLimitDirty = false; shareLimitSaving = false; shareLimitAlert = null; shareLimitStatus = '共享上限已保存';
    renderShareLimit(m.settings); notice('共享上限已保存'); return;
  }
  if (m.type === 'network-result') {
    networkDirty = false; networkSaving = false; networkDraft = null; networkStatus = '访问范围已保存';
    if (lastState) { lastState = { ...lastState, network: m.network }; renderRooms(lastState); }
    notice('访问范围已保存'); return;
  }
  if (m.type === 'connection-result') {
    connectionAction = ''; if (lastState) renderRooms(lastState);
    if (m.rebuilt) notice(intranetMode() ? '内网入口已更新，请重新分享并发送新邀请' : '入口已重建，请从分享历史重新分享并发送新邀请');
    else if (['online', 'local'].includes(lastState?.connection?.state)) notice(intranetMode() ? '检查完成，内网入口连接正常' : '检查完成，公网入口连接正常');
    else notice(intranetMode() ? '检查完成，内网入口仍不可用，请检查网络或更新入口。' : '检查完成，公网入口仍不可用，请检查网络或重建入口。', 'error');
    return;
  }
  if (m.type === 'share-result') {
    shareLimitAlert = null; renderShareLimit();
    busyThreadId = ''; updateShare(); if (lastState) renderRooms(lastState);
    selectTab('shared', true); $('#rooms').scrollTop = 0; notice('邀请已生成，可以发送给同伴');
    const room = lastState?.rooms.find(room => room.roomId === m.roomId && room.state !== 'revoked');
    if (m.restored && room) copyInvite(room.inviteUrl, invitationInputs.get(room.roomId));
    return;
  }
  if (m.type === 'threads') {
    if ((m.search ?? '') !== search) return;
    const existing = m.cursor ? threads : [];
    threads = [...new Map([...existing, ...m.threads].map(t => [t.id, t])).values()];
    nextCursor = m.nextCursor ?? null;
    if (!threads.some(t => t.id === selectedThreadId)) selectedThreadId = threads[0]?.id ?? '';
    closeMenu(); renderThreads(); $('#thread-count').textContent = m.total ?? threads.length;
    lastAttached = Boolean(m.attached); updateThreadHint();
    if (!busyThreadId) notice(m.attached ? '日常 Codex 会话列表已更新' : '会话列表已更新');
    return;
  }
  if (m.type !== 'state') return;
  if (!nativeUpdates && m.appInfo) { appInfo = m.appInfo; renderAbout(); }
  renderRooms(m);
};
function renderRooms(m) {
  lastState = m;
  for (const requestId of recoveryDecisions.keys()) {
    const request = (m.recoveryRequests ?? []).find(item => item.requestId === requestId);
    if (!request || !['pending', 'failed'].includes(request.status)) recoveryDecisions.delete(requestId);
  }
  if (pendingInviteLifetime && (!intranetMode() || pendingInviteLifetime.lanAddress !== m.network.lanAddress)) {
    cancelInviteLifetime(); notice('访问范围已变更，请重新生成邀请。');
  }
  if (pendingInviteLifetime && m.rooms.some(room => room.threadId === pendingInviteLifetime.request.threadId && room.state !== 'revoked' && !pendingInviteLifetime.activeRoomIds.has(room.roomId))) {
    cancelInviteLifetime(); notice('此会话已在共享，请在「共享会话」中查看邀请。');
  }
  updateShare();
  renderShareLimit(m.settings);
  attentionTargets.clear(); renderAttention(m);
  renderConnection(m);
  $('#rooms').replaceChildren();
  invitationInputs.clear();
  $('#room-policies').replaceChildren();
  const active = m.rooms.filter(room => room.state !== 'revoked');
  $('#room-count').textContent = active.length;
  $('#active-count').textContent = active.length;
  $('#guest-count').textContent = active.reduce((n, room) => n + room.guests.filter(guest => guest.status === 'admitted').length, 0);
  const pending = active.reduce((n, room) => n + room.guests.filter(guest => guest.status === 'pending').length + room.proposals.filter(p => p.status === 'pending').length, 0)
    + (m.recoveryRequests ?? []).filter(request => ['pending', 'failed'].includes(request.status)).length;
  $('#nav-pending').textContent = pending;
  $('#nav-pending').hidden = pending === 0;
  if (!active.length) $('#room-policies').append(el('p', t('暂无正在共享的会话。'), 'muted'));
  $('#workspace').dataset.sharing = m.rooms.some(room => room.state !== 'revoked') ? 'true' : 'false';
  const hasRecoveryRequests = renderRecoveryRequests(m);
  const visible = m.rooms.filter(room => room.state !== 'revoked' || (m.attention ?? []).some(item => item.roomId === room.roomId));
  if (!visible.length) {
    if (!hasRecoveryRequests) {
      $('#rooms').append(emptyState.cloneNode(true)); i18n.apply();
      $('#empty-browse').onclick = () => selectTab('sessions', true);
    }
    renderHistory(m);
    if (m.historyFailed) $('#rooms').append(el('p', t('分享历史未能保存，请检查本机运行目录权限。'), 'muted'));
    if (m.authorHistoryFailed) $('#rooms').append(el('p', t('消息作者信息未能保存，重新分享后部分署名可能无法恢复。'), 'muted'));
    return;
  }
  for (const room of visible) {
    const section = el('section', null, 'room'), heading = el('div', null, 'room-heading'), title = el('div'), identity = el('div', null, 'room-identity');
    attentionTargets.set(room.roomId, section);
    section.dataset.state = room.state;
    const mark = el('span', '↗', 'session-icon'); mark.setAttribute('aria-hidden', 'true');
    title.append(el('h2', room.title), el('p', t('分享者：{name}', { name: room.ownerName || t('分享者') }), 'muted'));
    identity.append(mark, title); heading.append(identity);
    if (room.state === 'revoked') {
      const actions = el('div', null, 'row');
      actions.append(badge(room.state), button('我知道了', () => send({ type: 'dismiss-room', roomId: room.roomId })));
      heading.append(actions);
    } else heading.append(badge(room.state));
    section.append(heading);
    if (room.state !== 'revoked') {
      const invite = el('div', null, 'invite'), row = el('div', null, 'invite-row');
      const link = el('input', null, 'link'); link.value = room.inviteUrl; link.readOnly = true; link.setAttribute('aria-label', t('访客邀请链接'));
      invitationInputs.set(room.roomId, link);
      row.append(link, button('复制邀请', () => copyInvite(room.inviteUrl, link)), button('停止共享', () => send({ type: 'revoke', roomId: room.roomId }), 'danger'));
      if (room.state === 'offline') {
        invite.append(el('p', t('连接中断，正在恢复原邀请；也可重新分享，新邀请需重新发送。'), 'muted'));
        if (room.threadId && (m.history ?? []).some(entry => entry.threadId === room.threadId)) {
          row.append(reshareButton(room.threadId));
        }
      }
      const policyRow = el('div', null, 'policy-row'), policyTitle = el('div');
      policyTitle.append(el('strong', room.title), el('p', t(room.requireApproval ? '新消息需逐条确认' : '新消息直接交给 Agent'), 'muted'));
      const policy = button(room.requireApproval ? '消息审批：已开启' : '消息审批：已关闭', () => send({ type: 'set-message-policy', roomId: room.roomId, requireApproval: !room.requireApproval }), 'policy-toggle');
      policy.setAttribute('aria-pressed', String(Boolean(room.requireApproval)));
      policy.setAttribute('aria-label', t('{title}：{action}消息审批', { title: room.title, action: t(room.requireApproval ? '关闭' : '开启') }));
      policy.disabled = room.state !== 'online';
      policyRow.append(policyTitle, policy); $('#room-policies').append(policyRow);
      invite.append(row);
      if (room.intranetOnly === true) {
        invite.append(el('p', room.inviteExpiresAt === null
          ? t('不设固定到期时间 · 包含本会话中已展示的文本记录')
          : t('有效至 {time} · 到期后自动结束共享', { time: new Date(room.inviteExpiresAt).toLocaleString(i18n.language) }), 'muted'));
        if (room.inviteExpiresAt === null) invite.append(el('p', t('不设固定到期时间；停止共享会撤销邀请。重启恢复取决于后台运行设置及原地址是否可用。'), 'muted'));
      } else {
        invite.append(el('p', t('有效至 {time} · 包含本会话中已展示的文本记录', { time: new Date(room.expiresAt).toLocaleTimeString(i18n.language) }), 'muted'));
        if (room.renewalSupported === true) invite.append(el('p', t('连接正常时自动续期'), 'muted'));
        else if (room.renewalSupported === false) invite.append(el('p', t('当前中继不支持自动续期'), 'muted'));
      }
      section.append(invite);
    }
    const body = el('div', null, 'room-body');
    body.append(group('访客', room.guests, guest => guestCard(room, guest), room.state === 'revoked' ? '访客访问已结束' : '等待访客申请加入'), group('协作建议', [...room.proposals].reverse(), p => proposalCard(room, p), room.state === 'revoked' ? '此共享已结束' : room.requireApproval ? '新消息需你逐条确认后交给 Agent。' : '新消息直接交给 Agent；切换前待审批的消息仍需逐条确认。'));
    section.append(body);
    if (room.approvalPending) {
      const tool = el('p', t('Codex 发起了工具审批，请在原生 Desktop 中处理。'), 'tool-notice');
      attentionTargets.set(`${room.roomId}:tool:tool`, tool); section.append(tool);
    }
    if (room.endReason === 'expired') section.append(el('p', t('邀请已到期，请从分享历史重新分享。'), 'tool-notice'));
    if (room.lastError) section.append(el('p', t(room.lastError), 'tool-notice'));
    $('#rooms').append(section);
  }
  renderHistory(m);
  if (m.historyFailed) $('#rooms').append(el('p', t('分享历史未能保存，请检查本机运行目录权限。'), 'muted'));
  if (m.authorHistoryFailed) $('#rooms').append(el('p', t('消息作者信息未能保存，重新分享后部分署名可能无法恢复。'), 'muted'));
};

function updateThreadHint() {
  if (lastAttached === undefined) return;
  $('#thread-hint').textContent = lastAttached
    ? t('已加载 {count} 条会话，按项目分组。右键分享后自动接入；新会话先正常发出首条消息。', { count: threads.length })
    : t('独立实验环境中的会话。右键选择「分享会话」。');
}
function updateLanguage() {
  i18n.apply(); $('#language').value = i18n.language;
  selectTab(activeTab); updateProfileName(); $('#name-hint').textContent = t(nameHint);
  $('#require-approval').onchange(); updateShare(); updateThreadHint();
  renderInviteLifetimeHint();
  renderShareLimit();
  renderAbout();
  renderBackground();
  if (threads.length || lastAttached !== undefined) {
    const scroll = document.querySelector('.catalog-scroll'); const top = scroll?.scrollTop;
    renderThreads(); if (scroll) scroll.scrollTop = top;
  }
  if (lastState) { const top = $('#rooms').scrollTop; renderRooms(lastState); $('#rooms').scrollTop = top; }
  notice(noticeState.text, noticeState.tone, noticeState.values);
  if (disconnected) disableDisconnectedControls();
}
i18n.onChange(updateLanguage);
$('#language').onchange = () => {
  if (i18n.setLanguage($('#language').value)) window.webkit?.messageHandlers?.languagePreference?.postMessage(i18n.language);
};
updateLanguage();
