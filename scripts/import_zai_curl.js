import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const inputPath = process.argv[2] || '';
const outPath = process.argv[3] || path.join(os.tmpdir(), `freeglm-auth-${crypto.randomUUID()}.json`);
const curl = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');

function unquoteShell(s) {
  s = String(s || '').trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  return s.replace(/'\\''/g, "'").replace(/\\\n/g, '').replace(/\\'/g, "'").replace(/\\"/g, '"');
}

function header(name) {
  const re = new RegExp(`(?:^|\\s)-H\\s+((?:'[^']*')|(?:"[^"]*")|(?:\\S+))`, 'g');
  let m;
  while ((m = re.exec(curl))) {
    const raw = unquoteShell(m[1]);
    const idx = raw.indexOf(':');
    if (idx > 0 && raw.slice(0, idx).trim().toLowerCase() === name.toLowerCase()) return raw.slice(idx + 1).trim();
  }
  return '';
}

function dataBody() {
  const re = /(?:--data-raw|--data|--data-binary|-d)\s+((?:'[^']*(?:'\\''[^']*)*')|(?:"(?:\\.|[^"])*")|(?:\$'[^']*')|(?:\S+))/g;
  let m, last = '';
  while ((m = re.exec(curl))) last = m[1];
  if (last.startsWith("$'")) last = "'" + last.slice(2);
  return unquoteShell(last);
}

const authorization = header('authorization');
const token = (authorization.match(/Bearer\s+(.+)/i) || [])[1] || '';
const cookie = header('cookie');
let captcha_verify_param = '';
try {
  const body = JSON.parse(dataBody() || '{}');
  captcha_verify_param = body.captcha_verify_param || body.captchaVerifyParam || '';
} catch {}

if (!token && !cookie) throw new Error('Could not find Authorization Bearer token or Cookie header in curl input');
const account = {
  id: `zai-${Date.now()}`,
  provider: 'glm',
  backend: 'zai'
};
if (token) account.token = token;
if (cookie) account.cookie = cookie;
if (captcha_verify_param) account.captcha_verify_param = captcha_verify_param;

fs.writeFileSync(outPath, JSON.stringify({ accounts: [account] }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ outPath, hasToken: !!token, hasCookie: !!cookie, hasCaptcha: !!captcha_verify_param }, null, 2));
