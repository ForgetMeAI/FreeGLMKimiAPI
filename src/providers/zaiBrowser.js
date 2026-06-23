import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ZAI_BASE, ZAI_USER_AGENT, parseZaiSse } from './zai.js';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.free-glm-kimi-api', 'zai-browser-profile');
const DEFAULT_CLOAK_PROFILE_DIR = path.join(os.homedir(), '.free-glm-kimi-api', 'zai-cloak-profile');
const TRANSIENT_HEADER_RE = /^(accept-encoding|connection|content-length|host|origin|referer|priority)$|^(sec-fetch-|sec-ch-)/i;
const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

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
    ...(process.platform === 'win32' ? [
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.USERPROFILE}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ] : [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ])
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
          removed.push((path.relative(profileDir, entryPath) || entry.name).replaceAll('\\', '/'));
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
  const context = await launchPersistentContext({
    userDataDir: profileDir,
    headless: headless === false ? false : true,
    humanize: envBool(env, 'ZAI_BROWSER_HUMANIZE', true),
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
  }

  async launchPuppeteer(headless) {
    const puppeteer = await loadPuppeteer();
    this.browser = await puppeteer.launch({
      headless,
      executablePath: defaultChromeExecutable(),
      userDataDir: this.profileDir,
      defaultViewport: { width: 1365, height: 768, deviceScaleFactor: 1 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--lang=ru-RU',
        '--window-size=1365,768'
      ]
    });
    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
  }

  async ensurePage(token = '') {
    if (this.page && !this.page.isClosed()) return this.page;
    fs.mkdirSync(this.profileDir, { recursive: true });
    cleanChromeProfileLocks(this.profileDir);
    const headless = parseBrowserHeadless(this.env);

    if (this.engine === 'cloak') {
      try {
        this.context = await launchCloakContext({ env: this.env, profileDir: this.profileDir, headless, logger: this.logger });
        const pages = this.context.pages();
        this.page = pages[0] || await this.context.newPage();
      } catch (err) {
        this.logger?.warn?.(`[zai-browser] CloakBrowser unavailable/failed, falling back to puppeteer-extra: ${err?.message || err}`);
        this.engine = 'puppeteer';
        await this.launchPuppeteer(headless);
      }
    } else {
      await this.launchPuppeteer(headless);
    }

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

  async completeRequest(req, { token = '', chatId = '' } = {}) {
    const page = await this.ensurePage(token);
    const target = chatId ? `${ZAI_BASE}/c/${chatId}` : ZAI_BASE;
    if (!page.url().startsWith(target)) {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Number(this.env.ZAI_BROWSER_NAV_TIMEOUT || 60_000) }).catch(() => null);
    }
    const payload = {
      url: req.url,
      headers: browserSafeHeaders(req.headers),
      body: req.body
    };
    return page.evaluate(async (data) => {
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
  }

  async completeAndParse(req, options = {}) {
    let result;
    try {
      result = await this.completeRequest(req, options);
    } catch {
      const uiResult = await this.completeViaUi(req.body?.messages?.[0]?.content || req.body?.signature_prompt || 'Hello');
      return { ...uiResult, parsed: parseZaiSse(uiResult.raw) };
    }
    let parsed = parseZaiSse(result.raw);
    if (!result.ok || (parsed.error && isZaiCaptchaError(parsed.error))) {
      const uiResult = await this.completeViaUi(req.body?.messages?.[0]?.content || req.body?.signature_prompt || 'Hello');
      parsed = parseZaiSse(uiResult.raw);
      return { ...uiResult, parsed };
    }
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
    await this.ensurePage();
    const page = await this.newPage();
    this.page = page;
    await this.setupPage(page);
    await page.goto(ZAI_BASE, { waitUntil: 'domcontentloaded', timeout: Number(this.env.ZAI_BROWSER_NAV_TIMEOUT || 60_000) }).catch(() => null);
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        page.off('response', onResponse);
        reject(new Error('Timed out waiting for Z.ai UI completion response'));
      }, Number(this.env.ZAI_BROWSER_COMPLETION_TIMEOUT || 180_000));
      async function onResponse(response) {
        const url = typeof response.url === 'function' ? response.url() : response.url;
        if (!String(url).includes('/api/v2/chat/completions')) return;
        try {
          const raw = await response.text();
          clearTimeout(timeout);
          page.off('response', onResponse);
          const headers = typeof response.headers === 'function' ? response.headers() : (response.headers || {});
          const ok = typeof response.ok === 'function' ? response.ok() : response.ok;
          const status = typeof response.status === 'function' ? response.status() : response.status;
          resolve({ ok, status, contentType: headers['content-type'] || '', raw });
        } catch (err) {
          clearTimeout(timeout);
          page.off('response', onResponse);
          reject(err);
        }
      }
      page.on('response', onResponse);
    });
    await this.humanFillPrompt(page, prompt);
    await page.keyboard.press('Enter');
    return responsePromise;
  }

  async close() {
    const browser = this.browser;
    const context = this.context;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
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
