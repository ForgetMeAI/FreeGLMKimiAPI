# Z.ai browser fallback: the CPU/network leak, and how to read the new logs

`src/providers/zaiBrowser.js` is a Puppeteer/CloakBrowser-driven fallback
used when the direct HTTP path to `chat.z.ai` (`src/providers/zai.js`)
either fails outright or comes back looking like a captcha challenge
(`isZaiCaptchaError`), for accounts with `browser_fallback: true`. It drives
a real headless Chromium instance to type the prompt into the actual chat
UI and read the response back off the page, the same way a human would.

## The bug: every fallback leaked a browser tab forever

`completeViaUi()` — the function that does the UI simulation — opened a
**new Chromium tab** on every single call (`this.newPage()`), but never
closed it. It just reassigned `this.page` to point at the new tab, silently
leaving whatever tab was open before dereferenced but *still running* in
the browser process.

Each leaked tab is a live, loaded `chat.z.ai` page: its own Chromium
renderer process, its own JS execution, its own network activity
(WebSocket/polling/telemetry) that never gets torn down. One fallback call
now and then wouldn't be very noticeable. But every `glm-*-search` request
that hits a captcha — which per prior investigation is a known recurring
issue — triggers exactly this path. Repeated over time, that's an
unbounded, ever-growing pile of live browser tabs, which lines up exactly
with **"100% CPU and quite a lot of network traffic" that persists** rather
than spiking and settling.

### The fix

`completeViaUi()` now opens a page it tracks (`openScratchPage()`) and
**always closes it in a `finally` block** — on success, on a normal
completion error, and on timeout. It also no longer touches `this.page` at
all; that field is reserved for the separate, persistent "home" page used
by the lightweight direct-fetch-via-page.evaluate path
(`completeRequest()`), which was never the source of the leak and is
correctly reused across calls (relaunching a whole browser per request
would be far more expensive than the leak it wasn't causing).

`tests/zaiBrowser.test.js` proves this with real regression tests (not
just "the code changed and tests still pass") — reverting the fix and
re-running them fails 4 of the 13 tests immediately; see the file's
comments for the exact scenarios covered: success, timeout, and
submission-failure (captcha/login wall) all now close their page, and the
persistent home page is confirmed untouched throughout.

## Defense in depth: three more layers, since this couldn't be reproduced live

This proxy's sandbox has no network path to `chat.z.ai`, so none of this
could be verified against the real site. On top of the concrete fix above,
three more layers were added so the *next* leak (if there ever is one) is
caught immediately instead of running silently for weeks:

1. **Leak canary.** `openScratchPage()` warns loudly
   (`N scratch pages open at once`) if more than one is ever open
   simultaneously — should never happen now, so if it does, something
   regressed or there's real concurrent load worth knowing about.
2. **Idle auto-close.** If nothing has used the browser in
   `ZAI_BROWSER_IDLE_CLOSE_MS` (default 10 min), it's closed outright and
   relaunches lazily on the next request — the same clean state as a fresh
   container start. Set to `0` to disable. This bounds worst-case resource
   usage from *any* leak, known or not, without needing a container
   restart.
3. **Docker-safe Chromium flags.** `--disable-gpu`,
   `--disable-software-rasterizer`, `--disable-dev-shm-usage`, and several
   `--disable-*-backgrounding`/`--disable-*-throttling` flags were added to
   the launch args (`puppeteerLaunchArgs()`). Headless Chrome with no real
   GPU commonly falls back to CPU-bound software rendering
   (SwiftShader) without `--disable-gpu`, which alone can look like
   sustained high CPU on a page that's just sitting open — plausible as a
   *contributing* factor even independent of the leak. (`shm_size: "1gb"`
   was already set in `docker-compose.yml` from an earlier fix, so the
   classic "Chrome crashes in Docker" `/dev/shm` issue was already covered.)

## What the new logs look like

Every request through the fallback now logs its lifecycle at `info` level
(prefixed `[zai-browser]`), instead of the previous near-silence:

```
[zai-browser] completeAndParse #1: starting (in-page fetch first)
[zai-browser] completeAndParse #1: in-page fetch returned HTTP 403 — falling back to full UI simulation
[zai-browser] no live page — launching (engine=puppeteer, headless=true)
[zai-browser] launched puppeteer-extra Chromium in 812ms (headless=true)
[zai-browser] completeViaUi: opened scratch page (1 open)
[zai-browser] completeViaUi: navigated to https://chat.z.ai in 1204ms
[zai-browser] completeViaUi: prompt submitted, waiting for a response...
[zai-browser] completeViaUi: still waiting for a completion response (15s elapsed)
[zai-browser] completeViaUi: still waiting for a completion response (30s elapsed)
[zai-browser] completeViaUi: got a completion response after 34s (ok=true, status=200)
[zai-browser] completeViaUi: closed scratch page (0 still open)
```

A hung/leaking instance would instead show the heartbeat line repeating
past the completion timeout with `(N still open)` climbing on every
fallback instead of returning to `0` — that's the smoking gun to look for
if this ever regresses. `1 scratch pages open at once` warnings would also
appear immediately.

The heartbeat interval is `ZAI_BROWSER_HEARTBEAT_MS` (default 15s).

## Live introspection without grepping logs

- `GET /admin/browser` → `{ engine, running, openScratchPages, launchedAt,
  lastUsedAt, idleForMs, requestCount }`. `openScratchPages` should be `0`
  between requests, always. Just checking this never launches a browser by
  itself.
- `POST /admin/browser/close` → force-closes it right now (safe no-op if
  nothing is running) — a manual reset that doesn't require restarting the
  container.

## New env vars

See `.env.example` / `docker-compose.yml` for the full list with defaults:
`ZAI_BROWSER_COMPLETION_TIMEOUT`, `ZAI_BROWSER_HEARTBEAT_MS`,
`ZAI_BROWSER_IDLE_CLOSE_MS`, `ZAI_BROWSER_IDLE_CHECK_MS`,
`ZAI_BROWSER_PUPPETEER_ARGS`.

## Testing

```bash
node --test tests/zaiBrowser.test.js   # 13 tests, all using fake page objects — no real Chromium needed
node --test tests/server.test.js       # includes GET /admin/browser + POST /admin/browser/close
```

`tests/zaiBrowser.test.js` stubs `ensurePage`/`newPage` on a real
`ZaiBrowserClient` instance with fake page objects (plain JS objects with
spy-able `close()`/`on()`/`off()`), so the actual leak-prone code path in
`completeViaUi()` runs for real in tests — nothing about the fix itself is
mocked, only the Chromium process underneath it.

## If this is still happening after deploying this fix

Watch `docker logs freeglmkimi -f` for the `[zai-browser]` lines above
during/after a `glm-*-search` request, and check `GET
/admin/browser` a few minutes later. If `openScratchPages` is reliably back
to `0` and CPU is still high with the browser reported as `running: false`,
the browser isn't the cause and it's worth looking elsewhere (e.g. the
model-catalog/session-store changes from earlier passes, or something
outside this proxy entirely). If `openScratchPages` is ever `> 0` for more
than a few minutes with no fallback in flight, that's a new leak — please
share the surrounding `[zai-browser]` log lines.
