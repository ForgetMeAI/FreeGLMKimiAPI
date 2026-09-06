import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractUserIdFromZaiToken, generateZaiSignature, parseZaiSse, buildZaiRequest } from '../src/providers/zai.js';
import { browserSafeHeaders, cleanChromeProfileLocks, isZaiCaptchaError, parseBrowserHeadless, selectedBrowserEngine, shouldUseZaiBrowserFallback } from '../src/providers/zaiBrowser.js';
import { isGuestZaiPayload, isUsableZaiAuthToken } from '../scripts/zai_browser_auth.js';

function unsignedJwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

test('Z.ai token user id is extracted from JWT payload', () => {
  assert.equal(extractUserIdFromZaiToken(unsignedJwt({ id: 'user-123', email: 'a@b.c' })), 'user-123');
  assert.equal(extractUserIdFromZaiToken('not-jwt'), 'guest');
});

test('Z.ai browser auth rejects temporary guest JWTs by default', () => {
  const guestToken = unsignedJwt({ id: 'guest-1781090988196', email: 'guest-1781090988196@guest.com' }).replace(/^x\./, 'eyJ.');
  const realToken = unsignedJwt({ id: 'user-123', email: 'real@example.com' }).replace(/^x\./, 'eyJ.');

  assert.equal(isGuestZaiPayload({ id: 'guest-1', email: 'guest-1@guest.com' }), true);
  assert.equal(isGuestZaiPayload({ id: 'user-1', email: 'real@example.com' }), false);
  assert.deepEqual(isUsableZaiAuthToken('not-jwt'), { ok: false, reason: 'not_jwt' });
  assert.equal(isUsableZaiAuthToken(guestToken).ok, false);
  assert.equal(isUsableZaiAuthToken(guestToken).reason, 'guest_token');
  assert.equal(isUsableZaiAuthToken(guestToken, { allowGuest: true }).ok, true);
  assert.equal(isUsableZaiAuthToken(realToken).ok, true);
});

test('Z.ai signature is stable for same request fields', () => {
  const sig1 = generateZaiSignature('hello', 'req-1', 1781079000000, 'user-1');
  const sig2 = generateZaiSignature('hello', 'req-1', 1781079000000, 'user-1');
  assert.equal(sig1, sig2);
  assert.match(sig1, /^[a-f0-9]{64}$/);
});

test('Z.ai SSE parser extracts content and message ids', () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"Hel"}}],"message_id":"m1"}',
    '',
    'data: {"choices":[{"delta":{"content":"lo"}}],"id":"chatcmpl"}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  const out = parseZaiSse(raw);
  assert.equal(out.text, 'Hello');
  assert.equal(out.parentMessageId, 'm1');
});

test('Z.ai request targets current chat.z.ai endpoint and carries chat/session ids', () => {
  const req = buildZaiRequest({
    token: unsignedJwt({ id: 'u1' }),
    model: 'glm-5',
    prompt: 'User: hi',
    chatId: 'chat-1',
    parentMessageId: 'parent-1',
    thinking: true,
    webSearch: true,
    now: () => 1781079000000,
    uuid: () => 'uuid-1'
  });
  assert.match(req.url, /^https:\/\/chat\.z\.ai\/api\/v2\/chat\/completions\?/);
  assert.equal(req.body.chat_id, 'chat-1');
  assert.equal(req.body.current_user_message_parent_id, 'parent-1');
  assert.equal(req.body.features.enable_thinking, true);
  assert.equal(req.body.features.web_search, true);
  assert.equal(req.headers.Origin, 'https://chat.z.ai');
  assert.equal(req.headers['X-FE-Version'], 'prod-fe-1.1.46');
});

test('Z.ai SSE parser extracts current chat:completion delta_content format', () => {
  const raw = [
    'data: {"type":"chat:completion","data":{"id":"assistant-1","role":"assistant","phase":"answer","delta_content":"Hel"}}',
    '',
    'data: {"type":"chat:completion","data":{"id":"assistant-1","role":"assistant","phase":"answer","delta_content":"lo"}}',
    '',
    'data: {"type":"chat:completion","data":{"phase":"done","done":true,"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  const out = parseZaiSse(raw);
  assert.equal(out.text, 'Hello');
  assert.equal(out.parentMessageId, 'assistant-1');
});

test('Z.ai request can carry browser captcha verification payload when supplied', () => {
  const req = buildZaiRequest({
    token: unsignedJwt({ id: 'u1' }),
    model: 'glm-5',
    prompt: 'User: hi',
    chatId: 'chat-1',
    captchaVerifyParam: { captcha_output: 'ok' },
    now: () => 1781079000000,
    uuid: () => 'uuid-1'
  });
  assert.deepEqual(req.body.captcha_verify_param, { captcha_output: 'ok' });
});

test('Z.ai request keeps base64 captcha_verify_param string verbatim and can use full browser cookies', () => {
  const token = unsignedJwt({ id: 'u1' });
  const captcha = 'eyJjZXJ0aWZ5SWQiOiJGb3BtVFlJclEyIn0=';
  const req = buildZaiRequest({
    token,
    model: 'GLM-5.1',
    prompt: 'ку',
    chatId: 'chat-1',
    captchaVerifyParam: captcha,
    cookie: `cdn_sec_tc=abc; token=${token}; acw_tc=def; ssxmod_itna=ghi`,
    now: () => 1781083163469,
    uuid: () => 'uuid-1'
  });
  assert.equal(req.body.captcha_verify_param, captcha);
  assert.equal(req.body.model, 'GLM-5.1');
  assert.equal(req.body.features.vlm_tools_enable, false);
  assert.equal(req.headers.Cookie, `cdn_sec_tc=abc; token=${token}; acw_tc=def; ssxmod_itna=ghi`);
  assert.equal(req.headers['X-Region'], 'overseas');
  assert.match(req.url, /language=ru-RU/);
  assert.match(req.url, /timezone=Europe%2FSamara/);
  assert.match(req.headers['User-Agent'], /Chrome\/148/);
});

test('Z.ai SSE parser surfaces nested captcha/frontend errors instead of returning them as content', () => {
  const raw = [
    'data: {"type":"chat:completion","data":{"data":{"done":true,"error":{"code":"FRONTEND_CAPTCHA_REQUIRED","detail":"Please refresh the page to update the app, then try again."}},"done":true,"error":{"code":"FRONTEND_CAPTCHA_REQUIRED","detail":"Please refresh the page to update the app, then try again."}}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  const out = parseZaiSse(raw);
  assert.equal(out.error, 'Please refresh the page to update the app, then try again.');
  assert.equal(out.text, '');
});

test('Z.ai browser fallback supports CloakBrowser engine settings and profile lock cleanup', () => {
  assert.equal(selectedBrowserEngine({ ZAI_BROWSER_ENGINE: 'cloakbrowser' }), 'cloak');
  assert.equal(selectedBrowserEngine({ ZAI_BROWSER_ENGINE: 'puppeteer' }), 'puppeteer');
  assert.equal(selectedBrowserEngine({}), 'puppeteer');
  assert.equal(parseBrowserHeadless({ ZAI_BROWSER_HEADLESS: 'false' }), false);
  assert.equal(parseBrowserHeadless({ ZAI_BROWSER_HEADLESS: 'true' }), 'new');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-profile-'));
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.writeFileSync(path.join(dir, name), 'stale');
  assert.deepEqual(cleanChromeProfileLocks(dir).sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket'].sort());
  assert.equal(fs.existsSync(path.join(dir, 'SingletonLock')), false);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'LOCK'), 'stale');
  assert.deepEqual(cleanChromeProfileLocks(dir),[path.join('Default', 'LOCK')]);
  assert.equal(fs.existsSync(path.join(dir, 'Default', 'LOCK')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('Z.ai browser fallback helpers classify captcha errors and strip forbidden browser headers', () => {
  assert.equal(isZaiCaptchaError('Captcha verification failed. Please verify again and retry.'), true);
  assert.equal(isZaiCaptchaError('Please refresh the page to update the app, then try again.'), true);
  assert.equal(isZaiCaptchaError('人机验证失败，请重新验证后再试。'), true);
  assert.equal(isZaiCaptchaError({ code: 'FRONTEND_CAPTCHA_REQUIRED' }), true);
  assert.equal(isZaiCaptchaError('plain upstream outage'), false);

  assert.equal(shouldUseZaiBrowserFallback({ ZAI_BROWSER_FALLBACK: '1' }, {}), true);
  assert.equal(shouldUseZaiBrowserFallback({}, { browser_fallback: true }), true);
  assert.equal(shouldUseZaiBrowserFallback({}, {}), false);

  const safe = browserSafeHeaders({
    Authorization: 'Bearer t',
    'Content-Type': 'application/json',
    Cookie: 'token=t',
    Connection: 'keep-alive',
    'Accept-Encoding': 'gzip',
    'Sec-Fetch-Site': 'same-origin',
    Priority: 'u=1, i'
  });
  assert.deepEqual(safe, {
    Authorization: 'Bearer t',
    'Content-Type': 'application/json',
    Cookie: 'token=t'
  });
});
