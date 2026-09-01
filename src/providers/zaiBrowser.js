import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ZAI_BASE, ZAI_USER_AGENT, parseZaiSse } from './zai.js';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.free-glm-kimi-api', 'zai-browser-profile');
const DEFAULT_CLOAK_PROFILE_DIR = path.join(os.homedir(), '.free-glm-kimi-api', 'zai-cloak-profile');
const TRANSIENT_HEADER_RE = /^(accept-encoding|connection|content-length|host|origin|referer|priority)$|^(sec-fetch-|sec-ch-)/i;
const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

// Global semaphore to serialize browser operations (prevents CPU spikes from concurrent Chromium instances)
let browserSemaphore = Promise.resolve();
function withBrowserLock(fn) {
  const run = browserSemaphore.then(fn, fn);
  browserSemaphore = run.catch(() => {});
  return run;
}

export function isZaiCaptchaError(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return /captcha|FRONTEND_CAPTCHA_REQUIRED|verify again|verification failed|refresh the page to update the app|人机验证失败|请重新验证|刷新页面以更新应用|aliyun|waf|punish/i.test(text);
}

export function shouldUseZaiBrowserFallback(env = process.env, account = {}) {
  const raw = account.browser_fallback ?? account.browserFallback ?? env.ZAI_BROWSER_FALLBACK ?? '';
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export function browserSafeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!key || value == null) continue;
    if (TRANSIENT_HEADER_RE.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

export function defaultChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || undefined;
}

export function cleanChromeProfileLocks(profileDir) {
  const removed = [];
  const visit = (dir, depth = 0) => {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (LOCK_FILES.includes(entry.name) || entry.name === 'LOCK') {
        try {
          fs.rmSync(entryPath, { force: true, recursive: true });
          removed.push(path.relative(profileDir, entryPath) || entry.name);
        } catch {}
      } else if (entry.isDirectory() && ['Default', 'Profile 1', 'Profile 2'].includes(entry.name)) {
        visit(entryPath, depth + 1);
      }
    }
  };
  visit(profileDir);
  return removed;
}

export function selectedBrowserEngine(env = process.env) {
  const raw = String(env.ZAI_BROWSER_ENGINE || '').trim().toLowerCase();
  if (['cloak', 'cloakbrowser'].includes(raw)) return 'cloak';
  if (['puppeteer', 'chrome'].includes(raw)) return 'puppeteer';
  return 'puppeteer';
}

export function parseBrowserHeadless(env = process.env) {
  const headlessRaw = String(env.ZAI_BROWSER_HEADLESS ?? 'true').toLowerCase();
  return ['0', 'false', 'no', 'off'].includes(headlessRaw) ? false : 'new';
}

function envBool(env, key, defaultValue = false) {
  const raw = env[key];
  if (raw == null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }

// Pulled out as a pure function (env in, args out) so the flag list is
// testable without launching real Chromium. The extra flags beyond the
// original 7 are standard, no-downside hardening for running headless
// Chrome unattended in a container with no GPU: without --disable-gpu,
// Chrome can fall back to software rendering (SwiftShader), which keeps a
// core busy for as long as the page is open; the --disable-*-throttling /
// --disable-backgrounding-* flags stop Chrome from doing extra background
// bookkeeping work on hidden/backgrounded tabs, which is irrelevant in a
// headless server context and otherwise just burns CPU for no benefit here.
export function puppeteerLaunchArgs(env = process.env) {
  const isHeadless = parseBrowserHeadless(env) !== false;
  const isRoot = process.getuid?.() === 0;
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=ru-RU',
    '--window-size=1365,768',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
  ];

  // Sandbox flags: --no-sandbox and --disable-setuid-sandbox are required
  // when running as root in Docker. Always enable when running as root,
  // allow override via ZAI_BROWSER_NO_SANDBOX=0 to disable.
  const forceNoSandbox = isRoot || env.ZAI_BROWSER_NO_SANDBOX !== '0';
  if (forceNoSandbox) {
    args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

  // Extra stealth flags for headless mode to avoid detection
  if (isHeadless) {
    args.push(
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--disable-blink-features=AutomationControlled'
    );
  }

  if (env.ZAI_BROWSER_PUPPETEER_ARGS) {
    args.push(...env.ZAI_BROWSER_PUPPETEER_ARGS.split(/\s+/).filter(Boolean));
  }
  return args;
}

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000; // close the idle browser after 10 min of no use
const DEFAULT_IDLE_CHECK_MS = 60 * 1000;

async function loadPuppeteer() {
  const [{ default: puppeteerExtra }, { default: StealthPlugin }] = await Promise.all([
    import('puppeteer-extra'),
    import('puppeteer-extra-plugin-stealth')
  ]);
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra;
}

async function launchCloakContext({ env, profileDir, headless, logger }) {
  const { launchPersistentContext } = await import('cloakbrowser');
  const viewport = {
    width: Number(env.ZAI_BROWSER_WIDTH || env.ZAI_SCREEN_WIDTH || 1365),
    height: Number(env.ZAI_BROWSER_HEIGHT || env.ZAI_SCREEN_HEIGHT || 768)
  };
  
  // In headless mode, force humanize to prevent detection
  const useHumanize = headless === false ? envBool(env, 'ZAI_BROWSER_HUMANIZE', true) : true;
  
  const context = await launchPersistentContext({
    userDataDir: profileDir,
    headless: headless === false ? false : true,
    humanize: useHumanize,
    humanPreset: env.ZAI_BROWSER_HUMAN_PRESET || 'careful',
    locale: env.ZAI_BROWSER_LOCALE || env.ZAI_LANGUAGE || 'ru-RU',
    timezone: env.ZAI_BROWSER_TIMEZONE || env.ZAI_TIMEZONE || 'Europe/Samara',
    userAgent: env.ZAI_USER_AGENT || ZAI_USER_AGENT,
    viewport,
    colorScheme: env.ZAI_BROWSER_COLOR_SCHEME || undefined,
    proxy: env.ZAI_BROWSER_PROXY || undefined,
    geoip: envBool(env, 'ZAI_BROWSER_GEOIP', false),
    args: [
      `--window-size=${viewport.width},${viewport.height}`,
      ...(env.ZAI_BROWSER_ARGS ? env.ZAI_BROWSER_ARGS.split(/\s+/).filter(Boolean) : [])
    ]
  });
  logger?.info?.('[zai-browser] launched CloakBrowser persistent context');
  return context;
}

export class ZaiBrowserClient {
  constructor({ env = process.env, logger = console } = {}) {
    this.env = env;
    this.logger = logger;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.engine = selectedBrowserEngine(env);
    this.profileDir = env.ZAI_BROWSER_PROFILE_DIR || (this.engine === 'cloak' ? DEFAULT_CLOAK_PROFILE_DIR : DEFAULT_PROFILE_DIR);
    // Diagnostics for exactly the kind of problem that motivated this: every
    // scratch page opened by completeViaUi() gets tracked here so a leak
    // (one never closed) is visible in logs/GET /admin/browser instead of
    // silently accumulating Chromium renderer processes in the background.
    this.openScratchPages = new Set();
    this.launchedAt = 0;
    this.lastUsedAt = 0;
    this.requestCount = 0;
    this._idleTimer = null;
  }

  touch() { this.lastUsedAt = Date.now(); }

  // Bounds worst-case resource usage even against a leak this pass didn't
  // find: if nothing has used the browser in ZAI_BROWSER_IDLE_CLOSE_MS
  // (default 10 min), close it. It relaunches lazily on the next request,
  // same as if the container had just started. Runs on a plain interval
  // (unref'd so it never keeps the process alive by itself) — this is the
  // only timer in the codebase, and it does nothing but a cheap timestamp
  // comparison on every tick; the actual close only happens when genuinely
  // idle, which should be rare.
  _ensureIdleTimer() {
    if (this._idleTimer) return;
    const idleCloseMs = Number(this.env.ZAI_BROWSER_IDLE_CLOSE_MS ?? DEFAULT_IDLE_CLOSE_MS);
    if (idleCloseMs <= 0) return; // 0 disables auto-close entirely
    const checkMs = Number(this.env.ZAI_BROWSER_IDLE_CHECK_MS || DEFAULT_IDLE_CHECK_MS);
    this._idleTimer = setInterval(() => {
      if (!this.browser && !this.context) return;
      const idleFor = Date.now() - this.lastUsedAt;
      if (idleFor >= idleCloseMs) {
        this.logger?.info?.(`[zai-browser] idle for ${Math.round(idleFor / 1000)}s, closing browser to free resources (relaunches on next request)`);
        this.close().catch(err => this.logger?.error?.(`[zai-browser] error closing idle browser: ${err?.message || err}`));
      }
    }, checkMs);
    this._idleTimer.unref?.();
  }

  /** Snapshot for logging / GET /admin/browser. */
  describeState() {
    return {
      engine: this.engine,
      running: !!(this.browser || this.context),
      openScratchPages: this.openScratchPages.size,
      launchedAt: this.launchedAt || null,
      lastUsedAt: this.lastUsedAt || null,
      idleForMs: this.lastUsedAt ? Date.now() - this.lastUsedAt : null,
      requestCount: this.requestCount
    };
  }

  async launchPuppeteer(headless) {
    const puppeteer = await loadPuppeteer();
    const started = Date.now();
    const launchArgs = puppeteerLaunchArgs(this.env);
    this.logger?.info?.(`[zai-browser] launch args: ${launchArgs.join(' ')}`);
    try {
      this.browser = await puppeteer.launch({
        headless,
        executablePath: defaultChromeExecutable(),
        userDataDir: this.profileDir,
        defaultViewport: { width: 1365, height: 768, deviceScaleFactor: 1 },
        ignoreDefaultArgs: ['--enable-automation'],
        args: launchArgs
      });
    } catch (err) {
      const msg = err?.message || String(err);
      // Provide actionable guidance for the common root-in-Docker failure
      if (msg.includes('Running as root without --no-sandbox')) {
        this.logger?.error?.('[zai-browser] Chromium sandbox error: running as root requires --no-sandbox. ' +
          'Ensure ZAI_BROWSER_NO_SANDBOX is not set to "0". ' +
          'In Docker, run with --cap-add=SYS_ADMIN or use a non-root user.');
      }
      throw err;
    }
    this.logger?.info?.(`[zai-browser] launched puppeteer-extra Chromium in ${Date.now() - started}ms (headless=${headless})`);
    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
  }

  async ensurePage(token = '') {
    this.touch();
    this._ensureIdleTimer();
    if (this.page && !this.page.isClosed()) return this.page;
    fs.mkdirSync(this.profileDir, { recursive: true });
    cleanChromeProfileLocks(this.profileDir);
    const headless = parseBrowserHeadless(this.env);
    this.logger?.info?.(`[zai-browser] no live page — launching (engine=${this.engine}, headless=${headless})`);

    // In containers without display, force headless unless explicitly opted out
    // ZAI_BROWSER_FORCE_HEADLESS=0 to disable this auto-detection
    const forceHeadless = process.env.ZAI_BROWSER_FORCE_HEADLESS !== '0' && (!process.env.DISPLAY || process.env.FORCE_HEADLESS === '1');
    const effectiveHeadless = forceHeadless ? 'new' : headless;
    if (forceHeadless && headless !== 'new') {
      this.logger?.info?.('[zai-browser] no DISPLAY detected, forcing headless=new');
    }

    if (this.engine === 'cloak') {
      try {
        const launchTimeoutMs = Number(this.env.ZAI_BROWSER_LAUNCH_TIMEOUT || 90_000);
        this.logger?.info?.(`[zai-browser] launching CloakBrowser (timeout: ${launchTimeoutMs}ms)`);
        this.context = await Promise.race([
          launchCloakContext({ env: this.env, profileDir: this.profileDir, headless: effectiveHeadless, logger: this.logger }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`CloakBrowser launch timeout after ${launchTimeoutMs}ms`)), launchTimeoutMs))
        ]);
        const pages = this.context.pages();
        this.page = pages[0] || await this.context.newPage();
      } catch (err) {
        this.logger?.warn?.(`[zai-browser] CloakBrowser unavailable/failed, falling back to puppeteer-extra: ${err?.message || err}`);
        this.engine = 'puppeteer';
        await this.launchPuppeteer(effectiveHeadless);
      }
    } else {
      await this.launchPuppeteer(effectiveHeadless);
    }
    this.launchedAt = Date.now();

    await this.setupPage(this.page);
    if (token) await this.injectToken(this.page, token);
    return this.page;
  }

  async setupPage(page) {
    if (page.setUserAgent) await page.setUserAgent(this.env.ZAI_USER_AGENT || ZAI_USER_AGENT).catch(() => null);
    if (page.setExtraHTTPHeaders) await page.setExtraHTTPHeaders({ 'Accept-Language': this.env.ZAI_ACCEPT_LANGUAGE || 'zh-CN,zh;q=0.9,en;q=0.8' }).catch(() => null);
  }

  async injectToken(page, token) {
    await page.goto(ZAI_BASE, { waitUntil: 'domcontentloaded', timeout: Number(this.env.ZAI_BROWSER_NAV_TIMEOUT || 60_000) }).catch(() => null);
    await page.evaluate((t) => {
      try { localStorage.setItem('token', t); } catch {}
      try { document.cookie = `token=${t}; path=/; domain=.z.ai; SameSite=Lax; Secure`; } catch {}
    }, token);
  }

  async getToken() {
    const page = await this.ensurePage();
    return page.evaluate(() => {
      try { return localStorage.getItem('token') || ''; } catch { return ''; }
    });
  }

  async newPage() {
    if (this.context) return this.context.newPage();
    if (this.browser) return this.browser.newPage();
    await this.ensurePage();
    return this.context ? this.context.newPage() : this.browser.newPage();
  }

  /** Opens a page tracked for leak detection. Always pair with
   * closeScratchPage() in a try/finally — see completeViaUi(), which is the
   * only caller and the thing that used to leak a tab on every fallback. */
  async openScratchPage() {
    const page = await this.newPage();
    this.openScratchPages.add(page);
    if (this.openScratchPages.size > 1) {
      this.logger?.warn?.(`[zai-browser] ${this.openScratchPages.size} scratch pages open at once (expected at most 1) — possible leak or unusually high concurrency, see GET /admin/browser`);
    }
    return page;
  }

  async closeScratchPage(page) {
    this.openScratchPages.delete(page);
    await page.close().catch(err => this.logger?.warn?.(`[zai-browser] error closing scratch page: ${err?.message || err}`));
  }

  async completeRequest(req, { token = '', chatId = '' } = {}) {
    return withBrowserLock(async () => {
      this.touch();
      const page = await this.ensurePage(token);
      const target = chatId ? `${ZAI_BASE}/c/${chatId}` : ZAI_BASE;
      if (!page.url().startsWith(target)) {
        this.logger?.info?.(`[zai-browser] home page navigating to ${target}`);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Number(this.env.ZAI_BROWSER_NAV_TIMEOUT || 60_000) }).catch(() => null);
      }
      const payload = {
        url: req.url,
        headers: browserSafeHeaders(req.headers),
        body: req.body
      };
      const started = Date.now();
      const result = await page.evaluate(async (data) => {
        const response = await fetch(data.url, {
          method: 'POST',
          headers: data.headers,
          body: JSON.stringify(data.body),
          credentials: 'include'
        });
        const raw = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          raw
        };
      }, payload);
      this.logger?.info?.(`[zai-browser] in-page fetch completed in ${Date.now() - started}ms (ok=${result.ok}, status=${result.status})`);
      return result;
    });
  }

  async completeAndParse(req, options = {}) {
    this.requestCount += 1;
    const n = this.requestCount;
    this.logger?.info?.(`[zai-browser] completeAndParse #${n}: starting (in-page fetch first)`);
    let result;
    try {
      result = await this.completeRequest(req, options);
    } catch (err) {
      this.logger?.warn?.(`[zai-browser] completeAndParse #${n}: in-page fetch threw (${err?.message || err}) — falling back to full UI simulation`);
      const uiResult = await this.completeViaUi(req.body?.messages?.[0]?.content || req.body?.signature_prompt || 'Hello');
      return { ...uiResult, parsed: parseZaiSse(uiResult.raw) };
    }
    let parsed = parseZaiSse(result.raw);
    if (!result.ok || (parsed.error && isZaiCaptchaError(parsed.error))) {
      this.logger?.warn?.(`[zai-browser] completeAndParse #${n}: ${!result.ok ? `in-page fetch returned HTTP ${result.status}` : `looks like a captcha challenge (${parsed.error})`} — falling back to full UI simulation`);
      const uiResult = await this.completeViaUi(req.body?.messages?.[0]?.content || req.body?.signature_prompt || 'Hello');
      parsed = parseZaiSse(uiResult.raw);
      return { ...uiResult, parsed };
    }
    this.logger?.info?.(`[zai-browser] completeAndParse #${n}: in-page fetch succeeded directly, no UI fallback needed`);
    return { ...result, parsed };
  }

  async humanFillPrompt(page, prompt) {
    const selector = 'textarea';
    await page.waitForSelector(selector, { timeout: Number(this.env.ZAI_BROWSER_NAV_TIMEOUT || 60_000) });
    await sleep(randInt(250, 900));
    await page.click(selector).catch(() => null);
    await sleep(randInt(120, 350));
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier).catch(() => null);
    await page.keyboard.press('KeyA').catch(() => page.keyboard.press('A').catch(() => null));
    await page.keyboard.up(modifier).catch(() => null);
    await page.keyboard.press('Backspace').catch(() => null);
    await sleep(randInt(120, 420));
    const delay = Number(this.env.ZAI_BROWSER_TYPE_DELAY || randInt(18, 55));
    if (page.type) {
      await page.type(selector, prompt, { delay });
    } else {
      await page.evaluate((value) => {
        const textarea = document.querySelector('textarea');
        if (!textarea) throw new Error('Z.ai prompt textarea not found');
        textarea.focus();
        textarea.value = value;
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
    }
    await sleep(randInt(250, 850));
  }

  async completeViaUi(prompt) {
    return withBrowserLock(async () => {
      this.touch();
      // Just makes sure a browser/context exists — this is the persistent
      // "home" page used by completeRequest()'s lightweight in-page fetch
      // path, and completeViaUi() must never touch or replace it (see below).
      await this.ensurePage();
      const page = await this.openScratchPage();
      this.logger?.info?.(`[zai-browser] completeViaUi: opened scratch page (${this.openScratchPages.size} open)`);

      try {
        await this.setupPage(page);
        const navStarted = Date.now();
        const navTimeoutMs = Number(this.env.ZAI_BROWSER_NAV_TIMEOUT || 60_000);
        this.logger?.info?.(`[zai-browser] completeViaUi: navigating to ${ZAI_BASE} (timeout: ${navTimeoutMs}ms)`);
        try {
          await page.goto(ZAI_BASE, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
        } catch (navErr) {
          this.logger?.warn?.(`[zai-browser] completeViaUi: navigation failed: ${navErr?.message || navErr}`);
          throw new Error(`Navigation to ${ZAI_BASE} failed: ${navErr?.message || navErr}`);
        }
        this.logger?.info?.(`[zai-browser] completeViaUi: navigated to ${ZAI_BASE} in ${Date.now() - navStarted}ms`);

      // Tracked outside the Promise executor so a failure during prompt
      // submission (below) can tear down the timer/listener instead of
      // leaving them to fire later on a promise nobody is listening to
      // anymore (that orphaned rejection is what was crashing the process,
      // before this fix).
      let onResponse;
      let timeout;
      let heartbeat;
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (onResponse) page.off('response', onResponse);
      };

      // Default 60s completion timeout (was 120s) - overridable via env
      const completionTimeoutMs = Number(this.env.ZAI_BROWSER_COMPLETION_TIMEOUT || 60_000);
      const heartbeatMs = Number(this.env.ZAI_BROWSER_HEARTBEAT_MS || 15_000);
      this.logger?.info?.(`[zai-browser] completeViaUi: completion timeout set to ${completionTimeoutMs}ms`);
      const waitStarted = Date.now();
      const responsePromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          cleanup();
          this.logger?.error?.(`[zai-browser] completeViaUi: timed out after ${completionTimeoutMs}ms waiting for a /api/v2/chat/completions response`);
          reject(new Error('Timed out waiting for Z.ai UI completion response'));
        }, completionTimeoutMs);
        // Without this, the only sign of life for up to 3 minutes was
        // silence — no way to tell "still working" from "stuck" from the
        // logs alone.
        heartbeat = setInterval(() => {
          this.logger?.info?.(`[zai-browser] completeViaUi: still waiting for a completion response (${Math.round((Date.now() - waitStarted) / 1000)}s elapsed)`);
        }, heartbeatMs);
        heartbeat.unref?.();
        onResponse = async (response) => {
          const url = typeof response.url === 'function' ? response.url() : response.url;
          if (!String(url).includes('/api/v2/chat/completions')) return;
          try {
            const raw = await response.text();
            cleanup();
            const headers = typeof response.headers === 'function' ? response.headers() : (response.headers || {});
            const ok = typeof response.ok === 'function' ? response.ok() : response.ok;
            const status = typeof response.status === 'function' ? response.status() : response.status;
            this.logger?.info?.(`[zai-browser] completeViaUi: got a completion response after ${Math.round((Date.now() - waitStarted) / 1000)}s (ok=${ok}, status=${status})`);
            resolve({ ok, status, contentType: headers['content-type'] || '', raw });
          } catch (err) {
            cleanup();
            reject(err);
          }
        };
        page.on('response', onResponse);
      });

      try {
        await this.humanFillPrompt(page, prompt);
        await page.keyboard.press('Enter');
        this.logger?.info?.('[zai-browser] completeViaUi: prompt submitted, waiting for a response...');
      } catch (err) {
        // Submission failed (e.g. textarea never appeared because the page
        // landed on a login/captcha wall instead of the chat UI). Kill the
        // pending timer instead of leaving it to reject unattended later.
        cleanup();
        this.logger?.error?.(`[zai-browser] completeViaUi: prompt submission failed (${err?.message || err}) — likely a login/captcha wall instead of the chat UI`);
        throw err;
      }

      return await responsePromise;
    } finally {
      // THE actual fix for the CPU/network issue this was written for:
      // every completeViaUi() call used to leave this scratch page open
      // forever — regardless of success, failure, or timeout — so each
      // fallback (e.g. every glm-*-search request that hits a captcha) left
      // one more live Chromium renderer process running in the background,
      // each with its own ongoing JS execution and network activity on a
      // loaded chat.z.ai page, indefinitely. Closing it here, in `finally`,
      // guarantees exactly one scratch page is ever alive per in-flight
      // call. See docs/browser-fallback.md.
      await this.closeScratchPage(page);
      this.logger?.info?.(`[zai-browser] completeViaUi: closed scratch page (${this.openScratchPages.size} still open)`);
    }
  });
  }

  async close() {
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    const browser = this.browser;
    const context = this.context;
    const leaked = [...this.openScratchPages];
    this.openScratchPages.clear();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchedAt = 0;
    for (const page of leaked) await page.close().catch(() => null);
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
    this.logger?.info?.(`[zai-browser] closed${leaked.length ? ` (${leaked.length} still-open scratch page(s) force-closed)` : ''}`);
  }
}

let singleton = null;
export function getZaiBrowserClient(opts = {}) {
  if (!singleton) singleton = new ZaiBrowserClient(opts);
  return singleton;
}

export async function closeZaiBrowserClient() {
  if (singleton) await singleton.close();
  singleton = null;
}

// Keep this module importable from tests without launching Chrome.
export const __filename = fileURLToPath(import.meta.url);
