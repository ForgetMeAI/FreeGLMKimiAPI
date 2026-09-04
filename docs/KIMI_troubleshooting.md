# FreeGLMKimiAPI: REASON_CHAT_MESSAGE_NOT_FOUND fix attempt

## Diagnosis

`src/providers/kimi.js` targets `www.kimi.com`'s international Connect-RPC
surface (`/apiv2/kimi.gateway.chat.v1.ChatService/Chat`), but only ever sent
one custom header: `X-Msh-Platform: web`. A `jwtPayload()` helper existed in
the file to decode the account's JWT but was never actually used anywhere —
dead code that looks like an unfinished attempt to derive session/device
identity headers.

That matches how this API behaves in the wild: the international Kimi web
surface is known (from other reverse-engineering projects hitting the same
endpoint) to send additional `x-msh-*` / `x-traffic-id` / `x-language` /
`r-timezone` headers alongside the JWT, with the JWT payload itself carrying
`device_id`, `region`, and a subject/session id that likely need to be
echoed back in headers. Your Kimi JWT (`data/auth.json`) does contain
`device_id` and `region: "overseas"` fields.

Working theory: `chat_id`/`parent_id` are scoped server-side to a specific
device/session identity. Without the matching identity headers, the server
can create/continue the RPC call but can't resolve the chat message under an
unrecognized identity context — hence `REASON_CHAT_MESSAGE_NOT_FOUND`.

**This is a well-supported hypothesis, not a confirmed fix** — the exact
header names are unverified even in the public reverse-engineering notes I
found. Ship it, then use the capture script below to nail down the real
names if it's still failing.

## What changed

`src/providers/kimi.js`:
- Wires the previously-unused `jwtPayload()` into the request: derives
  `X-Msh-Device-Id`, `X-Msh-Region`, `X-Traffic-Id` from the JWT's
  `device_id` / `region` / `sub` fields, plus static `X-Language` /
  `R-Timezone` headers (env-overridable via `KIMI_LANGUAGE` /
  `KIMI_TIMEZONE`).
- Adds `KIMI_EXTRA_HEADERS` (JSON env var) that always overrides the guessed
  headers above — this is the important one if the guessed header names turn
  out to be wrong.
- Adds `DEBUG_KIMI=1` to log every outgoing request's headers + chat_id/
  parent_id to `docker logs`, so you can diff against a real browser capture.
- Minor hardening: `parentId` now takes the *last* non-empty message id seen
  across response frames instead of the first, in case an early frame echoes
  the user's own turn before a later frame carries the assistant reply's id
  (this shouldn't be your main issue, since the errors happen consistently,
  but it's a plausible secondary contributor and is free to fix).

`scripts/kimi_dump_curl_headers.js` (new): paste a "Copy as cURL" of a real
`www.kimi.com` **second-message** Chat request from Chrome DevTools, and it
prints every header plus a ready-to-paste `KIMI_EXTRA_HEADERS=` line for any
header we're not already sending/guessing.

`package.json`: adds `npm run kimi:dump-headers` alias for the script above.

`.env.example` / `docker-compose.yml`: document the new env vars
(`KIMI_LANGUAGE`, `KIMI_TIMEZONE`, `KIMI_EXTRA_HEADERS`, `DEBUG_KIMI`).

## How to apply

1. Copy `repo/src/providers/kimi.js` and `repo/scripts/kimi_dump_curl_headers.js`
   into your `freeglmkimi/repo/` tree, and merge the `package.json` /
   `.env.example` / `docker-compose.yml` diffs (or just replace them — they're
   additive).
2. `sudo docker compose build --no-cache && sudo docker compose up -d`
3. Send a 2-message conversation through the proxy and watch:
   `sudo docker logs freeglmkimi -f --tail 30`
4. Still failing? Set `DEBUG_KIMI=1` in `docker-compose.yml`, restart, and
   compare the logged headers against a real browser capture:
   - Open www.kimi.com logged in, DevTools > Network, send 2 messages in one
     chat, right-click the 2nd `.../ChatService/Chat` request > Copy > Copy as
     cURL (bash).
   - `npm run kimi:dump-headers path/to/pasted-curl.txt` (or pipe it in).
   - Drop any header it flags as missing into `KIMI_EXTRA_HEADERS` (JSON) in
     `.env` or `docker-compose.yml`, restart, retest.
