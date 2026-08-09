import http from 'http';

/**
 * zaiTokenRefresh.js — JWT TTL checking, auth-error detection, and CDP-based
 * auto-relogin for the Z.ai (chat.z.ai) bridge.
 *
 * Flow:
 *   1. Proactive: periodically check token TTL; if below threshold, refresh.
 *   2. Reactive:  on 401 / auth-error response, refresh and retry.
 *   3. Refresh:   connect to a running Chrome CDP endpoint, find or navigate
 *                 to chat.z.ai, read localStorage `token` + cookies, return them.
 */

// ── JWT utilities ──────────────────────────────────────────────

export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function getTokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  // Z.ai JWT uses `exp` (seconds since epoch) — standard JWT claim.
  if (typeof payload.exp === 'number') return payload.exp * 1000;
  // Some tokens use `exp_ms` or `expires_at`.
  if (typeof payload.exp_ms === 'number') return payload.exp_ms;
  if (typeof payload.expires_at === 'number') return payload.expires_at * 1000;
  return null;
}

export function getTokenTtlMs(token, now = Date.now) {
  const expiry = getTokenExpiry(token);
  if (expiry == null) return Infinity; // no exp claim → assume non-expiring
  return expiry - now();
}

export function isTokenExpired(token, { thresholdMs = 0, now = Date.now } = {}) {
  const ttl = getTokenTtlMs(token, now);
  return ttl <= thresholdMs;
}

// ── Auth error detection ───────────────────────────────────────

const AUTH_ERROR_PATTERNS = [
  /"code"\s*:\s*["']?UNAUTHORIZED["']?/i,
  /"code"\s*:\s*["']?TOKEN_EXPIRED["']?/i,
  /"code"\s*:\s*["']?INVALID_TOKEN["']?/i,
  /"code"\s*:\s*["']?AUTH_?ERROR["']?/i,
  /"detail"\s*:\s*["'].*token.*expired.*["']/i,
  /"detail"\s*:\s*["'].*unauthorized.*["']/i,
  /"message"\s*:\s*["'].*token.*expired.*["']/i,
  /"message"\s*:\s*["'].*not.*authenticated.*["']/i,
  /authentication required/i,
  /token expired/i,
  /invalid token/i,
  /请先登录/i,         // "please log in first" (Z.ai CN)
  /登录已过期/i,        // "login has expired"
  /未授权/i,           // "unauthorized"
];

export function isZaiAuthError(status, raw) {
  if (status === 401 || status === 403) {
    // 403 can be captcha/WAF, not auth — check the body for auth-specific signals.
    if (status === 403) {
      const text = String(raw || '');
      // If it looks like captcha/WAF, it's not an auth error.
      if (/captcha|waf|aliyun|punish|forbidden/i.test(text)) return false;
      // Otherwise treat 403 as auth error if body has auth signals.
      return AUTH_ERROR_PATTERNS.some(re => re.test(text));
    }
    return true;
  }
  const text = String(raw || '');
  return AUTH_ERROR_PATTERNS.some(re => re.test(text));
}

// ── CDP token extraction ───────────────────────────────────────

/**
 * Discover the browser WebSocket URL from a CDP HTTP endpoint.
 * @param {string} cdpUrl — e.g. 'http://127.0.0.1:9222'
 * @returns {Promise<{browserWSEndpoint: string, targets: Array}>}
 */
export async function discoverCdpBrowser(cdpUrl) {
  const [versionRes, listRes] = await Promise.all([
    cdpHttp(cdpUrl, '/json/version'),
    cdpHttp(cdpUrl, '/json/list'),
  ]);
  if (!versionRes || !versionRes.webSocketDebuggerUrl) {
    throw new Error(`CDP: no browser WS endpoint at ${cdpUrl}`);
  }
  return {
    browserWSEndpoint: versionRes.webSocketDebuggerUrl,
    targets: Array.isArray(listRes) ? listRes : [],
  };
}

function cdpHttp(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`CDP HTTP timeout: ${url.href}`)); });
  });
}

/**
 * Connect to a running Chrome instance via CDP (using puppeteer-core),
 * find or navigate to a chat.z.ai tab, and extract the JWT token + cookies
 * from localStorage / cookie jar.
 *
 * @param {object} opts
 * @param {string} opts.cdpUrl — CDP HTTP endpoint (e.g. 'http://127.0.0.1:9222')
 * @param {object} [opts.logger] — console-like logger
 * @param {number} [opts.navTimeoutMs] — navigation timeout (default 30s)
 * @param {number} [opts.settleMs] — wait after load for localStorage to settle (default 3s)
 * @returns {Promise<{token: string, cookie: string, ok: boolean}>}
 */
export async function extractTokenFromCdpBrowser({ cdpUrl, logger = console, navTimeoutMs = 30_000, settleMs = 3000 }) {
  const puppeteer = await import('puppeteer-core').then(m => m.default || m);
  const { browserWSEndpoint, targets } = await discoverCdpBrowser(cdpUrl);

  // Try to find an existing chat.z.ai tab first.
  const existingZaiTarget = targets.find(t =>
    t.type === 'page' && String(t.url || '').includes('chat.z.ai')
  );

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
  } catch (err) {
    throw new Error(`CDP connect failed: ${err.message}`);
  }

  try {
    let page;
    if (existingZaiTarget) {
      // Reuse existing tab — puppeteer connects to it by targetId.
      page = await browser.targets()
        .find(t => t._targetId === existingZaiTarget.targetId)
        ?.page?.();
      if (!page) {
        // Fallback: search all pages.
        const pages = await browser.pages();
        page = pages.find(p => p.url().includes('chat.z.ai'));
      }
    }

    if (!page) {
      // Open a new tab to chat.z.ai.
      page = await browser.newPage();
      logger.info?.('[zai-refresh] opening new tab to chat.z.ai');
    }

    const currentUrl = page.url();
    if (!currentUrl.includes('chat.z.ai')) {
      logger.info?.('[zai-refresh] navigating to chat.z.ai');
      await page.goto('https://chat.z.ai', { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    } else {
      // Refresh the page to force token regeneration if session is still valid.
      logger.info?.('[zai-refresh] reloading existing chat.z.ai tab');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    }

    // Wait for localStorage to settle (Z.ai writes token after initial JS load).
    await new Promise(r => setTimeout(r, settleMs));

    const token = await page.evaluate(() => {
      try { return localStorage.getItem('token') || ''; } catch { return ''; }
    });

    if (!token || !token.startsWith('eyJ')) {
      // Maybe the app needs more time — try waiting a bit longer.
      await new Promise(r => setTimeout(r, settleMs));
      const retryToken = await page.evaluate(() => {
        try { return localStorage.getItem('token') || ''; } catch { return ''; }
      });
      if (!retryToken || !retryToken.startsWith('eyJ')) {
        return { token: '', cookie: '', ok: false, reason: 'no_token_in_localStorage' };
      }
      var finalToken = retryToken;
    } else {
      var finalToken = token;
    }

    // Extract cookies for anti-bot compatibility.
    const cookies = await page.cookies('https://chat.z.ai').catch(() => []);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    return { token: finalToken, cookie: cookieHeader, ok: true };
  } finally {
    // disconnect (not close!) — we don't want to kill the user's browser.
    browser.disconnect();
  }
}

// ── ZaiTokenRefresher ──────────────────────────────────────────

export class ZaiTokenRefresher {
  /**
   * @param {object} opts
   * @param {string} opts.cdpUrl — CDP HTTP endpoint
   * @param {number} [opts.thresholdMs] — proactive refresh threshold (default 5min)
   * @param {number} [opts.cooldownMs] — cooldown between refresh attempts (default 30s)
   * @param {number} [opts.maxRetries] — retries per refresh (default 2)
   * @param {object} [opts.logger]
   * @param {function} [opts.now] — injectable clock
   * @param {function} [opts.extractFn] — injectable extraction function (for testing)
   */
  constructor({
    cdpUrl,
    thresholdMs = 300_000,
    cooldownMs = 30_000,
    maxRetries = 2,
    logger = console,
    now = Date.now,
    extractFn = extractTokenFromCdpBrowser,
  } = {}) {
    if (!cdpUrl) throw new Error('ZaiTokenRefresher requires cdpUrl');
    this.cdpUrl = cdpUrl;
    this.thresholdMs = thresholdMs;
    this.cooldownMs = cooldownMs;
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.now = now;
    this.extractFn = extractFn;
    this._lastRefreshAt = 0;
    this._refreshing = null; // in-flight promise (dedup concurrent calls)
  }

  /**
   * Check if a token needs refreshing (TTL below threshold or expired).
   */
  needsRefresh(token) {
    return isTokenExpired(token, { thresholdMs: this.thresholdMs, now: this.now });
  }

  /**
   * Refresh the token via CDP. Deduplicates concurrent calls.
   * @returns {Promise<{token: string, cookie: string, ok: boolean} | null>}
   */
  async refresh() {
    // Dedup: if a refresh is already in flight, await it.
    if (this._refreshing) return this._refreshing;

    // Cooldown check.
    const elapsed = this.now() - this._lastRefreshAt;
    if (elapsed < this.cooldownMs) {
      this.logger.warn?.(`[zai-refresh] cooldown — ${Math.round((this.cooldownMs - elapsed) / 1000)}s remaining`);
      return null;
    }

    this._refreshing = this._doRefresh();
    try {
      return await this._refreshing;
    } finally {
      this._refreshing = null;
    }
  }

  async _doRefresh() {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger.info?.(`[zai-refresh] CDP extract attempt ${attempt + 1}/${this.maxRetries + 1}`);
        const result = await this.extractFn({
          cdpUrl: this.cdpUrl,
          logger: this.logger,
        });
        if (result?.ok && result?.token) {
          this._lastRefreshAt = this.now();
          this.logger.info?.(`[zai-refresh] success — token len=${result.token.length} cookie len=${result.cookie?.length || 0}`);
          return result;
        }
        lastError = new Error(result?.reason || 'extract returned no token');
      } catch (err) {
        lastError = err;
      }
      if (attempt < this.maxRetries) {
        const backoff = 2000 * (attempt + 1);
        this.logger.warn?.(`[zai-refresh] attempt ${attempt + 1} failed: ${lastError.message}; retrying in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    this._lastRefreshAt = this.now(); // set cooldown even on failure
    this.logger.error?.(`[zai-refresh] all attempts failed: ${lastError.message}`);
    return null;
  }

  /**
   * Start a periodic proactive refresh check.
   * @param {function} getTokens — () => Array<{id, token}> — accounts to check
   * @param {function} onRefresh — async (id, {token, cookie}) => void — called when token refreshed
   * @param {number} [intervalMs] — check interval (default 60s)
   * @returns {NodeJS.Timeout} interval handle
   */
  startProactiveRefresh(getTokens, onRefresh, intervalMs = 60_000) {
    const tick = async () => {
      try {
        const accounts = getTokens();
        for (const acct of accounts) {
          if (!acct.token) continue;
          if (this.needsRefresh(acct.token)) {
            const ttl = getTokenTtlMs(acct.token, this.now);
            this.logger.info?.(`[zai-refresh] proactive refresh for ${acct.id} (TTL=${Math.round(ttl / 1000)}s)`);
            const result = await this.refresh();
            if (result?.ok) {
              await onRefresh(acct.id, result);
            }
            break; // one refresh per tick is enough — all accounts share the same browser session
          }
        }
      } catch (err) {
        this.logger.error?.(`[zai-refresh] proactive tick error: ${err.message}`);
      }
    };
    // Fire immediately, then on interval.
    tick();
    return setInterval(tick, intervalMs);
  }
}
