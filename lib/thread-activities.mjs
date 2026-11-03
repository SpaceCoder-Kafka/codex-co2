import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';

export const MAX_ACTIVITY_DETAIL_BYTES = 1024 * 1024;
const DETAIL = Symbol('shared activity detail');
const SUMMARY = Symbol('shared diff summary');
const statuses = new Map([
  ['pending', 'pending'], ['queued', 'pending'], ['inProgress', 'running'], ['in_progress', 'running'], ['running', 'running'],
  ['completed', 'completed'], ['complete', 'completed'], ['succeeded', 'completed'], ['failed', 'failed'], ['error', 'failed'],
  ['declined', 'declined'], ['interrupted', 'interrupted'], ['cancelled', 'interrupted'], ['canceled', 'interrupted'],
  ['unknown', 'unknown'],
]);
const statusOf = (value, fallback = 'unknown') => statuses.get(value) ?? fallback;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const clean = value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');

// Count the JSON representation, rather than UTF-16 characters: quoted logs
// can otherwise grow past the transport budget after serializing. The reserve
// bounds field names, punctuation and the separately bounded array metadata.
function budget(alreadyTruncated = false) {
  return {
    left: MAX_ACTIVITY_DETAIL_BYTES - 64 * 1024, truncated: alreadyTruncated,
    text(value, maximum = this.left, tail = false) {
      if (typeof value !== 'string') return '';
      const source = clean(value), limit = Math.max(0, Math.min(this.left, maximum));
      const cost = text => Buffer.byteLength(JSON.stringify(text));
      let text = source;
      if (cost(source) > limit) {
        this.truncated = true;
        let low = 0, high = source.length;
        while (low < high) {
          const size = Math.ceil((low + high) / 2), candidate = tail ? source.slice(-size) : source.slice(0, size);
          if (cost(candidate) <= limit) low = size;
          else high = size - 1;
        }
        text = tail ? source.slice(source.length - low) : source.slice(0, low);
        // Do not begin/end with half of a surrogate pair.
        if (tail && /^[\uDC00-\uDFFF]/u.test(text)) text = text.slice(1);
        if (!tail && /[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
      }
      this.left = Math.max(0, this.left - cost(text));
      return text;
    },
  };
}

function resultText(value, b) {
  if (typeof value === 'string') return b.text(value);
  const content = Array.isArray(value) ? value : Array.isArray(value?.content) ? value.content : null;
  if (!content) return '';
  const texts = [];
  for (const part of content.slice(0, 128)) {
    if (!part || !['text', 'inputText', 'outputText', 'input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string') continue;
    if (b.left < 8) { b.truncated = true; break; }
    texts.push(b.text(part.text));
  }
  if (content.length > 128) b.truncated = true;
  return texts.join('\n');
}

function errorText(value, b) {
  return typeof value === 'string' ? b.text(value) : typeof value?.message === 'string' ? b.text(value.message) : '';
}

function timing(raw, out) {
  if (Number.isFinite(raw.durationMs) && raw.durationMs >= 0) out.durationMs = raw.durationMs;
  if (Number.isSafeInteger(raw.exitCode)) out.exitCode = raw.exitCode;
}

function lineCounts(diff) {
  let added = 0, removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
function diffSummary(changes) {
  const files = changes.map(change => ({ path: [...change.path].slice(0, 256).join(''), ...lineCounts(change.diff) }));
  return { fileCount: files.length, added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0), files: files.slice(0, 3), remaining: Math.max(0, files.length - 3) };
}
function displayPath(value, cwd) {
  if (typeof cwd !== 'string') return value;
  const impl = path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd) ? path.win32 : path.posix;
  if (!impl.isAbsolute(cwd) || !impl.isAbsolute(value)) return value;
  const relative = impl.relative(cwd, value);
  return relative && relative !== '..' && !relative.startsWith(`..${impl.sep}`) && !impl.isAbsolute(relative)
    ? relative.split(impl.sep).join('/') : value;
}
function diffFiles(diff) {
  const starts = [...diff.matchAll(/^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)\r?$/gmu)];
  return starts.map((match, index) => {
    let name = match[1];
    if (name.startsWith('"')) {
      try { name = JSON.parse(name); }
      catch {
        // Git uses C-style octal UTF-8 escapes for non-ASCII names. These are
        // display strings only; decoding never authorizes reading that path.
        const bytes = [];
        for (const part of name.slice(1, -1).match(/\\[0-7]{1,3}|\\.|[^\\]+/gu) ?? []) {
          if (/^\\[0-7]/u.test(part)) bytes.push(Buffer.from([parseInt(part.slice(1), 8)]));
          else if (part.startsWith('\\')) bytes.push(Buffer.from(({ '\\t': '\t', '\\n': '\n', '\\r': '\r' })[part] ?? part.slice(1)));
          else bytes.push(Buffer.from(part));
        }
        name = Buffer.concat(bytes).toString('utf8');
      }
    }
    const text = diff.slice(match.index, starts[index + 1]?.index ?? diff.length);
    const kind = /^new file mode /mu.test(text) ? 'add' : /^deleted file mode /mu.test(text) ? 'delete' : 'update';
    return { path: name.replace(/^[ab]\//u, ''), kind: { type: kind }, diff: text };
  }).filter(Boolean);
}

// The turn diff is the native cumulative result. Prefer its per-file patch for
// overlapping files and retain files only present in item-level changes.
export function aggregateTurnActivities(turnId, diff, items = [], status = 'completed', cwd) {
  if (!validId(turnId)) return items;
  const fileItems = items.filter(item => item?.type === 'fileChange');
  const stableId = 'co2:turn-diff:' + createHash('sha256').update(turnId).digest('hex').slice(0, 32);
  if ((typeof diff !== 'string' || !diff.trim()) && !cwd && fileItems.length === 1 && fileItems[0].id === stableId) {
    return [...items.filter(item => item?.type !== 'fileChange'), fileItems[0]];
  }
  const files = new Map();
  for (const item of fileItems) for (const change of item.changes ?? []) {
    if (typeof change?.path !== 'string' || typeof change.diff !== 'string') continue;
    const name = displayPath(change.path, cwd), previous = files.get(name);
    // Repeated persisted tool results are the same edit. For distinct edits
    // without a cumulative turn diff, retain both patches once.
    if (!previous) files.set(name, { ...change, path: name });
    else if (change.diff.trim() && !previous.diff.includes(change.diff.trim())) {
      files.set(name, { ...change, path: name, diff: change.diff.includes(previous.diff.trim())
        ? change.diff : `${previous.diff.trim()}\n\n${change.diff.trim()}` });
    }
  }
  if (typeof diff === 'string' && diff.trim()) {
    const parsed = diffFiles(diff);
    if (parsed.length) for (const change of parsed) files.set(displayPath(change.path, cwd), { ...change, path: displayPath(change.path, cwd) });
    else if (![...files.values()].some(change => change.diff.trim() === diff.trim())
      && [...files.values()].map(change => change.diff.trim()).join('\n') !== diff.trim()) {
      files.set('回合变更', { path: '回合变更', kind: { type: 'update' }, diff });
    }
  }
  if (!files.size) return items.filter(item => item?.type !== 'fileChange');
  const combined = projectActivity({ id: stableId, type: 'fileChange', status, changes: [...files.values()],
    activityTruncated: fileItems.some(item => item.activityTruncated === true) });
  return [...items.filter(item => item?.type !== 'fileChange'), combined];
}

// Native thread state is never forwarded wholesale. Keep this projection
// idempotent so both Desktop IPC and isolated app-server fixtures use it.
export function projectActivity(raw) {
  if (!raw || !validId(raw.id)) return null;
  const b = budget(raw.activityTruncated === true), out = { id: raw.id, type: raw.type };
  switch (raw.type) {
    case 'commandExecution':
      if (typeof raw.command !== 'string') return null;
      out.command = b.text(raw.command, 8192);
      out.status = statusOf(raw.status);
      out.aggregatedOutput = b.text(raw.aggregatedOutput, b.left, true);
      timing(raw, out);
      break;
    case 'mcpToolCall': {
      if (typeof raw.tool !== 'string') return null;
      out.server = b.text(raw.server, 256); out.tool = b.text(raw.tool, 256);
      out.status = statusOf(raw.status);
      const error = errorText(raw.error, b), text = resultText(raw.result, b);
      if (error) out.error = { message: error };
      if (text) out.result = { content: [{ type: 'text', text }] };
      if ((error || raw.result?.isError === true) && out.status === 'completed') out.status = 'failed';
      timing(raw, out);
      break;
    }
    case 'dynamicToolCall': {
      if (typeof raw.tool !== 'string') return null;
      out.tool = b.text(raw.tool, 256); out.namespace = b.text(raw.namespace, 256);
      out.status = statusOf(raw.status);
      const text = resultText(raw.contentItems, b);
      if (text) out.contentItems = [{ type: 'text', text }];
      if (typeof raw.success === 'boolean') out.success = raw.success;
      if (out.success === false && out.status === 'completed') out.status = 'failed';
      timing(raw, out);
      break;
    }
    case 'functionCallOutput':
      if (typeof raw.name !== 'string') return null;
      out.name = b.text(raw.name, 256); out.namespace = b.text(raw.namespace, 256);
      out.output = resultText(raw.output, b); out.status = 'completed';
      break;
    case 'fileChange': {
      if (!Array.isArray(raw.changes)) return null;
      out.status = statusOf(raw.status);
      out.changes = [];
      const changes = raw.changes.filter(change => change && typeof change.path === 'string' && typeof change.diff === 'string'
        && ['add', 'delete', 'update'].includes(typeof change.kind === 'string' ? change.kind : change.kind?.type));
      out[SUMMARY] = raw[SUMMARY] ?? diffSummary(changes);
      for (const [index, change] of changes.slice(0, 1024).entries()) {
        const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
        if (b.left < 8) { b.truncated = true; break; }
        const name = b.text(change.path, Math.min(4096, Math.floor(b.left / Math.max(1, changes.length - index) / 2)));
        out.changes.push({ path: name, kind: { type: kind }, diff: b.text(change.diff, Math.floor(b.left / Math.max(1, changes.length - index))) });
      }
      if (changes.length > 1024) b.truncated = true;
      break;
    }
    case 'todo-list': {
      if (!Array.isArray(raw.plan)) return null;
      out.explanation = b.text(raw.explanation, 16384); out.plan = [];
      const steps = Array.isArray(raw.plan) ? raw.plan : [];
      for (const step of steps.slice(0, 256)) {
        if (!step || typeof step.step !== 'string') continue;
        if (b.left < 8) { b.truncated = true; break; }
        out.plan.push({ step: b.text(step.step, 8192), status: statusOf(step.status, 'pending') });
      }
      if (steps.length > 256) b.truncated = true;
      break;
    }
    case 'plan':
      if (typeof raw.text !== 'string') return null;
      out.text = b.text(raw.text);
      break;
    default: return null;
  }
  if (b.truncated) out.activityTruncated = true;
  return out;
}

export function turnDiffActivity(turnId, diff, items = [], status = 'completed') {
  if (!validId(turnId) || typeof diff !== 'string' || !diff.trim()) return null;
  const trimmed = diff.trim();
  const changes = items.filter(item => item?.type === 'fileChange').flatMap(item => Array.isArray(item.changes) ? item.changes : []);
  const existing = changes.map(change => typeof change?.diff === 'string' ? change.diff.trim() : '').filter(Boolean);
  if (existing.includes(trimmed) || existing.join('\n') === trimmed) return null;
  const id = 'co2:turn-diff:' + createHash('sha256').update(turnId).digest('hex').slice(0, 32);
  if (items.some(item => item?.id === id)) return null;
  return projectActivity({ id, type: 'fileChange', status, changes: [{ path: '回合变更', kind: { type: 'update' }, diff }] });
}

export function activityItem(raw, key) {
  const item = projectActivity(raw);
  if (!item) return null;
  const detail = {}, output = { id: item.id, role: 'activity' };
  switch (item.type) {
    case 'commandExecution':
      detail.kind = 'command'; detail.title = item.command || '命令执行'; detail.status = item.status;
      detail.text = item.aggregatedOutput;
      timing(item, detail);
      break;
    case 'mcpToolCall':
      detail.kind = 'tool'; detail.title = [item.server, item.tool].filter(Boolean).join(' / ') || '工具调用';
      detail.status = item.status;
      detail.text = [item.result?.content?.[0]?.text, item.error?.message].filter(Boolean).join('\n');
      timing(item, detail);
      break;
    case 'dynamicToolCall':
      detail.kind = 'tool'; detail.title = [item.namespace, item.tool].filter(Boolean).join(' / ') || '工具调用';
      detail.status = item.status; detail.text = item.contentItems?.[0]?.text || '';
      timing(item, detail);
      break;
    case 'functionCallOutput':
      detail.kind = 'tool'; detail.title = [item.namespace, item.name].filter(Boolean).join(' / ') || '工具结果';
      detail.status = 'completed'; detail.text = item.output;
      break;
    case 'fileChange':
      detail.kind = 'diff'; detail.title = item.changes.length ? `文件变更 · ${item.changes.length} 项` : '文件变更';
      detail.status = item.status;
      detail.files = item.changes.map(change => ({ path: change.path, kind: change.kind.type, diff: change.diff }));
      break;
    case 'todo-list':
      detail.kind = 'plan'; detail.title = '执行计划'; detail.text = item.explanation;
      detail.steps = item.plan;
      detail.status = item.plan.some(step => step.status === 'running') ? 'running'
        : item.plan.length && item.plan.every(step => step.status === 'completed') ? 'completed' : 'pending';
      break;
    case 'plan':
      detail.kind = 'plan'; detail.title = '计划'; detail.text = item.text; detail.status = 'completed';
      break;
    default: return null;
  }
  if (item.activityTruncated) detail.truncated = true;
  const bytes = Buffer.from(JSON.stringify(detail));
  if (bytes.length > MAX_ACTIVITY_DETAIL_BYTES) throw new Error('Activity detail exceeds limit');
  output.kind = detail.kind; output.status = detail.status;
  output.text = [...detail.title].slice(0, 160).join('');
  output.detailId = createHmac('sha256', key).update(JSON.stringify(['activity', item.id])).update(bytes).digest('hex');
  if (detail.kind === 'diff') output.summary = item[SUMMARY];
  if (detail.kind === 'plan' && detail.text) {
    let preview = detail.text.slice(0, 1024);
    while (Buffer.byteLength(preview) > 1024) preview = preview.slice(0, -1);
    if (/[\uD800-\uDBFF]$/u.test(preview)) preview = preview.slice(0, -1);
    output.preview = preview;
  }
  output[DETAIL] = bytes;
  return output;
}

export function activityDetail(item) {
  const bytes = item?.[DETAIL];
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ACTIVITY_DETAIL_BYTES) throw new Error('Unavailable activity');
  return { bytes: Buffer.from(bytes), mime: 'application/json' };
}

export const activityDetailBytes = item => Buffer.isBuffer(item?.[DETAIL]) ? item[DETAIL].length : 0;
