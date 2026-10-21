// Legacy factory name; previews only use the admitted room socket.
window.createThreadImages = ({ send, canRead }) => {
  const states = new Map(), queue = [];
  const chunkChars = 40960, limits = { image: 8388608, video: 33554432, text: 1048576 };
  const cacheLimit = 48 * 1024 * 1024;
  let active = null, timer = null, cacheBytes = 0, expandedId = null;
  const dialog = document.createElement('dialog'); dialog.className = 'image-dialog'; dialog.setAttribute('aria-label', '图片预览');
  const close = document.createElement('button'); close.type = 'button'; close.className = 'button'; close.textContent = '关闭预览';
  const full = document.createElement('img'), caption = document.createElement('p');
  full.alt = ''; dialog.append(close, full, caption); document.body.append(dialog);
  const closePreview = () => { expandedId = null; full.removeAttribute('src'); if (dialog.open) dialog.close(); };
  close.addEventListener('click', closePreview);
  dialog.addEventListener('click', event => { if (event.target === dialog) closePreview(); });
  dialog.addEventListener('close', () => { expandedId = null; full.removeAttribute('src'); });
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target); enqueue(states.get(entry.target.dataset.imageId));
    }
  }, { rootMargin: '200px' }) : null;

  function release(state, status) {
    cacheBytes -= state.cost; state.cost = 0;
    const media = state.media; state.media = null;
    state.preview?.remove();
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    if (state.kind === 'video' && state.url) URL.revokeObjectURL(state.url);
    state.url = null; state.text = null; state.preview = null; state.wasPlaying = false; state.status = status;
    if (expandedId === state.id) closePreview();
  }
  function mediaPreview(state) {
    if (state.preview) return state.preview;
    if (state.kind === 'text') {
      const pre = document.createElement('pre'), code = document.createElement('code');
      pre.className = 'file-text-preview'; pre.setAttribute('tabindex', '0'); code.textContent = state.text || '（空文件）';
      pre.append(code); state.preview = pre;
    } else {
      const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.playsInline = true;
      video.className = 'file-video-preview'; video.setAttribute('aria-label', state.name); video.src = state.url;
      video.addEventListener('error', () => {
        if (state.media !== video) return;
        release(state, 'failed'); state.problem = '浏览器不支持此 MP4 编码或文件损坏。点击重试'; draw(state);
      });
      state.media = video; state.preview = video;
    }
    return state.preview;
  }
  function draw(state) {
    for (const { button, label, figure } of state.views) {
      button.replaceChildren(); label.textContent = state.name;
      if (state.status === 'ready' && state.kind === 'image') {
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
      } else if (state.status === 'ready') {
        button.textContent = state.expanded ? '收起预览' : state.kind === 'video' ? '显示视频' : '预览文本';
        button.disabled = false;
        const preview = mediaPreview(state); preview.hidden = !state.expanded; figure.append(preview);
      } else {
        const loading = ['queued', 'loading'].includes(state.status);
        button.textContent = loading ? '正在加载…' : state.status === 'failed'
          ? state.problem || (state.kind === 'image' ? '无法预览：文件已失效、超过 8 MiB 或格式不符。点击重试'
            : '无法预览：文件已失效、超过上限或格式、编码不受支持。点击重试')
          : state.kind === 'image' ? '查看图片（PNG、JPEG、WebP，最大 8 MiB）'
            : state.kind === 'video' ? '加载 MP4 视频（最大 32 MiB）' : '预览文本（最大 1 MiB）';
        button.disabled = loading || !canRead();
      }
    }
  }
  function enqueue(state) {
    if (!state || ['ready', 'queued', 'loading'].includes(state.status) || !canRead()) return;
    if (state.remoteUrl) { state.problem = ''; state.url = state.remoteUrl; state.status = 'ready'; draw(state); return; }
    state.problem = ''; state.status = 'queued'; queue.push(state.id); draw(state); pump();
  }
  function pump() {
    if (active || !canRead()) return;
    while (queue.length) {
      const state = states.get(queue.shift()); if (!state || state.status !== 'queued') continue;
      active = { state, chunks: [], bytes: 0, mime: null, total: null }; state.status = 'loading'; draw(state);
      timer = window.setTimeout(() => finish(false), state.kind === 'image' ? 20000 : 120000);
      const request = state.kind === 'image' ? { type: 'image-request', imageId: state.id } : { type: 'file-request', fileId: state.id };
      if (!send(request)) finish(false);
      return;
    }
  }
  function finish(ok) {
    if (!active) return;
    window.clearTimeout(timer); timer = null;
    const { state, chunks, mime, bytes } = active; active = null;
    if (states.get(state.id) === state) {
      let url = null, text = null, cost = 0;
      try {
        if (ok && state.kind === 'image') { url = `data:${mime};base64,${chunks.join('')}`; cost = url.length; }
        else if (ok && state.kind === 'video') { url = URL.createObjectURL(new Blob(chunks, { type: mime })); cost = bytes; }
        else if (ok) {
          const data = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
          text = new TextDecoder('utf-8', { fatal: true }).decode(data); cost = text.length * 2;
        }
      } catch { ok = false; }
      if (ok) {
        for (const old of states.values()) {
          if (cacheBytes + cost <= cacheLimit) break;
          if (old.status !== 'ready') continue;
          release(old, 'evicted'); draw(old);
        }
        state.url = url; state.text = text; state.cost = cost; cacheBytes += cost; state.status = 'ready'; state.expanded = true;
      } else state.status = 'failed';
      draw(state);
    }
    pump();
  }
  return {
    retain(ids) {
      observer?.disconnect();
      for (const [id, state] of states) {
        state.wasPlaying = state.media ? !state.media.paused : false; state.views = [];
        if (ids.has(id)) continue;
        release(state, 'removed'); states.delete(id);
        if (active?.state === state) { window.clearTimeout(timer); timer = null; active = null; }
      }
    },
    render(refs, parent, { inline = false } = {}) {
      let rendered = 0;
      for (const ref of refs ?? []) {
        const kind = ref?.kind ?? 'image';
        if (!ref || !/^[a-f0-9]{64}$/.test(ref.id ?? '') || typeof ref.name !== 'string' || !Object.hasOwn(limits, kind)) continue;
        let state = states.get(ref.id);
        if (!state) {
          if (states.size >= 128) continue;
          let remoteUrl = null;
          if (ref.url !== undefined) {
            try {
              const url = new URL(ref.url);
              if (kind !== 'image' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) continue;
              remoteUrl = url.href;
            } catch { continue; }
          }
          state = { id: ref.id, name: ref.name.slice(0, 240), kind, status: 'idle', views: [], cost: 0, url: null, remoteUrl }; states.set(ref.id, state);
        }
        if (state.kind !== kind) continue;
        const figure = document.createElement(inline ? 'span' : 'figure'); figure.className = kind === 'image' ? 'message-image' : 'message-file';
        const button = document.createElement('button'); button.type = 'button'; button.dataset.imageId = ref.id;
        const label = document.createElement(inline ? 'span' : 'figcaption'); label.className = 'image-caption'; figure.append(button, label); parent.append(figure);
        rendered++;
        state.views.push({ button, label, figure }); draw(state);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation?.();
          if (state.status !== 'ready') { enqueue(state); return; }
          if (state.kind !== 'image') {
            state.expanded = !state.expanded;
            if (!state.expanded && state.media) { state.media.pause(); state.wasPlaying = false; }
            draw(state); return;
          }
          expandedId = state.id; full.referrerPolicy = 'no-referrer'; full.src = state.url; full.alt = state.name; caption.textContent = state.name; dialog.showModal();
        });
        if (state.status === 'idle' && kind === 'image') { if (observer) observer.observe(button); else enqueue(state); }
      }
      return rendered;
    },
    mounted() {
      for (const state of states.values()) if (state.wasPlaying && state.media?.paused && state.expanded && canRead()) state.media.play().catch(() => {});
      pump();
    },
    receive(payload) {
      if (!active || !canRead()) return;
      const { state } = active, type = state.kind === 'image' ? 'image' : 'file';
      if (payload[`${type}Id`] !== state.id) return;
      if (payload.type === `${type}-unavailable`) { finish(false); return; }
      if (payload.type !== `${type}-chunk`) return;
      const limit = limits[state.kind], empty = state.kind === 'text' && payload.total === 1 && payload.index === 0 && payload.data === '';
      const valid = (state.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'].includes(payload.mime)
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
      observer?.disconnect(); window.clearTimeout(timer); timer = null; active = null; queue.length = 0;
      for (const state of states.values()) {
        state.media?.pause(); state.wasPlaying = false;
        if (['queued', 'loading'].includes(state.status)) state.status = 'failed'; draw(state);
      }
      closePreview();
    },
    clear() { this.pause(); for (const state of states.values()) release(state, 'removed'); states.clear(); cacheBytes = 0; },
  };
};
