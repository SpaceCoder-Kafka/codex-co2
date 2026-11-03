// Legacy factory name; previews only use the admitted room socket.
window.createThreadImages = ({ send, canRead, capabilities = () => [] }) => {
  const states = new Map(), queue = [];
  const chunkChars = 40960, limits = { image: 8388608, video: 33554432, audio: 33554432, pdf: 33554432, xlsx: 33554432, docx: 33554432, pptx: 33554432, text: 33554432, table: 33554432, markdown: 33554432, download: 33554432, activity: 1048576 };
  const cacheLimit = 48 * 1024 * 1024;
  // Every admitted snapshot is smaller than 48 KiB and each opaque reference
  // alone contains 64 ASCII bytes. Metadata can therefore cover every entry in
  // any valid frame, independently of the much smaller source/decoded caches.
  const metadataLimit = Math.floor((48 * 1024 - 1) / 64), fallbackViews = new Set();
  let active = null, timer = null, cacheBytes = 0, expandedId = null, activityViewId = 0, usageSerial = 0, viewEpoch = 0;
  const dialog = document.createElement('dialog'); dialog.className = 'image-dialog'; dialog.setAttribute('aria-label', '图片预览');
  const toolbar = document.createElement('div'); toolbar.className = 'image-dialog-toolbar';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'image-dialog-close';
  close.setAttribute('aria-label', '关闭预览'); close.title = '关闭预览';
  const imageDownload = document.createElement('button'); imageDownload.type = 'button'; imageDownload.className = 'preview-download image-dialog-download';
  imageDownload.setAttribute('aria-label', '下载原图'); imageDownload.title = '下载原图'; imageDownload.disabled = true; imageDownload.hidden = true;
  const full = document.createElement('img'), caption = document.createElement('p');
  full.alt = ''; full.className = 'image-dialog-image'; caption.className = 'image-dialog-title';
  toolbar.append(caption, imageDownload, close); dialog.append(toolbar, full); document.body.append(dialog);
  const resetPreview = () => { expandedId = null; full.removeAttribute('src'); caption.textContent = ''; imageDownload.disabled = true; imageDownload.hidden = true; };
  const closePreview = () => { resetPreview(); if (dialog.open) dialog.close(); };
  close.addEventListener('click', closePreview);
  dialog.addEventListener('click', event => { if (event.target === dialog) closePreview(); });
  dialog.addEventListener('close', resetPreview);
  imageDownload.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation?.();
    const state = states.get(expandedId);
    if (!dialog.open || !state || state.kind !== 'image' || state.status !== 'ready') return;
    downloadOriginal(state);
  });
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target); enqueue(states.get(entry.target.dataset.imageId));
    }
  }, { rootMargin: '200px' }) : null;

  function release(state, status) {
    cacheBytes -= state.cost; state.cost = 0;
    const media = state.media; state.media = null;
    state.dispose?.(); state.dispose = null; state.preview?.remove();
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    if (['video', 'audio'].includes(state.kind) && state.url) URL.revokeObjectURL(state.url);
    state.url = null; state.text = null; state.bytes = null; state.preview = null; state.previewFailed = false; state.wasPlaying = false; state.openWhenReady = false; state.status = status;
    if (expandedId === state.id) closePreview();
    if (state.kind === 'image') syncImageFileViews(state.id);
  }
  function imageFileHidden(view) {
    const image = view.previewImageId && states.get(view.previewImageId);
    return image?.kind === 'image' && image.status === 'ready';
  }
  function syncImageFileViews(imageId) {
    for (const state of states.values()) for (const view of state.views) {
      if (view.previewImageId === imageId) view.figure.hidden = imageFileHidden(view);
    }
  }
  const evictionOrder = (a, b) => Number(a.views.length > 0) - Number(b.views.length > 0) || a.used - b.used;
  function metadataSlot() {
    if (states.size < metadataLimit) return true;
    const old = [...states.values()].filter(state => !state.views.length).sort(evictionOrder)[0];
    if (!old) return false;
    release(old, 'removed'); states.delete(old.id);
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index] === old.id) queue.splice(index, 1);
    if (active?.state === old) { window.clearTimeout(timer); timer = null; active = null; }
    return true;
  }
  function invalidateFallbacks() {
    viewEpoch++;
    for (const view of fallbackViews) { view.button.disabled = true; view.button.title = '此引用暂不可用'; }
    fallbackViews.clear();
  }
  const rich = state => !['image', 'audio', 'video', 'activity', 'download'].includes(state.kind) && (state.original || state.kind !== 'text');
  function discardRich(state) { state.dispose?.(); state.dispose = null; state.preview?.remove(); state.preview = null; }
  function mediaPreview(state) {
    state.used = ++usageSerial;
    if (state.preview) return state.preview;
    if (state.kind === 'activity') {
      const box = document.createElement('div'); box.className = 'activity-detail';
      try { state.dispose = renderActivity(box, JSON.parse(state.text), () => states.get(state.id) === state && state.preview === box && canRead()); } catch { box.textContent = '详情格式不受支持。'; }
      state.preview = box;
    } else if (state.kind === 'text' && !state.original) {
      const pre = document.createElement('pre'), code = document.createElement('code');
      pre.className = 'file-text-preview'; pre.setAttribute('tabindex', '0'); code.textContent = state.text || '（空文件）';
      pre.append(code); state.preview = pre;
    } else if (state.kind === 'video' || state.kind === 'audio') {
      const video = document.createElement(state.kind); video.controls = true; video.preload = 'metadata'; video.playsInline = true;
      video.className = 'file-video-preview'; video.setAttribute('aria-label', state.name); video.src = state.url;
      video.addEventListener('error', () => {
        if (state.media !== video) return;
        state.problem = '浏览器不支持此媒体编码或文件损坏，可下载原件查看。'; draw(state);
      });
      state.media = video; state.preview = video;
    } else {
      // Bound decoded resources as well as source-byte caching. Evicted rich
      // views retain their originals and can be reopened without another read.
      const decoded = [...states.values()].filter(old => old !== state && old.preview && rich(old)).sort(evictionOrder);
      while (decoded.length >= 2) { const old = decoded.shift(); discardRich(old); old.expanded = false; draw(old); }
      const box = document.createElement('div'); box.className = 'file-rich-preview'; box.textContent = '正在准备预览…'; state.preview = box; state.previewFailed = false;
      const current = () => states.get(state.id) === state && state.preview === box && canRead();
      const load = window.co2PreviewLoader || (() => import('/vendor/previews.mjs'));
      Promise.resolve().then(load).then(api => {
        if (!current()) return;
        return api.mountPreview({ container: box, bytes: state.bytes, name: state.name, kind: state.kind,
          mime: state.mime, renderMarkdown: window.renderMarkdown, isCurrent: current });
      }).then(result => { if (!current()) result?.dispose?.(); else state.dispose = result?.dispose; })
        .catch(() => { if (current()) { state.previewFailed = true; box.textContent = '此文件无法预览或超过预览预算，请下载原件查看。'; draw(state); } });
    }
    return state.preview;
  }
  function mediaMime(state) {
    const ext = state.name.split('.').pop().toLowerCase();
    return ({ mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' })[ext] || 'application/octet-stream';
  }
  function fileFormat(state) {
    const extension = state.name.split('.').at(-1).toUpperCase();
    return /^[A-Z0-9]{1,8}$/.test(extension) ? extension : '文件';
  }
  function fileFamily(state) {
    const format = fileFormat(state);
    return ['DOC', 'DOCX'].includes(format) ? 'word' : ['XLS', 'XLSX', 'CSV', 'TSV'].includes(format) ? 'spreadsheet'
      : ['PPT', 'PPTX'].includes(format) ? 'presentation' : format === 'PDF' ? 'pdf' : 'text';
  }
  function canDownload(state) { return !state.remoteUrl && (state.kind === 'image' || state.kind !== 'activity' && capabilities().includes('file-original')); }
  function downloadOriginal(state) {
    if (!canRead() || !canDownload(state)) return;
    let data = state.bytes;
    if (state.kind === 'image' && state.url?.startsWith('data:')) data = Uint8Array.from(atob(state.url.split(',')[1]), c => c.charCodeAt(0));
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = state.name.replace(/[\/\\\u0000-\u001f\u007f]/g, '_');
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openImage(state) {
    if (!canRead() || states.get(state.id) !== state || state.status !== 'ready' || state.kind !== 'image') return;
    state.used = ++usageSerial; expandedId = state.id; full.referrerPolicy = 'no-referrer'; full.src = state.url; full.alt = state.name; caption.textContent = state.name; dialog.showModal();
    const downloadable = canDownload(state); imageDownload.disabled = !downloadable; imageDownload.hidden = !downloadable;
  }
  function displayPath(path) {
    const value = String(path ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\\/g, '/');
    // Paths are display text only. Absolute paths from older hosts expose only
    // the basename; modern hosts provide a project-relative display path.
    if (/^(?:\/|~\/|[a-z][a-z0-9+.-]*:)/i.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) return value.split('/').filter(Boolean).at(-1) || '文件';
    return value.slice(-512) || '文件';
  }
  function diffSummary(summary) {
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000000;
    if (!summary || !['fileCount', 'added', 'removed', 'remaining'].every(key => count(summary[key])) || !Array.isArray(summary.files)) return null;
    return { fileCount: summary.fileCount, added: summary.added, removed: summary.removed, remaining: summary.remaining,
      files: summary.files.slice(0, 3).filter(file => file && typeof file.path === 'string' && count(file.added) && count(file.removed))
        .map(file => ({ path: displayPath(file.path), added: file.added, removed: file.removed })) };
  }
  function safeMarkdown(container, text, isCurrent) {
    if (window.renderMarkdown) window.renderMarkdown(container, String(text ?? ''));
    else { const paragraph = document.createElement('p'); paragraph.textContent = String(text ?? ''); container.append(paragraph); }
    let disposed = false, cleanup = null;
    const current = () => !disposed && isCurrent();
    const load = window.co2PreviewLoader || (() => import('/vendor/previews.mjs'));
    Promise.resolve().then(load).then(api => { if (current()) return api.enhanceMarkdown?.(container, { isCurrent: current }); })
      .then(result => { if (typeof result !== 'function') return; if (!current()) result(); else cleanup = result; }).catch(() => {});
    return () => { disposed = true; cleanup?.(); };
  }
  function renderActivity(box, detail, isCurrent) {
    if (!detail || !['tool', 'command', 'diff', 'plan'].includes(detail.kind)) throw Error('Unknown detail');
    const add = (tag, text, className) => { const node = document.createElement(tag); node.textContent = String(text ?? ''); if (className) node.className = className; box.append(node); return node; };
    const metadata = [];
    if (detail.status && detail.kind !== 'diff' && detail.kind !== 'plan') metadata.push(activityStatus(detail.status));
    if (detail.exitCode !== undefined) metadata.push('退出码 ' + detail.exitCode);
    if (detail.durationMs !== undefined) metadata.push(detail.durationMs + ' ms');
    if (metadata.length) add('div', metadata.join(' · '), 'activity-meta');
    let cleanup = null;
    if (typeof detail.text === 'string' && detail.text) {
      if (detail.kind === 'plan') {
        const body = add('div', '', 'activity-plan-body markdown'); cleanup = safeMarkdown(body, detail.text, isCurrent);
      } else add('pre', detail.text, 'activity-output').setAttribute('tabindex', '0');
    }
    let openedFile = null;
    for (const file of (detail.files ?? []).slice(0, 500)) {
      const diff = String(file.diff ?? ''), fileName = displayPath(file.path), section = document.createElement('section'); section.className = 'activity-file';
      const heading = document.createElement('h4'); heading.className = 'activity-file-header';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'activity-file-toggle'; button.dataset.action = 'view-diff';
      const name = document.createElement('span'); name.className = 'activity-file-name'; name.textContent = fileName;
      const kind = document.createElement('span'); kind.className = 'activity-file-kind';
      kind.textContent = file.kind === 'add' ? '新增' : file.kind === 'delete' ? '删除' : file.kind === 'update' ? '修改' : String(file.kind ?? '');
      let added = 0, removed = 0;
      for (let start = 0; start < diff.length;) {
        if (diff[start] === '+' && !diff.startsWith('+++ ', start) && !diff.startsWith('+++\t', start)) added++;
        if (diff[start] === '-' && !diff.startsWith('--- ', start) && !diff.startsWith('---\t', start)) removed++;
        const end = diff.indexOf('\n', start); start = end < 0 ? diff.length : end + 1;
      }
      const counts = document.createElement('span'); counts.className = 'activity-file-counts';
      const additions = document.createElement('span'); additions.className = 'activity-file-added'; additions.textContent = '+' + added;
      const deletions = document.createElement('span'); deletions.className = 'activity-file-removed'; deletions.textContent = '−' + removed;
      counts.append(additions, deletions);
      const chevron = document.createElement('span'); chevron.className = 'activity-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div'); body.className = 'diff-file-body'; body.hidden = true; body.id = 'diff-file-' + ++activityViewId;
      button.append(name, kind, counts, chevron); heading.append(button); section.append(heading, body); box.append(section);
      button.title = fileName; button.setAttribute('aria-controls', body.id); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-label', fileName + '，展开变更');
      const view = { button, body, fileName };
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation?.(); if (!isCurrent()) return;
        const close = openedFile;
        if (close) {
          close.body.replaceChildren(); close.body.hidden = true; close.button.setAttribute('aria-expanded', 'false');
          close.button.setAttribute('aria-label', close.fileName + '，展开变更'); openedFile = null;
        }
        if (close === view) return;
        openedFile = view; body.hidden = false; button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-label', fileName + '，收起变更');
        const pre = document.createElement('pre'); pre.className = 'diff-preview'; pre.setAttribute('tabindex', '0');
        let start = 0, lines = 0;
        while (start <= diff.length && lines < 20000) {
          const end = diff.indexOf('\n', start), line = diff.slice(start, end < 0 ? diff.length : end), row = document.createElement('span');
          row.className = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''; row.textContent = line + '\n'; pre.append(row); lines++;
          if (end < 0) { start = diff.length + 1; break; }
          start = end + 1;
        }
        body.append(pre);
        if (start <= diff.length) {
          const notice = document.createElement('p'); notice.className = 'activity-notice'; notice.textContent = '此文件超过 20,000 行，已截断显示。'; body.append(notice);
        }
      });
    }
    if (Array.isArray(detail.steps)) { const list = document.createElement('ol'); list.className = 'activity-steps'; for (const step of detail.steps.slice(0, 500)) {
      const li = document.createElement('li');
      li.dataset.status = ['pending', 'running', 'completed', 'failed', 'declined', 'interrupted'].includes(step.status) ? step.status : 'unknown';
      const status = document.createElement('span'); status.className = 'activity-step-status'; status.textContent = activityStatus(step.status);
      const text = document.createElement('span'); text.textContent = String(step.step ?? ''); li.append(status, text); list.append(li); } box.append(list); }
    if (detail.truncated) add('p', '详情超过 1 MiB，已截断。', 'activity-notice');
    if (!detail.text && !detail.files?.length && !detail.steps?.length) add('p', '此条目没有可显示的文本结果。', 'activity-empty');
    return cleanup;
  }
  function activityStatus(status) {
    const labels = { pending: '待处理', running: '进行中', completed: '已完成', failed: '失败', declined: '已拒绝', interrupted: '已中断' };
    return Object.hasOwn(labels, status) ? labels[status] : '状态未知';
  }
  function drawActivity(state, view) {
    const { button, figure, panel, overview } = view;
    const readable = canRead(), expanded = !!state.expanded && readable, loading = ['queued', 'loading'].includes(state.status);
    const icon = document.createElement('span'); icon.className = 'activity-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ({ command: '›_', tool: '◇', diff: '±', plan: '☷' })[state.activityKind] || '◇';
    const title = document.createElement('span'); title.className = 'activity-title';
    title.textContent = state.activityKind === 'diff' && state.summary ? '已编辑 ' + state.summary.fileCount + ' 个文件' : state.name;
    const status = document.createElement('span'); status.className = 'activity-status';
    status.textContent = loading ? '加载中…' : state.status === 'failed' ? '读取失败' : state.activityKind !== 'diff' && state.activityKind !== 'plan' && state.activityStatus ? activityStatus(state.activityStatus) : '';
    const chevron = document.createElement('span'); chevron.className = 'activity-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
    button.replaceChildren(icon, title);
    if (state.activityKind === 'diff' && state.summary) {
      const counts = document.createElement('span'); counts.className = 'activity-diff-counts';
      const added = document.createElement('span'); added.className = 'activity-file-added'; added.textContent = '+' + state.summary.added;
      const removed = document.createElement('span'); removed.className = 'activity-file-removed'; removed.textContent = '−' + state.summary.removed;
      counts.append(added, removed); button.append(counts);
    }
    button.append(status, chevron);
    button.disabled = !readable; button.title = state.name;
    button.setAttribute('aria-expanded', String(expanded)); button.setAttribute('aria-busy', String(loading));
    button.setAttribute('aria-label', state.name + '，' + (expanded ? '收起详情' : '展开详情'));
    figure.dataset.kind = state.activityKind || 'tool'; figure.dataset.status = state.activityStatus || 'unknown'; figure.dataset.expanded = String(expanded);
    overview.replaceChildren(); overview.hidden = expanded;
    if (state.activityKind === 'diff' && state.summary) {
      figure.className = 'activity-card activity-diff-summary';
      const files = document.createElement('div'); files.className = 'activity-diff-files';
      for (const file of state.summary.files) {
        const row = document.createElement('div'); row.className = 'activity-diff-file';
        const name = document.createElement('span'); name.className = 'activity-file-name'; name.textContent = displayPath(file.path);
        const counts = document.createElement('span'); counts.className = 'activity-file-counts';
        const added = document.createElement('span'); added.className = 'activity-file-added'; added.textContent = '+' + file.added;
        const removed = document.createElement('span'); removed.className = 'activity-file-removed'; removed.textContent = '−' + file.removed;
        counts.append(added, removed); row.append(name, counts); files.append(row);
      }
      overview.append(files);
      if (state.summary.remaining > 0) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'activity-diff-more';
        more.textContent = '再显示 ' + state.summary.remaining + ' 个文件'; more.disabled = !readable;
        more.addEventListener('click', event => { event.preventDefault(); event.stopPropagation?.(); button.click(); }); overview.append(more);
      }
    } else if (state.activityKind === 'plan') {
      figure.className = 'activity-card activity-plan-card';
      if (state.planPreview) {
        const preview = document.createElement('div'); preview.className = 'activity-plan-preview markdown';
        if (window.renderMarkdown) window.renderMarkdown(preview, state.planPreview); else preview.textContent = state.planPreview;
        overview.append(preview);
      }
    }
    panel.hidden = !expanded;
    if (readable && state.status === 'ready' && (expanded || state.preview)) {
      const preview = mediaPreview(state); preview.hidden = false; panel.replaceChildren(preview);
    } else if (expanded) panel.textContent = loading ? '正在加载详情…' : '详情暂不可用，收起后可重试。';
    else panel.replaceChildren();
  }
  function draw(state) {
    if (state.kind === 'image') syncImageFileViews(state.id);
    for (const view of state.views) {
      const { button, label, figure, download, panel } = view;
      if (view.previewImageId) figure.hidden = imageFileHidden(view);
      if (state.kind === 'activity') { drawActivity(state, view); continue; }
      button.replaceChildren(); label.textContent = view.displayName;
      if (download) {
        download.disabled = !canRead() || ['loading', 'queued'].includes(state.status);
        download.hidden = !canDownload(state) || !state.expanded && state.status !== 'failed' && !state.problem && !state.previewFailed;
      }
      if (state.kind !== 'image' || view.link) {
        const loading = ['queued', 'loading'].includes(state.status), expanded = !!state.expanded && canRead();
        const icon = document.createElement('span'); icon.className = 'file-icon'; icon.setAttribute('aria-hidden', 'true');
        icon.dataset.kind = state.kind; icon.dataset.family = fileFamily(state); icon.textContent = view.card ? fileFormat(state) : state.kind === 'image' ? '▧' : '▤';
        const name = document.createElement('span'); name.className = 'file-label'; name.textContent = view.card ? state.name : view.displayName;
        if (view.card) {
          const badge = document.createElement('span'); badge.className = 'attachment-file-badge'; badge.textContent = fileFormat(state).slice(0, 4);
          icon.replaceChildren(badge);
          const details = document.createElement('span'); details.className = 'attachment-file-details';
          const format = document.createElement('span'); format.className = 'attachment-file-format'; format.textContent = fileFormat(state);
          details.append(name, format);
          if (!view.attachment && view.displayName !== state.name) {
            const caption = document.createElement('span'); caption.className = 'document-file-caption'; caption.textContent = view.displayName; details.append(caption);
          }
          button.append(icon, details);
        } else button.append(icon, name);
        button.disabled = !canRead();
        const titleName = view.card && view.displayName !== state.name ? view.displayName + '（' + state.name + '）' : view.displayName;
        button.title = !canRead() ? '此引用暂不可用' : state.status === 'failed' ? '预览暂不可用，点击重试' : state.kind === 'image' ? '查看图片：' + titleName : (expanded ? '收起预览：' : '查看文件：') + titleName;
        button.setAttribute('aria-label', button.title); button.setAttribute('aria-busy', String(loading));
        if (state.kind !== 'image') button.setAttribute('aria-expanded', String(expanded));
        figure.dataset.state = loading ? 'loading' : !canRead() ? 'unavailable' : state.status;
        if (panel) {
          panel.hidden = !expanded && state.status !== 'failed' && !state.previewFailed && !state.problem;
          view.notice.textContent = loading ? (state.kind === 'download' ? '正在准备下载…' : '正在加载预览…')
            : state.problem || (state.status === 'failed' ? '此引用无法预览，可重试或下载原件。'
              : state.kind === 'download' ? capabilities().includes('file-original') ? '此格式暂不支持网页预览，可下载原件查看。' : '此格式暂不支持网页预览，当前连接不支持原件下载。' : '');
          view.notice.hidden = !view.notice.textContent;
          if (state.kind !== 'download' && state.status === 'ready' && canRead() && (expanded || state.preview)) {
            const preview = mediaPreview(state); preview.hidden = !expanded || !!state.problem; panel.append(preview);
          }
        }
      } else if (state.status === 'ready' && state.kind === 'image') {
        const image = document.createElement('img'), url = state.url; image.alt = state.name;
        image.loading = 'lazy'; image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => {
          if (states.get(state.id) !== state || state.url !== url) return;
          release(state, 'failed');
          if (state.remoteUrl) state.problem = '无法加载远程图片。点击重试';
          draw(state);
        });
        image.src = url;
        button.append(image); button.disabled = false; button.title = '点击放大图片';
      } else {
        const loading = ['queued', 'loading'].includes(state.status);
        button.textContent = loading ? '正在加载…' : state.status === 'failed'
          ? state.problem || '无法预览：此引用已失效或图片格式不受支持。点击重试'
          : '查看图片';
        button.disabled = loading || !canRead();
      }
    }
  }
  function enqueue(state) {
    if (!state || ['ready', 'queued', 'loading'].includes(state.status) || !canRead()) return;
    if (state.remoteUrl) {
      state.problem = ''; state.url = state.remoteUrl; state.status = 'ready'; draw(state);
      if (state.openWhenReady) { state.openWhenReady = false; openImage(state); } return;
    }
    state.problem = ''; state.status = 'queued'; queue.push(state.id); draw(state); pump();
  }
  function pump() {
    if (active || !canRead()) return;
    while (queue.length) {
      const state = states.get(queue.shift()); if (!state || state.status !== 'queued') continue;
      state.original = state.kind !== 'image' && state.kind !== 'activity' && capabilities().includes('file-original');
      active = { state, chunks: [], bytes: 0, mime: null, total: null }; state.status = 'loading'; draw(state);
      timer = window.setTimeout(() => finish(false), state.kind === 'image' ? 20000 : 120000);
      const request = state.kind === 'image' ? { type: 'image-request', imageId: state.id }
        : state.kind === 'activity' ? { type: 'activity-request', activityId: state.id }
        : { type: 'file-request', fileId: state.id, ...(state.original ? { representation: 'original' } : {}) };
      if (!send(request)) finish(false);
      return;
    }
  }
  function finish(ok) {
    if (!active) return;
    window.clearTimeout(timer); timer = null;
    const { state, chunks, mime, bytes } = active; active = null;
    if (states.get(state.id) === state) {
      let url = null, text = null, cost = 0, data = null;
      try {
        if (ok && state.kind === 'image') { url = `data:${mime};base64,${chunks.join('')}`; cost = url.length; }
        else if (ok) {
          data = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
          cost = bytes;
          if (state.kind === 'video' || state.kind === 'audio') url = URL.createObjectURL(new Blob([data], { type: mediaMime(state) }));
          else if (state.kind === 'activity' || !state.original && ['text', 'markdown', 'table'].includes(state.kind)) text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        }
      } catch { ok = false; }
      if (ok) {
        for (const old of [...states.values()].sort(evictionOrder)) {
          if (cacheBytes + cost <= cacheLimit) break;
          if (old.status !== 'ready') continue;
          release(old, 'evicted'); draw(old);
        }
        state.url = url; state.text = text; state.bytes = data; state.mime = mime; state.cost = cost; cacheBytes += cost; state.status = 'ready'; state.used = ++usageSerial;
        if (state.kind === 'activity' && state.activityKind === 'plan' && !state.planPreview) {
          try { state.planPreview = String(JSON.parse(text).text ?? '').slice(0, 1024); } catch { /* The detail renderer reports invalid content. */ }
        }
      } else { state.status = 'failed'; state.openWhenReady = false; }
      draw(state);
      if (ok && state.openWhenReady) { state.openWhenReady = false; openImage(state); }
      if (ok && state.downloadWhenReady) { state.downloadWhenReady = false; downloadOriginal(state); }
    }
    pump();
  }
  return {
    retain(ids) {
      invalidateFallbacks();
      observer?.disconnect();
      for (const [id, state] of states) {
        state.wasPlaying = state.media ? !state.media.paused : false; state.views = [];
        if (ids.has(id)) continue;
        release(state, 'removed'); states.delete(id);
        if (active?.state === state) { window.clearTimeout(timer); timer = null; active = null; }
      }
    },
    render(refs, parent, { inline = false, link = false, attachment = false, card = false } = {}) {
      let rendered = 0;
      for (const ref of refs ?? []) {
        const kind = ref?.kind ?? 'image';
        if (!ref || !/^[a-f0-9]{64}$/.test(ref.id ?? '') || typeof ref.name !== 'string' || !Object.hasOwn(limits, kind)) continue;
        let state = states.get(ref.id);
        if (!state) {
          let remoteUrl = null;
          if (ref.url !== undefined) {
            try {
              const url = new URL(ref.url);
              if (kind !== 'image' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) continue;
              remoteUrl = url.href;
            } catch { continue; }
          }
          if (!metadataSlot()) {
            // Out-of-contract callers can exceed the frame-derived bound.
            // Keep a visible retry entry rather than leaving an empty article.
            const holder = document.createElement(inline ? 'span' : 'div'), figure = document.createElement(inline ? 'span' : 'div');
            figure.className = kind === 'activity' ? 'activity-card' : 'message-file ' + (card ? 'document-file' : inline ? 'message-file-inline' : attachment ? 'attachment-file' : 'file-chip');
            const button = document.createElement('button'); button.type = 'button'; button.className = kind === 'activity' ? 'activity-summary' : 'file-link';
            button.dataset.imageId = ref.id; button.disabled = !canRead(); button.setAttribute('aria-expanded', 'false');
            const name = typeof ref.label === 'string' && ref.label.trim() ? ref.label.slice(0, 512) : ref.name.slice(0, 240);
            const title = document.createElement('span'); title.className = kind === 'activity' ? 'activity-title' : 'file-label'; title.textContent = name;
            const status = document.createElement('span'); status.className = 'activity-status'; status.textContent = '点击重试';
            button.title = '此预览暂不可用，点击重试'; button.setAttribute('aria-label', name + '，点击重试');
            button.append(title, status); figure.append(button); holder.append(figure); parent.append(holder); rendered++;
            const epoch = viewEpoch, fallback = { button }; fallbackViews.add(fallback);
            button.addEventListener('click', event => {
              event.preventDefault(); event.stopPropagation?.();
              if (!canRead() || epoch !== viewEpoch) return;
              if (!metadataSlot()) { status.textContent = '暂不可用，稍后重试'; return; }
              fallbackViews.delete(fallback); holder.replaceChildren(); this.render([ref], holder, { inline, link, attachment, card }); pump();
            });
            continue;
          }
          state = { id: ref.id, name: ref.name.slice(0, 240), kind, status: 'idle', views: [], cost: 0, url: null, remoteUrl, used: ++usageSerial }; states.set(ref.id, state);
        }
        if (state.kind !== kind) continue;
        if (kind === 'activity') {
          state.activityKind = ['tool', 'command', 'diff', 'plan'].includes(ref.activityKind) ? ref.activityKind : state.activityKind || 'tool';
          state.activityStatus = ['pending', 'running', 'completed', 'failed', 'declined', 'interrupted', 'unknown'].includes(ref.status) ? ref.status : state.activityStatus;
          state.summary = state.activityKind === 'diff' ? diffSummary(ref.summary) : null;
          if (state.activityKind === 'plan' && typeof ref.preview === 'string') state.planPreview = ref.preview.slice(0, 1024);
        }
        const fileLink = kind !== 'activity' && (kind !== 'image' || link);
        const figure = document.createElement(kind === 'activity' ? 'div' : inline ? 'span' : 'figure');
        figure.className = kind === 'activity' ? 'activity-card' : fileLink ? 'message-file ' + (card ? 'document-file' : inline ? 'message-file-inline' : attachment ? 'attachment-file' : 'file-chip') : 'message-image';
        const button = document.createElement('button'); button.type = 'button'; button.dataset.imageId = ref.id;
        const label = document.createElement(inline ? 'span' : 'figcaption'); label.className = 'image-caption';
        const displayName = typeof ref.label === 'string' && ref.label.trim() ? ref.label.slice(0, 512) : state.name;
        let panel = null, notice = null, overview = null;
        if (kind === 'activity') {
          button.className = 'activity-summary'; panel = document.createElement('div'); panel.className = 'activity-panel';
          panel.id = 'activity-detail-' + ++activityViewId; button.setAttribute('aria-controls', panel.id);
          overview = document.createElement('div'); overview.className = 'activity-overview'; figure.append(button, overview, panel);
        } else if (fileLink) {
          button.className = attachment || card ? 'file-link attachment-file-button' : 'file-link'; figure.append(button);
          if (kind !== 'image') {
            panel = document.createElement('span'); panel.className = 'file-preview-panel'; panel.hidden = true;
            panel.id = 'file-preview-' + ++activityViewId; button.setAttribute('aria-controls', panel.id);
            notice = document.createElement('span'); notice.className = 'file-preview-notice'; notice.hidden = true; panel.append(notice); figure.append(panel);
          }
        } else figure.append(button, label);
        let download = null;
        if (!['activity', 'image'].includes(kind) && canDownload(state)) {
          download = document.createElement('button'); download.type = 'button'; download.className = 'file-download preview-download';
          download.setAttribute('aria-label', '下载原件：' + state.name); download.title = '下载原件';
          const toolbar = document.createElement('span'); toolbar.className = 'file-preview-toolbar'; toolbar.append(download); panel.append(toolbar);
          download.addEventListener('click', event => { event.preventDefault(); event.stopPropagation?.();
            if (!canRead() || !canDownload(state)) return;
            if (state.status === 'ready' && (state.kind === 'image' || state.original)) downloadOriginal(state); else {
              if (state.status === 'ready') release(state, 'idle'); state.expanded = false; state.downloadWhenReady = true; enqueue(state); }
          }); }
        parent.append(figure);
        rendered++;
        const previewImageId = attachment && kind === 'download' && /^[a-f0-9]{64}$/.test(ref.previewImageId ?? '') ? ref.previewImageId : undefined;
        state.views.push({ button, label, figure, download, panel, notice, overview, displayName, link, attachment, previewImageId, card: attachment || card }); draw(state);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation?.();
          if (states.get(state.id) !== state || !canRead()) return;
          state.used = ++usageSerial;
          if (state.kind === 'activity') {
            if (!canRead()) return;
            state.expanded = !state.expanded;
            if (state.expanded && state.status !== 'ready') enqueue(state);
            draw(state); return;
          }
          if (state.kind === 'download') { state.expanded = !state.expanded; draw(state); return; }
          if (state.status !== 'ready') {
            if (state.kind === 'image' && link) state.openWhenReady = true;
            if (state.kind !== 'image') state.expanded = !state.expanded;
            enqueue(state); draw(state); return;
          }
          if (state.kind !== 'image') {
            state.expanded = !state.expanded;
            if (!state.expanded && state.media) { state.media.pause(); state.wasPlaying = false; }
            draw(state); return;
          }
          openImage(state);
        });
        if (state.status === 'idle' && kind === 'image' && !link) { if (observer) observer.observe(button); else enqueue(state); }
      }
      return rendered;
    },
    mounted() {
      for (const state of states.values()) if (state.wasPlaying && state.media?.paused && state.expanded && canRead()) state.media.play().catch(() => {});
      pump();
    },
    receive(payload) {
      if (!active || !canRead()) return;
      const { state } = active, type = state.kind === 'image' ? 'image' : state.kind === 'activity' ? 'activity' : 'file';
      if (payload[`${type}Id`] !== state.id) return;
      if (payload.type === `${type}-unavailable`) { finish(false); return; }
      if (payload.type !== `${type}-chunk`) return;
      const limit = !state.original && ['text', 'table', 'markdown'].includes(state.kind) ? 1048576 : limits[state.kind], empty = (state.original || ['text', 'table', 'markdown'].includes(state.kind)) && payload.total === 1 && payload.index === 0 && payload.data === '';
      const valid = (state.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'].includes(payload.mime)
        : state.kind === 'activity' ? payload.mime === 'application/json'
          : state.original ? payload.mime === 'application/octet-stream' && payload.representation === 'original'
          : payload.mime === (state.kind === 'video' ? 'video/mp4' : 'text/plain; charset=utf-8'))
        && Number.isInteger(payload.total) && payload.total > 0 && payload.total <= Math.ceil(limit / 30720)
        && payload.index === active.chunks.length && payload.index < payload.total
        && (active.total === null || active.total === payload.total && active.mime === payload.mime)
        && typeof payload.data === 'string' && payload.data.length <= chunkChars && payload.data.length % 4 === 0
        && (empty || /^[A-Za-z0-9+/]+={0,2}$/.test(payload.data))
        && (payload.index === payload.total - 1 || payload.data.length === chunkChars && !payload.data.includes('='));
      if (!valid) { finish(false); return; }
      let decoded;
      try { decoded = atob(payload.data); if (btoa(decoded) !== payload.data) throw new Error('Invalid base64'); }
      catch { finish(false); return; }
      active.bytes += decoded.length;
      if (active.bytes > limit) { finish(false); return; }
      active.mime = payload.mime; active.total = payload.total;
      active.chunks.push(state.kind === 'image' ? payload.data : Uint8Array.from(decoded, c => c.charCodeAt(0)));
      if (active.chunks.length === active.total) finish(true);
    },
    pause() {
      invalidateFallbacks();
      observer?.disconnect(); window.clearTimeout(timer); timer = null; active = null; queue.length = 0;
      for (const state of states.values()) {
        state.media?.pause(); state.wasPlaying = false; state.openWhenReady = false;
        if (state.preview && rich(state) || state.dispose) discardRich(state);
        if (['queued', 'loading'].includes(state.status)) state.status = 'failed'; draw(state);
      }
      closePreview();
    },
    clear() { this.pause(); for (const state of states.values()) release(state, 'removed'); states.clear(); cacheBytes = 0; },
  };
};
