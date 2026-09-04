import crypto from 'crypto';
import { preparePrompt } from '../message.js';
import { getZaiBrowserClient, isZaiCaptchaError, shouldUseZaiBrowserFallback } from './zaiBrowser.js';

export const ZAI_BASE = 'https://chat.z.ai';
export const ZAI_FE_VERSION = process.env.ZAI_FE_VERSION || 'prod-fe-1.1.46';
export const ZAI_USER_AGENT = process.env.ZAI_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
export const ZAI_ACCEPT_LANGUAGE = process.env.ZAI_ACCEPT_LANGUAGE || 'en-US';
export const ZAI_LANGUAGE = process.env.ZAI_LANGUAGE || 'ru-RU';
export const ZAI_LANGUAGES = process.env.ZAI_LANGUAGES || 'ru-RU,ru,en-US,en';
export const ZAI_TIMEZONE = process.env.ZAI_TIMEZONE || 'Europe/Samara';
export const ZAI_TIMEZONE_OFFSET = process.env.ZAI_TIMEZONE_OFFSET || '-240';

function randomUuid(){ return crypto.randomUUID(); }
function contentDelta(obj){
  const data = obj?.data;
  return obj?.choices?.[0]?.delta?.content
    || obj?.choices?.[0]?.message?.content
    || obj?.delta?.content
    || obj?.message?.content
    || obj?.content
    || data?.delta_content
    || data?.content
    || data?.message?.content
    || data?.data?.delta_content
    || data?.data?.content
    || '';
}

function nestedError(obj) {
  return obj?.data?.error || obj?.error || obj?.data?.data?.error || null;
}

function buildCookie(token, cookie) {
  if (!cookie) return `token=${token}`;
  const trimmed = String(cookie).trim();
  return /(?:^|;\s*)token=/.test(trimmed) ? trimmed : `${trimmed}; token=${token}`;
}

function normalizeCaptchaVerifyParam(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed;
}

export function extractUserIdFromZaiToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return 'guest';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.id || payload.user_id || payload.uid || payload.sub || 'guest';
  } catch { return 'guest'; }
}

export function generateZaiSignature(messageText, requestId, timestampMs, userId) {
  const secret = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
  const meta = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`;
  const b64Message = Buffer.from(messageText || '', 'utf8').toString('base64');
  const canonical = `${meta}|${b64Message}|${timestampMs}`;
  const windowIndex = Math.floor(timestampMs / (5 * 60 * 1000));
  const derivedKeyHex = crypto.createHmac('sha256', secret).update(String(windowIndex)).digest('hex');
  return crypto.createHmac('sha256', derivedKeyHex).update(canonical).digest('hex');
}

export function parseZaiSse(raw) {
  let text='', reasoning='', parentMessageId='', providerSessionId='';
  for (const block of String(raw || '').split(/\n\n+/)) {
    const line = block.split('\n').find(l => l.startsWith('data:'));
    if (!line) continue;
    const data = line.replace(/^data:\s*/, '').trim();
    if (!data || data === '[DONE]') continue;
    try {
      const obj = JSON.parse(data);
      const err = nestedError(obj);
      if (err) {
        return { text, reasoning, parentMessageId, providerSessionId, error: err?.message || err?.detail || err?.code || JSON.stringify(err) };
      }
      const eventData = obj?.type === 'chat:completion' && obj?.data ? obj.data : obj;
      const delta = contentDelta(obj);
      if (eventData?.phase === 'thinking') reasoning += delta;
      else text += delta;
      reasoning += obj?.choices?.[0]?.delta?.reasoning_content || obj?.reasoning_content || obj?.thinking || eventData?.reasoning_content || eventData?.thinking || '';
      parentMessageId ||= obj.message_id || obj.messageId || obj?.message?.id || obj?.data?.message_id || (eventData?.role === 'assistant' ? eventData?.id : '') || '';
      providerSessionId ||= obj.chat_id || obj.chatId || obj?.chat?.id || obj?.data?.chat_id || eventData?.chat_id || '';
    } catch {}
  }
  return { text, reasoning, parentMessageId, providerSessionId };
}

export function buildZaiRequest({ token, model='glm-5', prompt='', chatId='', parentMessageId=null, thinking=false, webSearch=false, deepResearch=false, captchaVerifyParam=null, cookie=null, now=()=>Date.now(), uuid=randomUuid } = {}) {
  const timestamp = now();
  const requestId = uuid();
  const messageId = uuid();
  const userId = extractUserIdFromZaiToken(token);
  const signature = generateZaiSignature(prompt, requestId, timestamp, userId);
  const localTime = new Date(timestamp);
  const query = new URLSearchParams({
    timestamp: String(timestamp), requestId, user_id: userId, version: '0.0.1', platform: 'web', token,
    user_agent: ZAI_USER_AGENT,
    language: ZAI_LANGUAGE, languages: ZAI_LANGUAGES, timezone: ZAI_TIMEZONE, cookie_enabled: 'true',
    screen_width: process.env.ZAI_SCREEN_WIDTH || '2048', screen_height: process.env.ZAI_SCREEN_HEIGHT || '858', screen_resolution: process.env.ZAI_SCREEN_RESOLUTION || '2048x858', viewport_height: process.env.ZAI_VIEWPORT_HEIGHT || '718', viewport_width: process.env.ZAI_VIEWPORT_WIDTH || '1358', viewport_size: process.env.ZAI_VIEWPORT_SIZE || '1358x718', color_depth: process.env.ZAI_COLOR_DEPTH || '24', pixel_ratio: process.env.ZAI_PIXEL_RATIO || '2',
    current_url: chatId ? `${ZAI_BASE}/c/${chatId}` : ZAI_BASE, pathname: chatId ? `/c/${chatId}` : '/', search:'', hash:'', host: 'chat.z.ai', hostname: 'chat.z.ai', protocol: 'https:', referrer:'',
    title: 'Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5', timezone_offset: ZAI_TIMEZONE_OFFSET, local_time: localTime.toISOString(), utc_time: localTime.toUTCString(), is_mobile:'false', is_touch:'false', max_touch_points:'0', browser_name:'Chrome', os_name:'Mac OS', signature_timestamp: String(timestamp)
  });
  const body = {
    stream: true,
    model,
    messages: [{ role: 'user', content: prompt }],
    signature_prompt: prompt,
    params: {},
    extra: {},
    features: { image_generation: false, web_search: !!webSearch, deep_research: !!deepResearch, auto_web_search: false, preview_mode: true, flags: [], vlm_tools_enable: false, vlm_web_search_enable: false, vlm_website_mode: false, enable_thinking: !!thinking },
    variables: {
      '{{USER_NAME}}': process.env.ZAI_USER_NAME || 'test', '{{USER_LOCATION}}':'Unknown', '{{CURRENT_DATETIME}}':localTime.toISOString().replace('T',' ').substring(0,19),
      '{{CURRENT_DATE}}':localTime.toISOString().substring(0,10), '{{CURRENT_TIME}}':localTime.toISOString().substring(11,19), '{{CURRENT_WEEKDAY}}':['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][localTime.getDay()], '{{CURRENT_TIMEZONE}}':ZAI_TIMEZONE, '{{USER_LANGUAGE}}':'en-US'
    },
    chat_id: chatId,
    id: requestId,
    current_user_message_id: messageId,
    current_user_message_parent_id: parentMessageId,
    background_tasks: { title_generation: true, tags_generation: true }
  };
  const normalizedCaptcha = normalizeCaptchaVerifyParam(captchaVerifyParam);
  if (normalizedCaptcha) body.captcha_verify_param = normalizedCaptcha;
  const headers = {
    Accept: '*/*', Connection: 'keep-alive', 'Accept-Encoding':'gzip, deflate, br, zstd', 'Accept-Language': ZAI_ACCEPT_LANGUAGE, 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Signature': signature,
    'X-FE-Version': ZAI_FE_VERSION, 'X-Region': 'overseas', Cookie: buildCookie(token, cookie), Origin: ZAI_BASE, Referer: chatId ? `${ZAI_BASE}/c/${chatId}` : `${ZAI_BASE}/`,
    'Sec-Fetch-Dest':'empty', 'Sec-Fetch-Mode':'cors', 'Sec-Fetch-Site':'same-origin', 'sec-ch-ua':'"Not/A)Brand";v="99", "Chromium";v="148"', 'sec-ch-ua-mobile':'?0', 'sec-ch-ua-platform':'"macOS"', Priority:'u=1, i',
    'User-Agent': ZAI_USER_AGENT
  };
  return { url: `${ZAI_BASE}/api/v2/chat/completions?${query.toString()}`, body, headers, requestId, messageId, signature };
}

export class ZaiProvider {
  constructor(account){ this.account=account; this.token=account.token || account.accessToken || account.access_token || account.jwt || account.refresh_token || account.refreshToken; this.cookie = account.cookie || account.cookies || process.env.ZAI_COOKIE || null; this.captchaVerifyParam = account.captcha_verify_param || account.captchaVerifyParam || process.env.ZAI_CAPTCHA_VERIFY_PARAM || null; this.browserFallback = shouldUseZaiBrowserFallback(process.env, account); if(!this.token) throw new Error('Z.ai token missing'); }
  async createChat(model, prompt) {
    const timestamp = Math.floor(Date.now()/1000);
    const messageId = randomUuid();
    const body = { chat: { id:'', title:'New Chat', models:[model], params:{}, history:{ messages: prompt ? { [messageId]: { id:messageId, parentId:null, childrenIds:[], role:'user', content:prompt, timestamp, models:[model] } } : {}, currentId: prompt ? messageId : '' }, tags:[], flags:[], features:[{type:'tool_selector',server:'tool_selector_h',status:'hidden'}], mcp_servers:[], enable_thinking:false, auto_web_search:false, message_version:1, extra:{}, timestamp:Date.now() } };
    const resp = await fetch(`${ZAI_BASE}/api/v1/chats/new`, { method:'POST', headers:{ Authorization:`Bearer ${this.token}`, 'Content-Type':'application/json', 'Accept-Language':ZAI_ACCEPT_LANGUAGE, 'X-FE-Version':ZAI_FE_VERSION, 'X-Region':'overseas', Cookie:buildCookie(this.token, this.cookie), Origin:ZAI_BASE, Referer:`${ZAI_BASE}/`, 'User-Agent':ZAI_USER_AGENT }, body:JSON.stringify(body) });
    const data = await resp.json().catch(()=>null);
    if (!resp.ok || !data?.id) throw new Error(`Z.ai create chat failed HTTP ${resp.status}: ${JSON.stringify(data).slice(0,200)}`);
    return { chatId:data.id, messageId };
  }
  async complete({ messages, modelCfg, tools, session }) {
    const prompt = preparePrompt(messages, tools, { simpleTools:false, isMultiTurn:!!session.providerSessionId });
    let chatId = session.providerSessionId || '';
    let parentId = session.parentMessageId || null;
    if (!chatId) {
      const created = await this.createChat(modelCfg.id, prompt);
      chatId = created.chatId;
      parentId = created.messageId;
    }
    const req = buildZaiRequest({ token:this.token, model:modelCfg.id, prompt, chatId, parentMessageId:parentId, thinking:modelCfg.thinking, webSearch:modelCfg.webSearch, deepResearch:modelCfg.deepResearch, captchaVerifyParam:this.captchaVerifyParam, cookie:this.cookie });
    const resp = await fetch(req.url, { method:'POST', headers:req.headers, body:JSON.stringify(req.body) });
    const raw = await resp.text();
    if (!resp.ok) {
      if (this.browserFallback) {
        const browser = getZaiBrowserClient();
        const browserResult = await browser.completeAndParse(req, { token:this.token, chatId });
        if (!browserResult.ok) throw new Error(`Z.ai browser HTTP ${browserResult.status}: ${browserResult.raw.slice(0,200)}`);
        const browserParsed = browserResult.parsed;
        if (browserParsed.error) throw new Error(`Z.ai browser error: ${browserParsed.error}`);
        return { text: browserParsed.text || browserResult.raw, reasoning: browserParsed.reasoning, providerSessionId: browserParsed.providerSessionId || chatId, parentMessageId: browserParsed.parentMessageId || req.messageId, prompt };
      }
      throw new Error(`Z.ai HTTP ${resp.status}: ${raw.slice(0,200)}`);
    }
    let parsed = parseZaiSse(raw);
    if (parsed.error && this.browserFallback && isZaiCaptchaError(parsed.error)) {
      const browser = getZaiBrowserClient();
      const browserResult = await browser.completeAndParse(req, { token:this.token, chatId });
      if (!browserResult.ok) throw new Error(`Z.ai browser HTTP ${browserResult.status}: ${browserResult.raw.slice(0,200)}`);
      parsed = browserResult.parsed;
      if (parsed.error) throw new Error(`Z.ai browser error: ${parsed.error}`);
    } else if (parsed.error) {
      throw new Error(`Z.ai error: ${parsed.error}`);
    }
    return { text: parsed.text || raw, reasoning: parsed.reasoning, providerSessionId: parsed.providerSessionId || chatId, parentMessageId: parsed.parentMessageId || req.messageId, prompt };
  }
}
