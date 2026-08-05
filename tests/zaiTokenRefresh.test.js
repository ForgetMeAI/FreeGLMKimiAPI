import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeJwtPayload,
  getTokenExpiry,
  getTokenTtlMs,
  isTokenExpired,
  isZaiAuthError,
  ZaiTokenRefresher,
} from '../src/providers/zaiTokenRefresh.js';
import { AccountManager } from '../src/accounts.js';

function unsignedJwt(payload) {
  return `eyJ.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

// ── JWT utilities ──────────────────────────────────────────────

test('decodeJwtPayload extracts payload from JWT', () => {
  const payload = { id: 'user-1', email: 'a@b.c', exp: 1781079000 };
  const token = unsignedJwt(payload);
  assert.deepEqual(decodeJwtPayload(token), payload);
});

test('decodeJwtPayload returns null for non-JWT input', () => {
  assert.equal(decodeJwtPayload('not-jwt'), null);
  assert.equal(decodeJwtPayload(''), null);
  assert.equal(decodeJwtPayload(null), null);
  assert.equal(decodeJwtPayload('a.b'), null); // only 2 parts
});

test('getTokenExpiry reads exp claim and converts to milliseconds', () => {
  const token = unsignedJwt({ exp: 1781079000 });
  assert.equal(getTokenExpiry(token), 1781079000000);
});

test('getTokenExpiry returns null when no exp claim', () => {
  const token = unsignedJwt({ id: 'user-1' });
  assert.equal(getTokenExpiry(token), null);
});

test('getTokenTtlMs returns remaining time until expiry', () => {
  const now = 1781078000000;
  const token = unsignedJwt({ exp: 1781079000 }); // 1000s in the future
  const ttl = getTokenTtlMs(token, () => now);
  assert.equal(ttl, 1_000_000); // 1000 * 1000
});

test('getTokenTtlMs returns negative for expired tokens', () => {
  const now = 1781080000000;
  const token = unsignedJwt({ exp: 1781079000 }); // 1000s in the past
  const ttl = getTokenTtlMs(token, () => now);
  assert.equal(ttl, -1_000_000);
});

test('getTokenTtlMs returns Infinity when no exp claim', () => {
  const token = unsignedJwt({ id: 'user-1' });
  assert.equal(getTokenTtlMs(token), Infinity);
});

test('isTokenExpired returns true when TTL <= threshold', () => {
  const now = 1781078000000;
  const token = unsignedJwt({ exp: 1781079000 }); // 1000s = 1_000_000ms in future
  assert.equal(isTokenExpired(token, { thresholdMs: 0, now: () => now }), false);
  assert.equal(isTokenExpired(token, { thresholdMs: 1_100_000, now: () => now }), true); // threshold > TTL
  // Expired token
  const expiredToken = unsignedJwt({ exp: 1781077000 });
  assert.equal(isTokenExpired(expiredToken, { thresholdMs: 0, now: () => now }), true);
});

// ── Auth error detection ───────────────────────────────────────

test('isZaiAuthError detects 401 status', () => {
  assert.equal(isZaiAuthError(401, ''), true);
  assert.equal(isZaiAuthError(401, 'anything'), true);
});

test('isZaiAuthError detects auth error patterns in response body', () => {
  assert.equal(isZaiAuthError(200, '{"code":"TOKEN_EXPIRED"}'), true);
  assert.equal(isZaiAuthError(200, '{"code":"UNAUTHORIZED"}'), true);
  assert.equal(isZaiAuthError(200, '{"detail":"Token has expired"}'), true);
  assert.equal(isZaiAuthError(200, '{"message":"token expired, please login again"}'), true);
  assert.equal(isZaiAuthError(200, 'Authentication required'), true);
  assert.equal(isZaiAuthError(200, '请先登录'), true);
  assert.equal(isZaiAuthError(200, '登录已过期'), true);
});

test('isZaiAuthError does not false-positive on captcha/normal errors', () => {
  assert.equal(isZaiAuthError(200, '{"error":"Captcha verification failed"}'), false);
  assert.equal(isZaiAuthError(200, 'Rate limit exceeded'), false);
  assert.equal(isZaiAuthError(500, 'Internal server error'), false);
});

test('isZaiAuthError distinguishes 403 captcha from 403 auth', () => {
  assert.equal(isZaiAuthError(403, 'captcha verification required'), false);
  assert.equal(isZaiAuthError(403, 'aliyun waf block'), false);
  assert.equal(isZaiAuthError(403, '{"code":"UNAUTHORIZED"}'), true);
  assert.equal(isZaiAuthError(403, 'token expired'), true);
});

// ── ZaiTokenRefresher ──────────────────────────────────────────

test('ZaiTokenRefresher.needsRefresh checks TTL against threshold', () => {
  const now = 1781078000000;
  const refresher = new ZaiTokenRefresher({
    cdpUrl: 'http://127.0.0.1:9222',
    thresholdMs: 300_000,
    now: () => now,
  });
  // Token with 600s TTL — not expiring
  const fresh = unsignedJwt({ exp: 1781078600 });
  assert.equal(refresher.needsRefresh(fresh), false);
  // Token with 200s TTL — below 300s threshold
  const stale = unsignedJwt({ exp: 1781078200 });
  assert.equal(refresher.needsRefresh(stale), true);
  // Expired token
  const expired = unsignedJwt({ exp: 1781077000 });
  assert.equal(refresher.needsRefresh(expired), true);
});

test('ZaiTokenRefresher.refresh calls extractFn and returns result', async () => {
  const mockExtract = async () => ({
    token: unsignedJwt({ id: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
    cookie: 'token=abc; cdn_sec_tc=def',
    ok: true,
  });
  const refresher = new ZaiTokenRefresher({
    cdpUrl: 'http://127.0.0.1:9222',
    extractFn: mockExtract,
    maxRetries: 0,
  });
  const result = await refresher.refresh();
  assert.equal(result.ok, true);
  assert.ok(result.token.startsWith('eyJ'));
  assert.ok(result.cookie.includes('token='));
});

test('ZaiTokenRefresher.refresh returns null on cooldown', async () => {
  let extractCalls = 0;
  const mockExtract = async () => {
    extractCalls++;
    return { token: unsignedJwt({ id: 'u' }), cookie: '', ok: true };
  };
  const refresher = new ZaiTokenRefresher({
    cdpUrl: 'http://127.0.0.1:9222',
    extractFn: mockExtract,
    cooldownMs: 60_000,
  });
  // First call succeeds
  const r1 = await refresher.refresh();
  assert.equal(r1.ok, true);
  assert.equal(extractCalls, 1);
  // Second call within cooldown → null
  const r2 = await refresher.refresh();
  assert.equal(r2, null);
  assert.equal(extractCalls, 1); // extract not called again
});

test('ZaiTokenRefresher.refresh deduplicates concurrent calls', async () => {
  let extractCalls = 0;
  const mockExtract = async () => {
    extractCalls++;
    await new Promise(r => setTimeout(r, 50));
    return { token: unsignedJwt({ id: 'u' }), cookie: '', ok: true };
  };
  const refresher = new ZaiTokenRefresher({
    cdpUrl: 'http://127.0.0.1:9222',
    extractFn: mockExtract,
    maxRetries: 0,
  });
  // Fire two concurrent refreshes
  const [r1, r2] = await Promise.all([refresher.refresh(), refresher.refresh()]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(extractCalls, 1); // only one extract call
});

test('ZaiTokenRefresher.refresh retries on failure then returns null', async () => {
  let calls = 0;
  const mockExtract = async () => {
    calls++;
    throw new Error('CDP connection refused');
  };
  const refresher = new ZaiTokenRefresher({
    cdpUrl: 'http://127.0.0.1:9222',
    extractFn: mockExtract,
    maxRetries: 1,
    cooldownMs: 0,
  });
  const result = await refresher.refresh();
  assert.equal(result, null);
  assert.equal(calls, 2); // initial + 1 retry
});

// ── AccountManager.updateToken ─────────────────────────────────

test('AccountManager.updateToken updates token and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-acct-'));
  const authPath = path.join(dir, 'auth.json');
  const mgr = new AccountManager({ authPath, env: {} });
  mgr.add({ id: 'zai1', provider: 'glm', token: unsignedJwt({ id: 'old' }) }, { persist: true });

  const newToken = unsignedJwt({ id: 'new', exp: Math.floor(Date.now() / 1000) + 3600 });
  const updated = mgr.updateToken('zai1', { token: newToken, cookie: 'token=new; cdn=abc' });
  assert.equal(updated.id, 'zai1');
  assert.equal(updated.ok, true);

  // Verify persisted to disk
  const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const persisted = raw.accounts.find(a => a.id === 'zai1');
  assert.equal(persisted.token, newToken);
  assert.equal(persisted.cookie, 'token=new; cdn=abc');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AccountManager.updateToken returns null for unknown account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-acct-empty-'));
  const authPath = path.join(dir, 'auth.json');
  const mgr = new AccountManager({ authPath, env: {} });
  assert.equal(mgr.updateToken('nonexistent', { token: 'x' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
