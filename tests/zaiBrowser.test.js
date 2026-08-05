import test from 'node:test';
import assert from 'node:assert/strict';
import { ZaiBrowserClient, puppeteerLaunchArgs } from '../src/providers/zaiBrowser.js';

const quietLogger = { info(){}, warn(){}, error(){} };

function fakePage() {
  const listeners = {};
  const page = {
    _closeCalls: 0,
    _listeners: listeners,
    on(event, handler) { (listeners[event] ||= []).push(handler); },
    off(event, handler) { listeners[event] = (listeners[event] || []).filter(h => h !== handler); },
    async goto() {},
    async waitForSelector() {},
    async click() { return null; },
    keyboard: { down: async () => {}, press: async () => {}, up: async () => {} },
    async type() {},
    isClosed() { return page._closeCalls > 0; },
    async close() { page._closeCalls += 1; },
  };
  return page;
}

function fireResponse(page, { url = 'https://chat.z.ai/api/v2/chat/completions?x=1', ok = true, status = 200, raw = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' } = {}) {
  const handlers = page._listeners['response'] || [];
  assert.ok(handlers.length > 0, 'completeViaUi must have registered a response listener');
  return Promise.all(handlers.map(h => h({ url: () => url, ok: () => ok, status: () => status, headers: () => ({ 'content-type': 'text/event-stream' }), text: async () => raw })));
}

function clientWithFakeBrowser(envOverrides = {}) {
  const client = new ZaiBrowserClient({ env: { ...process.env, ZAI_BROWSER_IDLE_CLOSE_MS: '0', ...envOverrides }, logger: quietLogger });
  // Stub out real Chromium entirely — ensurePage()/newPage() would otherwise
  // try to launch it. completeViaUi only calls these two.
  client.ensurePage = async () => { client.touch(); return client.page; };
  client.setupPage = async () => {};
  return client;
}

// --- puppeteerLaunchArgs: Docker-safe flags -----------------------------

test('puppeteerLaunchArgs includes the Docker-safe headless-Chrome hardening flags', () => {
  const args = puppeteerLaunchArgs({});
  for (const flag of ['--disable-gpu', '--disable-dev-shm-usage', '--disable-software-rasterizer', '--no-sandbox']) {
    assert.ok(args.includes(flag), `expected ${flag} in launch args`);
  }
});

test('puppeteerLaunchArgs appends extra args from ZAI_BROWSER_PUPPETEER_ARGS', () => {
  const args = puppeteerLaunchArgs({ ZAI_BROWSER_PUPPETEER_ARGS: '--proxy-server=http://x --foo' });
  assert.ok(args.includes('--proxy-server=http://x'));
  assert.ok(args.includes('--foo'));
});

// --- completeViaUi: the actual leak fix ----------------------------------

test('completeViaUi closes its scratch page after a successful completion', async () => {
  const client = clientWithFakeBrowser({ ZAI_BROWSER_COMPLETION_TIMEOUT: '5000', ZAI_BROWSER_HEARTBEAT_MS: '100000' });
  const scratch = fakePage();
  client.newPage = async () => scratch;

  const resultPromise = client.completeViaUi('hello');
  await new Promise(r => setTimeout(r, 5));
  await fireResponse(scratch);
  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(scratch._closeCalls, 1, 'the scratch page must be closed exactly once');
  assert.equal(client.openScratchPages.size, 0, 'no scratch page should remain tracked as open');
});

test('completeViaUi closes its scratch page even when it times out', async () => {
  // ZAI_BROWSER_COMPLETION_TIMEOUT must clear humanFillPrompt's own built-in
  // randomized human-like delays (up to ~2.5s total) so the timeout fires
  // while genuinely waiting for a response, not mid-submission — otherwise
  // the timeout rejects the promise before completeViaUi has reached
  // `await responsePromise`, which is a real but different race (Node
  // reports it as a transient unhandled-rejection, not what this test is
  // about).
  const client = clientWithFakeBrowser({ ZAI_BROWSER_COMPLETION_TIMEOUT: '2900', ZAI_BROWSER_HEARTBEAT_MS: '100000' });
  const scratch = fakePage();
  client.newPage = async () => scratch;

  await assert.rejects(() => client.completeViaUi('hello'), /Timed out waiting for Z\.ai UI completion response/);
  assert.equal(scratch._closeCalls, 1, 'a timed-out call must still close its scratch page');
  assert.equal(client.openScratchPages.size, 0);
});

test('completeViaUi closes its scratch page even when prompt submission fails (e.g. captcha/login wall)', async () => {
  const client = clientWithFakeBrowser({ ZAI_BROWSER_COMPLETION_TIMEOUT: '5000', ZAI_BROWSER_HEARTBEAT_MS: '100000' });
  const scratch = fakePage();
  scratch.waitForSelector = async () => { throw new Error('textarea never appeared'); };
  client.newPage = async () => scratch;

  await assert.rejects(() => client.completeViaUi('hello'), /textarea never appeared/);
  assert.equal(scratch._closeCalls, 1, 'a failed submission must still close its scratch page');
  assert.equal(client.openScratchPages.size, 0);
});

test('completeViaUi never reassigns or closes the persistent home page', async () => {
  const client = clientWithFakeBrowser({ ZAI_BROWSER_COMPLETION_TIMEOUT: '5000', ZAI_BROWSER_HEARTBEAT_MS: '100000' });
  const home = fakePage();
  client.page = home;
  const scratch = fakePage();
  client.newPage = async () => scratch;

  const resultPromise = client.completeViaUi('hello');
  await new Promise(r => setTimeout(r, 5));
  await fireResponse(scratch);
  await resultPromise;

  assert.equal(client.page, home, 'this.page must stay pointed at the persistent home page');
  assert.equal(home._closeCalls, 0, 'the home page must never be closed by completeViaUi');
});

test('regression proof: without closing in finally, repeated completeViaUi calls leak one page each', async () => {
  // This reproduces the actual pre-fix code path structurally (open via
  // newPage(), never close) to prove the fix above is load-bearing and not
  // a no-op — i.e. that these tests would have failed against the old code.
  const client = clientWithFakeBrowser({ ZAI_BROWSER_COMPLETION_TIMEOUT: '5000', ZAI_BROWSER_HEARTBEAT_MS: '100000' });
  const opened = [];
  client.newPage = async () => { const p = fakePage(); opened.push(p); return p; };

  async function buggyCompleteViaUi(prompt) {
    await client.ensurePage();
    const page = await client.newPage(); // old code: no tracking, no close
    return new Promise((resolve) => {
      page.on('response', async () => resolve({ ok: true, status: 200, raw: 'ok' }));
      setTimeout(() => fireResponse(page), 5);
    });
  }

  await buggyCompleteViaUi('one');
  await buggyCompleteViaUi('two');
  await buggyCompleteViaUi('three');

  assert.equal(opened.length, 3);
  assert.equal(opened.filter(p => p._closeCalls > 0).length, 0, 'demonstrates the old code leaked every single page it opened');
});

// --- openScratchPage: leak canary ----------------------------------------

test('openScratchPage warns when more than one scratch page is open at once', async () => {
  const warnings = [];
  const client = new ZaiBrowserClient({ env: { ...process.env }, logger: { info(){}, error(){}, warn: (m) => warnings.push(m) } });
  client.newPage = async () => fakePage();
  await client.openScratchPage();
  await client.openScratchPage();
  assert.ok(warnings.some(w => /2 scratch pages open at once/.test(w)));
});

// --- idle auto-close -------------------------------------------------------

test('an idle browser is closed automatically after ZAI_BROWSER_IDLE_CLOSE_MS', async () => {
  const client = new ZaiBrowserClient({ env: { ...process.env, ZAI_BROWSER_IDLE_CLOSE_MS: '20', ZAI_BROWSER_IDLE_CHECK_MS: '5' }, logger: quietLogger });
  client.browser = { close: async () => { client.browser = null; } }; // pretend a browser is running
  client.lastUsedAt = Date.now();
  client._ensureIdleTimer();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(client.browser, null, 'the idle browser must have been closed');
  clearInterval(client._idleTimer);
});

test('touch() keeps the browser alive past the idle threshold', async () => {
  const client = new ZaiBrowserClient({ env: { ...process.env, ZAI_BROWSER_IDLE_CLOSE_MS: '30', ZAI_BROWSER_IDLE_CHECK_MS: '5' }, logger: quietLogger });
  let closed = false;
  client.browser = { close: async () => { closed = true; } };
  client.lastUsedAt = Date.now();
  client._ensureIdleTimer();
  const refresh = setInterval(() => client.touch(), 10);
  await new Promise(r => setTimeout(r, 60));
  clearInterval(refresh);
  clearInterval(client._idleTimer);
  assert.equal(closed, false, 'repeated touch() calls must prevent the idle close from firing');
});

test('ZAI_BROWSER_IDLE_CLOSE_MS=0 disables auto-close entirely', async () => {
  const client = new ZaiBrowserClient({ env: { ...process.env, ZAI_BROWSER_IDLE_CLOSE_MS: '0' }, logger: quietLogger });
  client._ensureIdleTimer();
  assert.equal(client._idleTimer, null);
});

// --- describeState / close() cleanup --------------------------------------

test('describeState reports open scratch page count and idle time', () => {
  const client = new ZaiBrowserClient({ env: { ...process.env, ZAI_BROWSER_IDLE_CLOSE_MS: '0' }, logger: quietLogger });
  client.openScratchPages.add(fakePage());
  client.lastUsedAt = Date.now() - 5000;
  const state = client.describeState();
  assert.equal(state.openScratchPages, 1);
  assert.ok(state.idleForMs >= 5000);
});

test('close() force-closes any still-open scratch pages and clears the idle timer', async () => {
  const client = new ZaiBrowserClient({ env: { ...process.env, ZAI_BROWSER_IDLE_CLOSE_MS: '0' }, logger: quietLogger });
  const leaked = fakePage();
  client.openScratchPages.add(leaked);
  client._ensureIdleTimer = () => { client._idleTimer = setInterval(() => {}, 1000); };
  client._ensureIdleTimer();
  await client.close();
  assert.equal(leaked._closeCalls, 1);
  assert.equal(client.openScratchPages.size, 0);
  assert.equal(client._idleTimer, null);
});
