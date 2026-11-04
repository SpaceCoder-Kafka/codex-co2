// This is a display projection, not an identity or file-authorization parser.
// Only complete native envelopes are unwrapped; quoted/fenced examples remain
// ordinary user text and arbitrary context fields never enter the snapshot.
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_TIME = 8.64e15;
export const USER_SOURCE_TEXT = Symbol('private original user text for attribution');
// Only Desktop's original turn/steering input can provide this evidence. A
// rendered or backend-normalized message body is not an original-input proof.
export const NATIVE_INPUT_DIGEST = Symbol('private native submitted input digest');
export const NATIVE_INPUT_ID = Symbol('private native submitted input identity');
export function nativeCreatedAt(value) {
  return Number.isFinite(value) && value > 0 && value <= MAX_TIME ? value : undefined;
}

export function userMessageMetadata(raw, { createdAt, clientId } = {}) {
  const time = nativeCreatedAt(raw?.createdAt) ?? nativeCreatedAt(raw?.sentAtMs)
    ?? nativeCreatedAt(raw?.restoreMessage?.createdAt) ?? nativeCreatedAt(createdAt);
  const nativeClientId = raw?.clientId ?? raw?.clientUserMessageId ?? clientId;
  const aeon = raw?.messageMetadata?.aeon;
  const nativeChatGPT = aeon?.version === 1 && aeon.sourceChannel === 'chatgpt'
    && typeof aeon.sourceId === 'string' && aeon.sourceId.length > 0 && aeon.sourceId.length <= 256
    && typeof aeon.threadId === 'string' && aeon.threadId.length > 0;
  return { ...(time !== undefined ? { createdAt: time } : {}),
    ...(nativeChatGPT || typeof nativeClientId === 'string' && nativeClientId.startsWith('chatgpt-messaging:')
      ? { source: { kind: 'chatgpt' } } : ['chatgpt', 'cross_chat'].includes(raw?.source?.kind) ? { source: { kind: raw.source.kind } } : {}) };
}

// Desktop presents this exact tool-output envelope as a user intent already
// delivered to the current conversation. Only its input/task is visible here;
// origin IDs never authorize opening or reading the originating conversation.
export function delegatedUserIntent(raw) {
  const allowed = raw?.type === 'functionCallOutput' && (raw.namespace === 'codex_app'
    && ['create_thread', 'send_message_to_thread', 'handoff_thread'].includes(raw.name)
    || raw.namespace === 'cloud_threads' && raw.name === 'send_message');
  if (!allowed || typeof raw.output !== 'string' || Buffer.byteLength(raw.output) > MAX_ENVELOPE_BYTES) return null;
  const envelope = /^<codex_delegation>\s*<source_thread_id>([^<]*)<\/source_thread_id>\s*(?:<source_orbit_id>([^<]*)<\/source_orbit_id>\s*)?<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/u.exec(raw.output.trim());
  if (!envelope) return null;
  const decode = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const inner = envelope[3], nested = /^<codex_delegation_content version="1">\s*<source_orbit_id>([^<]*)<\/source_orbit_id>\s*<task>([^<]*)<\/task>\s*<\/codex_delegation_content>$/u.exec(inner.trim());
  if (nested && envelope[2] != null || !nested && inner.includes('<')) return null;
  const text = decode(nested ? nested[2] : inner.trim());
  const metadata = userMessageMetadata(raw);
  return { text, source: metadata.source?.kind === 'chatgpt' ? metadata.source : { kind: 'cross_chat' } };
}

export function userPresentation(text, nativePlan) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) return { text };
  const trimmed = text.trim();
  const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/u.exec(trimmed);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]), replies = Array.isArray(parsed) ? parsed : [parsed];
      if (replies.length && replies.length <= 64 && replies.every(reply => reply && typeof reply === 'object'
        && !Array.isArray(reply) && typeof reply.questionItemId === 'string'
        && typeof reply.question === 'string' && typeof reply.answer === 'string')) {
        const safeReplies = replies.map(({ question, answer }) => ({ question, answer }));
        return { text: safeReplies.map(reply => reply.answer).join('\n\n'),
          presentation: { kind: 'question_reply', replies: safeReplies } };
      }
    } catch { /* A malformed envelope remains readable as ordinary text. */ }
  }
  const plan = /^PLEASE IMPLEMENT THIS PLAN:\r?\n([\s\S]+)$/u.exec(trimmed);
  if (plan && plan[1].trim()) return { text: '是的，执行此计划',
    presentation: { kind: 'plan_execution', plan: typeof nativePlan === 'string' && nativePlan.trim() ? nativePlan : plan[1].trim() } };
  return { text };
}

// Re-project an already normalized message without reintroducing raw envelopes.
export function safeUserPresentation(value) {
  if (value?.kind === 'question_reply' && Array.isArray(value.replies) && value.replies.length <= 64
    && value.replies.length && value.replies.every(reply => typeof reply?.question === 'string' && typeof reply.answer === 'string')) {
    return { kind: 'question_reply', replies: value.replies.map(({ question, answer }) => ({ question, answer })) };
  }
  if (value?.kind === 'plan_execution' && typeof value.plan === 'string') return { kind: 'plan_execution', plan: value.plan };
  return undefined;
}
