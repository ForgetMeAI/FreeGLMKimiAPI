export class SessionStore {
  constructor({ ttlMs = 2 * 60 * 60 * 1000, maxDepth = 100 } = {}) {
    this.ttlMs = ttlMs; this.maxDepth = maxDepth; this.sessions = new Map(); this.locks = new Map();
  }
  get(agentId='default', provider='kimi') {
    const key = `${provider}:${agentId || 'default'}`;
    let s = this.sessions.get(key);
    const now = Date.now();
    if (!s) s = { key, provider, agentId, providerSessionId:'', parentMessageId:'', createdAt:now, messageCount:0, history:[] };
    if ((now - s.createdAt > this.ttlMs) || s.messageCount >= this.maxDepth) {
      s.providerSessionId=''; s.parentMessageId=''; s.createdAt=now; s.messageCount=0;
    }
    this.sessions.set(key,s); return s;
  }
  update(s, { providerSessionId, parentMessageId } = {}) {
    if (providerSessionId) s.providerSessionId = providerSessionId;
    if (parentMessageId) s.parentMessageId = parentMessageId;
    s.messageCount += 1; this.sessions.set(s.key,s); return s;
  }
  dump() { return [...this.sessions.values()].map(s => ({...s, history: undefined})); }
  // Provider-side chat continuity (chat_id/parent_id) is inherently
  // sequential per key: two requests for the same agentId+provider racing in
  // parallel would both read the same parentMessageId before either
  // response comes back, so whichever update() finishes last silently
  // clobbers the chat_id/parent_id the other call needed for its own next
  // turn. That produces exactly the "chat message not found" shape of error
  // on a later turn. withLock() queues callers by key so only one request
  // per session is ever in flight against the provider at a time; unrelated
  // sessions are never blocked by each other.
  withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(key, run.catch(() => {}));
    return run;
  }
}
