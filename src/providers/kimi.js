import { contentToText, preparePrompt } from '../message.js';

const BASE='https://www.kimi.com';
const HEADERS={ 
  Accept:'*/*',
  'Cache-Control':'no-cache',
  Pragma:'no-cache',
  Origin:BASE,
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  'X-Msh-Platform':'web',
  'Connect-Protocol-Version': '1',
  'X-Msh-Version': '2.0.0'
};
// www.kimi.com (international, Connect-RPC) appears to scope a chat_id/message
// to a particular session identity. Our JWT carries device_id/region (see
// jwtPayload below); the x-msh-platform header alone is not enough to prove
// that identity to the server, which is the most likely cause of
// REASON_CHAT_MESSAGE_NOT_FOUND on the 2nd+ turn of a session (chat_id/parent_id
// point at a chat that, from the server's point of view, belongs to a
// different/unidentified session). The header names below are a best-effort
// guess from the JWT shape — confirm the real ones with
// `node scripts/kimi_dump_curl_headers.js` (paste a "Copy as cURL" of a real
// browser Chat request) and drop any corrected values into KIMI_EXTRA_HEADERS,
// which always wins over the guesses below.
const KIMI_LANGUAGE = process.env.KIMI_LANGUAGE || 'en-US';
const KIMI_TIMEZONE = process.env.KIMI_TIMEZONE || 'America/Los_Angeles';
const KIMI_EXTRA_HEADERS = (() => {
  try { return JSON.parse(process.env.KIMI_EXTRA_HEADERS || '{}'); } catch { return {}; }
})();
const DEBUG_KIMI = ['1','true','yes','on'].includes(String(process.env.DEBUG_KIMI || '').toLowerCase());
function ts(){return Math.floor(Date.now()/1000)}
function jwtPayload(token){ try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } }
function frameJson(obj){ const b=Buffer.from(JSON.stringify(obj)); const f=Buffer.alloc(5+b.length); f.writeUInt8(0,0); f.writeUInt32BE(b.length,1); b.copy(f,5); return f; }
export function parseKimiFrames(buffer){
  const out=[]; let off=0;
  while (off+5<=buffer.length) { const len=buffer.readUInt32BE(off+1); if (off+5+len>buffer.length) break; const raw=buffer.slice(off+5,off+5+len).toString('utf8'); try { out.push(JSON.parse(raw)); } catch {} off += 5+len; }
  return out;
}
export class KimiProvider {
  constructor(account){
    this.account=account;
    this.token=account.token || account.accessToken || account.refreshToken || account.refresh_token;
    if(!this.token) throw new Error('Kimi token missing');
    this.jwt=jwtPayload(this.token);
    if (DEBUG_KIMI) console.error('[FreeGLMKimiAPI] Kimi JWT payload:', JSON.stringify(this.jwt));
  }
  // Best-effort session-identity headers derived from the JWT, so a chat
  // created on turn 1 is recognized as belonging to the same
  // device/session on turn 2+. Real header names are unconfirmed (see the
  // note above HEADERS) — KIMI_EXTRA_HEADERS overrides anything here.
  identityHeaders(){
    const h={};
    // Try multiple possible header names for each JWT field
    if (this.jwt.device_id) {
      h['X-Msh-Device-Id'] = String(this.jwt.device_id);
      h['x-msh-device-id'] = String(this.jwt.device_id);
      h['X-Device-Id'] = String(this.jwt.device_id);
    }
    if (this.jwt.region) {
      h['X-Msh-Region'] = String(this.jwt.region);
      h['x-msh-region'] = String(this.jwt.region);
      h['X-Region'] = String(this.jwt.region);
    }
    if (this.jwt.sub) {
      h['X-Traffic-Id'] = String(this.jwt.sub);
      h['x-traffic-id'] = String(this.jwt.sub);
      h['X-User-Id'] = String(this.jwt.sub);
    }
    if (this.jwt.user_id) {
      h['X-User-Id'] = String(this.jwt.user_id);
    }
    if (this.jwt.space_id) {
      h['X-Msh-Space-Id'] = String(this.jwt.space_id);
      h['x-msh-space-id'] = String(this.jwt.space_id);
    }
    h['X-Language'] = KIMI_LANGUAGE;
    h['R-Timezone'] = KIMI_TIMEZONE;
    h['X-Timezone'] = KIMI_TIMEZONE;
    return { ...h, ...KIMI_EXTRA_HEADERS };
  }
  async complete({ messages, modelCfg, tools, session }) {
    const prompt=preparePrompt(messages, tools, { simpleTools:true, isMultiTurn: !!session.providerSessionId });
    const message={ role:'user', blocks:[{message_id:'', text:{content:prompt}}], scenario:'SCENARIO_K2D5' };
    if (session.parentMessageId) message.parent_id = session.parentMessageId;
    const payload={ scenario:'SCENARIO_K2D5', tools:modelCfg.webSearch ? [{type:'TOOL_TYPE_SEARCH',search:{}}] : [], message, options:{ thinking: !!modelCfg.thinking } };
    if (session.providerSessionId) payload.chat_id = session.providerSessionId;
    const reqHeaders={...HEADERS,...this.identityHeaders(),Authorization:`Bearer ${this.token}`,'Content-Type':'application/connect+json'};
    if (DEBUG_KIMI) console.error('[FreeGLMKimiAPI] Kimi request:', JSON.stringify({ chat_id: payload.chat_id||'(new)', parent_id: message.parent_id||'(none)', headers: reqHeaders }));
    const resp=await fetch(`${BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, { method:'POST', headers:reqHeaders, body:frameJson(payload) });
    if (!resp.ok) {
      const errText = (await resp.text()).slice(0,500);
      const err = new Error(`Kimi HTTP ${resp.status}: ${errText}`);
      err.status = resp.status;
      err.body = errText;
      // Detect token expiry so account manager can rotate to another account
      if (resp.status === 401 && /token is expired|invalid user token|unauthenticated/i.test(errText)) {
        err.code = 'TOKEN_EXPIRED';
      }
      throw err;
    }
    const arr=Buffer.from(await resp.arrayBuffer());
    const frames=parseKimiFrames(arr);
    if (DEBUG_KIMI) console.error('[FreeGLMKimiAPI] Kimi raw frames:', JSON.stringify(frames, null, 2));
    let text='', reasoning='', chatId='', parentId='';
    for (const d of frames) {
      // Try multiple possible field names for chat_id
      chatId ||= d.chat_id || d.chatId || d.message?.chat_id || d.message?.chatId || d.session_id || d.sessionId || d.conversation_id || d.conversationId || d.chat?.id || '';
      // Keep overwriting (not ||=) so the LAST message id seen in the stream
      // wins. If an early frame carries the user turn's own echoed id and a
      // later frame carries the assistant reply's id, we want the latter as
      // next turn's parent_id.
      parentId = d.message_id || d.messageId || d.message?.message_id || d.message?.id || parentId;
      if (d.error) throw new Error(`Kimi API Error: ${d.error.message || JSON.stringify(d.error)}`);
      const parts=[d.block?.text?.content,d.text?.content,d.message?.text?.content,d.message?.content,d.content,d.delta?.content].filter(Boolean);
      if ((d.op === 'set' || d.op === 'append') || parts.length) text += parts.join('');
      reasoning += d.reasoning_content || d.thinking?.content || '';
    }
    if (DEBUG_KIMI) console.error('[FreeGLMKimiAPI] Kimi response:', { chatId, parentId, textLength: text.length });
    return { text, reasoning, providerSessionId: chatId, parentMessageId: parentId, prompt };
  }
}
