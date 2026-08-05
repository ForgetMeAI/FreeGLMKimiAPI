import fs from 'fs';
import path from 'path';

function truthy(v) { return ['1','true','yes','on'].includes(String(v ?? '').toLowerCase()); }
function normalizeProvider(provider) {
  const p = String(provider || '').toLowerCase().trim();
  if (!['glm', 'kimi'].includes(p)) throw new Error('provider must be "glm" or "kimi"');
  return p;
}
function tokenPresent(a) { return !!(a.token || a.refresh_token || a.refreshToken || a.access_token || a.accessToken); }
function clone(a) { return JSON.parse(JSON.stringify(a)); }

export class AccountManager {
  constructor({ authPath, env = process.env, now = () => Date.now(), cooldownMs = 60_000 } = {}) {
    this.authPath = authPath || path.join(process.cwd(), 'auth.json');
    this.env = env;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.rr = new Map();
    this.accounts = [];
    this.load();
  }

  load() {
    const accounts = [];
    if (fs.existsSync(this.authPath)) {
      const raw = JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
      if (Array.isArray(raw.accounts)) accounts.push(...raw.accounts);
      else if (raw.provider) accounts.push(raw);
    }
    if (this.env.GLM_TOKEN) accounts.push({ id: 'glm-env', provider: 'glm', token: this.env.GLM_TOKEN, source: 'env' });
    else if (this.env.GLM_REFRESH_TOKEN) accounts.push({ id: 'glm-env', provider: 'glm', refresh_token: this.env.GLM_REFRESH_TOKEN, backend: this.env.GLM_BACKEND || 'chatglm', source: 'env' });
    if (this.env.KIMI_TOKEN) accounts.push({ id: 'kimi-env', provider: 'kimi', token: this.env.KIMI_TOKEN, source: 'env' });
    this.accounts = accounts.map((a, i) => this._normalize(a, i));
    return this.list();
  }

  reload() { return this.load(); }

  _normalize(account, index = 0) {
    const provider = normalizeProvider(account.provider);
    const id = account.id || `${provider}-${index + 1}`;
    return {
      ...clone(account),
      id,
      provider,
      ok: account.ok !== false,
      requestCount: Number(account.requestCount || 0),
      failCount: Number(account.failCount || 0),
      lastError: account.lastError || '',
      cooldownUntil: Number(account.cooldownUntil || 0)
    };
  }

  _safe(a) {
    return {
      id: a.id,
      provider: a.provider,
      ok: this.isAvailable(a),
      hasToken: tokenPresent(a),
      requestCount: a.requestCount || 0,
      failCount: a.failCount || 0,
      lastError: a.lastError || '',
      cooldownUntil: a.cooldownUntil || 0
    };
  }

  list() { return this.accounts.map(a => this._safe(a)); }
  rawList() { return this.accounts; }
  get(id) { return this.accounts.find(a => a.id === id); }
  isAvailable(a) { return Number(a.cooldownUntil || 0) <= this.now(); }

  add(account, { persist = truthy(this.env.PERSIST_ADMIN_ACCOUNTS ?? '1') } = {}) {
    const normalized = this._normalize(account, this.accounts.length);
    if (!tokenPresent(normalized)) throw new Error('account token missing: use token/access_token for Kimi or refresh_token/access_token for GLM');
    const idx = this.accounts.findIndex(a => a.id === normalized.id);
    if (idx >= 0) this.accounts[idx] = { ...this.accounts[idx], ...normalized };
    else this.accounts.push(normalized);
    if (persist) this.persist();
    return this._safe(normalized);
  }

  delete(id, { persist = truthy(this.env.PERSIST_ADMIN_ACCOUNTS ?? '1') } = {}) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter(a => a.id !== id);
    const deleted = this.accounts.length !== before;
    if (deleted && persist) this.persist();
    return deleted;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.authPath), { recursive: true });
    const accounts = this.accounts
      .filter(a => a.source !== 'env')
      .map(({ ok, requestCount, failCount, lastError, cooldownUntil, source, ...rest }) => rest);
    fs.writeFileSync(this.authPath, JSON.stringify({ accounts }, null, 2));
  }

  select(provider, session = {}) {
    provider = normalizeProvider(provider);
    const candidates = this.accounts.filter(a => a.provider === provider);
    if (!candidates.length) throw new Error(`No ${provider} account configured. Set MOCK_PROVIDER=1 for local smoke or add auth.json/env token.`);

    if (session.accountId) {
      const sticky = candidates.find(a => a.id === session.accountId);
      if (sticky && this.isAvailable(sticky)) return this._selected(sticky, session);
    }

    const available = candidates.filter(a => this.isAvailable(a));
    const pool = available.length ? available : candidates;
    const pos = this.rr.get(provider) || 0;
    const picked = pool[pos % pool.length];
    this.rr.set(provider, pos + 1);
    return this._selected(picked, session);
  }

  _selected(a, session) {
    a.requestCount = (a.requestCount || 0) + 1;
    if (session) session.accountId = a.id;
    return a;
  }

  /**
   * Update an account's token (and optionally cookie) in-place and persist.
   * Called by the auto-relogin flow after a CDP token refresh.
   */
  updateToken(id, { token, cookie } = {}, { persist = truthy(this.env.PERSIST_ADMIN_ACCOUNTS ?? '1') } = {}) {
    const a = this.get(id);
    if (!a) return null;
    if (token) a.token = token;
    if (cookie) a.cookie = cookie;
    a.ok = true;
    a.lastError = '';
    a.cooldownUntil = 0;
    if (persist) this.persist();
    return this._safe(a);
  }

  markSuccess(id) {
    const a = this.get(id);
    if (!a) return;
    a.ok = true;
    a.lastError = '';
    a.cooldownUntil = 0;
  }

  markFailure(id, error) {
    const a = this.get(id);
    if (!a) return;
    a.ok = false;
    a.failCount = (a.failCount || 0) + 1;
    a.lastError = error?.message || String(error || 'unknown error');
    a.cooldownUntil = this.now() + this.cooldownMs;
  }
}
