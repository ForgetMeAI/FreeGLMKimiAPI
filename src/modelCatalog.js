import fs from 'fs';
import path from 'path';

// Patterns that indicate a provider rejected the *model itself* (wrong/dead
// model id, dead assistant_id, etc.) rather than a transient/account/session
// problem. Deliberately narrow: every pattern requires the literal word
// "model" (or "assistant") next to the not-found/invalid phrasing. This is
// what keeps it from ever matching Kimi's real
// `REASON_CHAT_MESSAGE_NOT_FOUND` / "Chat message not found" error, which
// contains "not found" but never "model" or "assistant" anywhere near it —
// see tests/modelCatalog.test.js, which asserts this against the exact
// string this proxy has actually produced in production.
export const MODEL_ERROR_PATTERNS = [
  /\bmodel[_\s-]?not[_\s-]?found\b/i,
  /\bunknown\s+model\b/i,
  /\bunsupported\s+model\b/i,
  /\binvalid\s+model\b/i,
  /\bno\s+such\s+model\b/i,
  /\bmodel\b[^\n]{0,60}\b(is\s+)?(not\s+available|does\s+not\s+exist|has\s+been\s+retired|deprecated|no\s+longer\s+(supported|available))\b/i,
  /\binvalid\s+assistant[_\s-]?id\b/i,
  /\bassistant\s+not\s+found\b/i,
];

function compileExtraPatterns(extra) {
  if (!extra) return [];
  const list = Array.isArray(extra) ? extra : (() => { try { return JSON.parse(extra); } catch { return []; } })();
  return list.map(p => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
}

export function isModelError(err, extraPatterns = []) {
  const msg = String(err?.message || err || '');
  return MODEL_ERROR_PATTERNS.some(re => re.test(msg)) || extraPatterns.some(re => re.test(msg));
}

function modelKey(provider, id) { return `${provider}:${id}`; }

export class ModelCatalog {
  constructor({ staticModels = {}, catalogPath = '', retireAfterFailures = 3, extraErrorPatterns = null, now = () => Date.now() } = {}) {
    this.staticModels = staticModels;
    this.catalogPath = catalogPath;
    this.retireAfterFailures = Math.max(1, Number(retireAfterFailures) || 3);
    this.extraPatterns = compileExtraPatterns(extraErrorPatterns);
    this.now = now;
    this.entries = new Map(); // key -> { id, provider, thinking, webSearch, deepResearch, status, source, consecutiveFailures, firstSeenAt, lastSeenAt, lastErrorAt, lastError, retiredAt }
    this.load();
  }

  load() {
    if (!this.catalogPath || !fs.existsSync(this.catalogPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.catalogPath, 'utf8'));
      for (const e of raw.models || []) this.entries.set(modelKey(e.provider, e.id), e);
    } catch (err) {
      console.error('[FreeGLMKimiAPI] failed to load model catalog, starting fresh:', err.message);
    }
  }

  persist() {
    if (!this.catalogPath) return;
    try {
      fs.mkdirSync(path.dirname(this.catalogPath), { recursive: true });
      fs.writeFileSync(this.catalogPath, JSON.stringify({ models: [...this.entries.values()] }, null, 2));
    } catch (err) {
      console.error('[FreeGLMKimiAPI] failed to persist model catalog:', err.message);
    }
  }

  _upsertBase(modelCfg) {
    const key = modelKey(modelCfg.provider, modelCfg.id);
    let e = this.entries.get(key);
    if (!e) {
      const isStatic = Object.prototype.hasOwnProperty.call(this.staticModels, modelCfg.id);
      e = {
        id: modelCfg.id, provider: modelCfg.provider,
        thinking: !!modelCfg.thinking, webSearch: !!modelCfg.webSearch, deepResearch: !!modelCfg.deepResearch,
        status: 'active', source: isStatic ? 'static' : 'discovered',
        consecutiveFailures: 0, firstSeenAt: this.now(), lastSeenAt: 0, lastErrorAt: 0, lastError: '', retiredAt: 0
      };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Call after a real completion against this model succeeds. Promotes
   * never-before-seen (but successfully used) model ids into the visible
   * catalog, and clears any retired/failure state for known ones — this is
   * "auto-discovery" and "un-retirement", both driven by real observed
   * traffic rather than a guessed introspection endpoint. */
  recordSuccess(modelCfg) {
    const e = this._upsertBase(modelCfg);
    e.status = 'active'; e.consecutiveFailures = 0; e.lastSeenAt = this.now(); e.retiredAt = 0;
    this.persist();
    return e;
  }

  /** Call after a completion fails with an isModelError()-shaped error.
   * After `retireAfterFailures` consecutive such failures the model is
   * retired (stops being advertised by list()) until either a success is
   * observed again or it's manually restored. */
  recordFailure(modelCfg, err) {
    const e = this._upsertBase(modelCfg);
    e.consecutiveFailures += 1;
    e.lastErrorAt = this.now();
    e.lastError = String(err?.message || err || '').slice(0, 300);
    if (e.consecutiveFailures >= this.retireAfterFailures) { e.status = 'retired'; e.retiredAt = this.now(); }
    this.persist();
    return e;
  }

  /** Manual admin override: force a model back to active with a clean slate. */
  restore(provider, id) {
    const key = modelKey(provider, id);
    const e = this.entries.get(key);
    if (e) { e.status = 'active'; e.consecutiveFailures = 0; e.retiredAt = 0; this.persist(); return e; }
    // Not previously observed at all (e.g. a static model that never even
    // got a catalog row) — nothing to restore, it's implicitly active.
    return null;
  }

  /** Manual admin override: register or edit a model entry directly, without
   * waiting for organic traffic (e.g. you read about a new model on the
   * provider's blog before anyone has actually requested it yet). */
  upsert(entry) {
    if (!entry?.id || !entry?.provider) throw new Error('upsert requires at least {id, provider}');
    const key = modelKey(entry.provider, entry.id);
    const existing = this.entries.get(key);
    const isStatic = Object.prototype.hasOwnProperty.call(this.staticModels, entry.id);
    const e = {
      id: entry.id, provider: entry.provider,
      thinking: !!entry.thinking, webSearch: !!entry.webSearch, deepResearch: !!entry.deepResearch,
      status: entry.status || existing?.status || 'active',
      source: existing?.source || (isStatic ? 'static' : 'manual'),
      consecutiveFailures: existing?.consecutiveFailures || 0,
      firstSeenAt: existing?.firstSeenAt || this.now(), lastSeenAt: existing?.lastSeenAt || 0,
      lastErrorAt: existing?.lastErrorAt || 0, lastError: existing?.lastError || '',
      retiredAt: entry.status === 'retired' ? this.now() : 0
    };
    this.entries.set(key, e);
    this.persist();
    return e;
  }

  /** Remove a discovered/manual entry entirely (static baseline entries
   * can't be removed this way — retire() them instead, since removing them
   * would just make them silently reappear as an untracked static model). */
  remove(provider, id) {
    const key = modelKey(provider, id);
    const e = this.entries.get(key);
    if (!e || e.source === 'static') return false;
    this.entries.delete(key);
    this.persist();
    return true;
  }

  isRetired(provider, id) {
    return this.entries.get(modelKey(provider, id))?.status === 'retired';
  }

  /** Merged view: every static-baseline model not overridden as retired,
   * plus every discovered/manual entry that's active — or everything,
   * including retired ones and their failure info, if includeRetired. */
  list({ includeRetired = false } = {}) {
    const out = [];
    for (const [id, def] of Object.entries(this.staticModels)) {
      const e = this.entries.get(modelKey(def.provider, id));
      if (!e) { out.push({ id, provider: def.provider, thinking: !!def.thinking, webSearch: !!def.webSearch, deepResearch: !!def.deepResearch, status: 'active', source: 'static' }); continue; }
      if (e.status === 'retired' && !includeRetired) continue;
      out.push(e);
    }
    for (const e of this.entries.values()) {
      if (Object.prototype.hasOwnProperty.call(this.staticModels, e.id)) continue; // already covered above
      if (e.status === 'retired' && !includeRetired) continue;
      out.push(e);
    }
    return out;
  }
}
