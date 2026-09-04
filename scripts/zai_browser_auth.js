#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { defaultChromeExecutable } from '../src/providers/zaiBrowser.js';

const outPath = process.argv[2] || process.env.AUTH_PATH || './auth.json';
const profileDir = process.env.ZAI_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.free-glm-kimi-api', 'zai-browser-profile');
const timeoutMs = Number(process.env.ZAI_AUTH_TIMEOUT_MS || 300_000);
const loginUrl = 'https://chat.z.ai';
const allowGuestAuth = ['1', 'true', 'yes', 'on'].includes(String(process.env.ZAI_ALLOW_GUEST_AUTH || '').toLowerCase());

async function loadPuppeteer() {
  const [{ default: puppeteerExtra }, { default: StealthPlugin }] = await Promise.all([
    import('puppeteer-extra'),
    import('puppeteer-extra-plugin-stealth')
  ]);
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra;
}

function decodeJwt(token) {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch { return {}; }
}

function saveAccount(token, cookieHeader = '') {
  const payload = decodeJwt(token);
  const account = {
    id: payload.email || payload.id || `zai-${Date.now()}`,
    provider: 'glm',
    backend: 'zai',
    token,
    browser_fallback: true
  };
  if (cookieHeader) account.cookie = cookieHeader;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ accounts: [account] }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, outPath, email: payload.email || null, userId: payload.id || payload.user_id || null, browserFallback: true }, null, 2));
}

export function isGuestZaiPayload(payload = {}) {
  const email = String(payload.email || '').toLowerCase();
  const id = String(payload.id || payload.user_id || '').toLowerCase();
  return email.endsWith('@guest.com') || id.startsWith('guest-') || email.startsWith('guest-');
}

export function isUsableZaiAuthToken(token, { allowGuest = false } = {}) {
  if (!token || !token.startsWith('eyJ') || token.split('.').length !== 3) return { ok: false, reason: 'not_jwt' };
  const payload = decodeJwt(token);
  if (!allowGuest && isGuestZaiPayload(payload)) return { ok: false, reason: 'guest_token', payload };
  return { ok: true, reason: 'ok', payload };
}

async function readToken(page) {
  return page.evaluate(() => {
    try { return localStorage.getItem('token') || ''; } catch { return ''; }
  });
}

async function cookieHeader(page) {
  const cookies = await page.cookies('https://chat.z.ai');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function isTransientNavigationError(err) {
  const msg = String(err && err.message || err || '');
  return /Execution context was destroyed|Cannot find context|Target closed|Session closed|detached Frame|Node is detached/i.test(msg);
}

async function main() {
  const puppeteer = await loadPuppeteer();
  fs.mkdirSync(profileDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: defaultChromeExecutable(),
    userDataDir: profileDir,
    defaultViewport: { width: 1365, height: 768, deviceScaleFactor: 1 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--window-size=1365,768']
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setUserAgent(process.env.ZAI_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

  let networkToken = '';
  page.on('request', req => {
    const h = req.headers();
    const auth = h.authorization || h.Authorization || '';
    const m = String(auth).match(/^Bearer\s+(.+)$/i);
    if (m) networkToken = m[1];
  });

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('Z.ai browser auth window is open. Log in once there; this script will save token automatically.');
  console.log(`Profile: ${profileDir}`);
  console.log(`Timeout: ${Math.round(timeoutMs / 1000)}s`);

  const started = Date.now();
  let warnedGuest = false;
  while (Date.now() - started < timeoutMs) {
    // Prefer localStorage: Z.ai may keep an early guest Authorization request in memory,
    // while localStorage is already updated to the real logged-in account token.
    let localToken = '';
    try {
      localToken = await readToken(page);
    } catch (err) {
      if (isTransientNavigationError(err)) {
        // Page navigated (e.g. right after login) mid-read; just retry next tick.
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
    const candidates = [localToken, networkToken].filter(Boolean);
    const usable = candidates.map(token => ({ token, state: isUsableZaiAuthToken(token, { allowGuest: allowGuestAuth }) })).find(item => item.state.ok);
    const guestSeen = candidates.some(token => isUsableZaiAuthToken(token, { allowGuest: false }).reason === 'guest_token');
    if (guestSeen && !warnedGuest) {
      warnedGuest = true;
      console.log('Found only a temporary guest Z.ai token; keeping browser open until you log in with a real account.');
    }
    if (usable) {
      const cookies = await cookieHeader(page).catch(() => '');
      saveAccount(usable.token, cookies);
      await browser.close();
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  await browser.close();
  console.error(JSON.stringify({ ok: false, error: 'Timed out waiting for Z.ai token. Keep profile dir and retry auth:browser after login.' }, null, 2));
  process.exit(2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => { console.error(err); process.exit(1); });
} else if (process.env.ZAI_AUTH_DEBUG_ENTRY) {
  // Diagnostic: set ZAI_AUTH_DEBUG_ENTRY=1 to see why the entry-point check didn't match
  console.error('zai_browser_auth.js loaded but not run as main:', {
    'import.meta.url': import.meta.url,
    'argv[1]': process.argv[1],
    'expected': process.argv[1] ? pathToFileURL(process.argv[1]).href : null
  });
}
