#!/usr/bin/env node
// Diagnostic helper for the Kimi "REASON_CHAT_MESSAGE_NOT_FOUND" error.
//
// www.kimi.com's Chat RPC (Connect-RPC) most likely needs a session/device
// identity header that FreeGLMKimiAPI currently isn't sending (see the note
// above HEADERS in src/providers/kimi.js). Instead of guessing header names,
// capture the real ones straight from a logged-in browser and diff them
// against what we already send.
//
// How to use:
//   1. Open www.kimi.com in a normal browser, logged in to the account whose
//      token is in auth.json.
//   2. Open DevTools > Network, send a message, then send a SECOND message in
//      the same chat (the bug only reproduces on turn 2+, once chat_id/parent_id
//      are in play).
//   3. Find the POST to /apiv2/kimi.gateway.chat.v1.ChatService/Chat for that
//      second message, right-click it > Copy > Copy as cURL (bash).
//   4. Paste it into a file (or pipe it directly) and run:
//        node scripts/kimi_dump_curl_headers.js path/to/pasted-curl.txt
//      or:
//        pbpaste | node scripts/kimi_dump_curl_headers.js
//   5. Compare the "not currently sent" section against src/providers/kimi.js.
//      Copy the suggested KIMI_EXTRA_HEADERS line into .env / docker-compose.yml,
//      restart the container, and retry.
import fs from 'fs';

const inputPath = process.argv[2] || '';
const curl = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');

function unquoteShell(s) {
  s = String(s || '').trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  return s.replace(/'\\''/g, "'").replace(/\\\n/g, '').replace(/\\'/g, "'").replace(/\\"/g, '"');
}

function allHeaders() {
  const re = /(?:^|\s)-H\s+((?:'[^']*')|(?:"[^"]*")|(?:\S+))/g;
  const headers = {};
  let m;
  while ((m = re.exec(curl))) {
    const raw = unquoteShell(m[1]);
    const idx = raw.indexOf(':');
    if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  return headers;
}

function urlFromCurl() {
  const m = curl.match(/curl\s+(?:--\S+\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/);
  return m ? m[1] : '(not found)';
}

// Headers FreeGLMKimiAPI's kimi.js already sends (base HEADERS + the ones
// this patch derives) plus generic browser/proxy noise we don't care about.
const KNOWN = new Set([
  'accept', 'cache-control', 'pragma', 'origin', 'user-agent', 'x-msh-platform',
  'authorization', 'content-type', 'x-language', 'r-timezone', 'x-msh-device-id',
  'x-msh-region', 'x-traffic-id',
  'host', 'content-length', 'connection', 'accept-encoding', 'accept-language',
  'referer', 'cookie', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'priority'
]);

const headers = allHeaders();
if (!Object.keys(headers).length) {
  console.error('No -H headers found in the input. Make sure you pasted a full "Copy as cURL" command.');
  process.exit(1);
}

const extra = {};
for (const [k, v] of Object.entries(headers)) {
  if (!KNOWN.has(k.toLowerCase())) extra[k] = v;
}

console.log('URL:', urlFromCurl());
console.log('\nAll headers captured from the browser request:');
console.log(JSON.stringify(headers, null, 2));
console.log('\nHeaders NOT currently sent by FreeGLMKimiAPI (candidates to confirm/add):');
console.log(JSON.stringify(extra, null, 2));
if (Object.keys(extra).length) {
  console.log('\nTo apply directly (bypasses the JWT-derived guesses in kimi.js), add to .env / docker-compose.yml:');
  console.log(`KIMI_EXTRA_HEADERS=${JSON.stringify(extra)}`);
} else {
  console.log('\nNo extra headers found beyond what kimi.js already sends/guesses — the identity-header');
  console.log('hypothesis may not be it; re-check chat_id/parent_id handling instead.');
}
