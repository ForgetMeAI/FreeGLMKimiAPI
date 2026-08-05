import http from 'http';
import { pathToFileURL } from 'node:url';
import { PORT, HOST, MODELS, WATERMARK, MOCK_PROVIDER, AUTH_PATH, GLM_BACKEND, resolveModel, requireProxyAuth, ZAI_CDP_URL, ZAI_TOKEN_REFRESH_ENABLED, ZAI_TOKEN_REFRESH_THRESHOLD_MS, ZAI_TOKEN_REFRESH_COOLDOWN_MS, ZAI_TOKEN_REFRESH_INTERVAL_MS } from './config.js';
import { AccountManager } from './accounts.js';
import { SessionStore } from './sessions.js';
import { KimiProvider } from './providers/kimi.js';
import { GLMProvider } from './providers/glm.js';
import { ZaiProvider } from './providers/zai.js';
import { ZaiTokenRefresher } from './providers/zaiTokenRefresh.js';
import { mockComplete } from './mockProvider.js';
import { parseToolCallsFromText, buildToolCallCompletion, usage } from './tooling.js';
import { anthropicToOpenAI, openAIToAnthropic } from './anthropic.js';

const store=new SessionStore();
const accountManager=new AccountManager({ authPath: AUTH_PATH, env: process.env, cooldownMs: Number(process.env.ACCOUNT_COOLDOWN_MS || 60_000) });

// ── Z.ai auto-relogin via CDP ──
let zaiTokenRefresher = null;
if (ZAI_TOKEN_REFRESH_ENABLED && ZAI_CDP_URL) {
  zaiTokenRefresher = new ZaiTokenRefresher({
    cdpUrl: ZAI_CDP_URL,
    thresholdMs: ZAI_TOKEN_REFRESH_THRESHOLD_MS,
    cooldownMs: ZAI_TOKEN_REFRESH_COOLDOWN_MS,
    logger: console,
  });
  console.log(`[FreeGLMKimiAPI] Z.ai auto-relogin enabled — CDP: ${ZAI_CDP_URL}, threshold: ${Math.round(ZAI_TOKEN_REFRESH_THRESHOLD_MS/1000)}s, interval: ${Math.round(ZAI_TOKEN_REFRESH_INTERVAL_MS/1000)}s`);
  // Start proactive refresh check
  zaiTokenRefresher.startProactiveRefresh(
    () => accountManager.rawList().filter(a => a.provider === 'glm' && (a.backend || GLM_BACKEND) !== 'chatglm'),
    async (id, { token, cookie }) => {
      const updated = accountManager.updateToken(id, { token, cookie });
      console.log(`[FreeGLMKimiAPI] proactive token refresh for ${id} — ok=${!!updated}`);
    },
    ZAI_TOKEN_REFRESH_INTERVAL_MS
  );
} else if (ZAI_TOKEN_REFRESH_ENABLED) {
  console.warn('[FreeGLMKimiAPI] ZAI_TOKEN_REFRESH_ENABLED but no ZAI_CDP_URL set — auto-relogin disabled');
}

function json(res,status,obj){ const data=JSON.stringify(obj); res.writeHead(status, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}); res.end(data); }
async function readBody(req){ const chunks=[]; for await (const c of req) chunks.push(c); const raw=Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {}; }
function selectAccount(provider, session){ if (MOCK_PROVIDER) return { id:`mock-${provider}`, provider }; return accountManager.select(provider, session); }
function providerFor(modelCfg, account){
  if (modelCfg.provider==='kimi') return new KimiProvider(account);
  const backend=(account.backend || account.endpoint || GLM_BACKEND).toLowerCase();
  if (backend==='chatglm' || backend==='chatglm.cn') return new GLMProvider(account);
  return new ZaiProvider(account, { tokenRefresher: zaiTokenRefresher, accountManager, logger: console });
}
function textCompletion(content, model, prompt='', reasoning=''){ const msg={role:'assistant',content}; if(reasoning) msg.reasoning_content=reasoning; return { id:`fgk-${Date.now()}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{index:0,message:msg,finish_reason:'stop'}], usage:usage(prompt,content), watermark:WATERMARK }; }
function sseChunk(res,obj){ res.write(`data: ${JSON.stringify(obj)}\n\n`); }
async function doCompletion(body){
  const modelCfg=resolveModel(body.model); const agentId=body.user || body.metadata?.user_id || body.headers?.['x-agent-id'] || 'default'; const session=store.get(agentId, modelCfg.provider);
  let result;
  if (MOCK_PROVIDER) result={ text: await mockComplete({ prompt:(body.messages||[]).map(m=>m.content).join('\n'), model:modelCfg.id, tools:body.tools }), prompt:(body.messages||[]).map(m=>m.content).join('\n') };
  else {
    const maxAttempts=Math.max(1, accountManager.rawList().filter(a => a.provider===modelCfg.provider).length);
    let lastError;
    for (let attempt=0; attempt<maxAttempts; attempt++) {
      const account=selectAccount(modelCfg.provider, session);
      try {
        const provider=providerFor(modelCfg, account);
        result=await provider.complete({ messages:body.messages||[], modelCfg, tools:body.tools||[], session });
        accountManager.markSuccess(account.id);
        break;
      } catch (e) {
        lastError=e;
        accountManager.markFailure(account.id, e);
        session.accountId='';
        if (attempt === maxAttempts - 1) throw lastError;
      }
    }
  }
  store.update(session, result);
  const parsed=parseToolCallsFromText(result.text);
  if (parsed.toolCalls.length) return buildToolCallCompletion(parsed.toolCalls, modelCfg.id, result.prompt || '');
  return textCompletion(parsed.content || result.text || '', modelCfg.id, result.prompt || '', result.reasoning || '');
}
async function handleChat(req,res,body){
  const out=await doCompletion(body);
  if (body.stream) {
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    if (out.choices[0].message.tool_calls) sseChunk(res,{...out, object:'chat.completion.chunk', choices:[{index:0,delta:{role:'assistant',tool_calls:out.choices[0].message.tool_calls},finish_reason:'tool_calls'}]});
    else { sseChunk(res,{id:out.id,object:'chat.completion.chunk',created:out.created,model:out.model,choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]}); sseChunk(res,{id:out.id,object:'chat.completion.chunk',created:out.created,model:out.model,choices:[{index:0,delta:{content:out.choices[0].message.content},finish_reason:null}]}); sseChunk(res,{id:out.id,object:'chat.completion.chunk',created:out.created,model:out.model,choices:[{index:0,delta:{},finish_reason:'stop'}]}); }
    res.end('data: [DONE]\n\n'); return;
  }
  json(res,200,out);
}
function persistFrom(url, body){ if (url.searchParams.has('persist')) return url.searchParams.get('persist') !== 'false'; if (body && Object.hasOwn(body,'persist')) return body.persist !== false; return undefined; }
async function handleAdmin(req,res,url){
  if (req.method==='GET' && url.pathname==='/admin/accounts') return json(res,200,{accounts:accountManager.list()});
  if (req.method==='POST' && url.pathname==='/admin/accounts') { const body=await readBody(req); const { persist, ...account }=body; const saved=accountManager.add(account,{persist:persistFrom(url,body)}); return json(res,201,{account:saved,accounts:accountManager.list()}); }
  if (req.method==='POST' && url.pathname==='/admin/accounts/reload') return json(res,200,{accounts:accountManager.reload()});
  if (req.method==='POST' && url.pathname==='/admin/zai/refresh-token') {
    if (!zaiTokenRefresher) return json(res,400,{error:{message:'Z.ai auto-relogin not configured — set ZAI_CDP_URL'}});
    const result = await zaiTokenRefresher.refresh();
    if (!result?.ok) return json(res,502,{error:{message:'CDP token refresh failed',detail:result?.reason || 'unknown'}});
    // Auto-update all zai accounts with the fresh token
    const zaiAccounts = accountManager.rawList().filter(a => a.provider === 'glm' && (a.backend || GLM_BACKEND) !== 'chatglm');
    for (const acct of zaiAccounts) {
      accountManager.updateToken(acct.id, { token: result.token, cookie: result.cookie });
    }
    return json(res,200,{ok:true, tokenLength: result.token.length, cookieLength: result.cookie?.length || 0, accounts: accountManager.list()});
  }
  const m=url.pathname.match(/^\/admin\/accounts\/([^/]+)$/);
  if (m && req.method==='DELETE') return json(res,200,{deleted:accountManager.delete(decodeURIComponent(m[1]),{persist:persistFrom(url)})});
  return false;
}
async function router(req,res){
  try {
    const url=new URL(req.url, `http://${req.headers.host}`);
    if (!requireProxyAuth(req)) return json(res,401,{error:{message:'Unauthorized',type:'auth_error'}});
    if (url.pathname.startsWith('/admin/')) { const handled=await handleAdmin(req,res,url); if (handled !== false) return; }
    if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/health')) return json(res,200,{ok:true,name:'FreeGLMKimiAPI',mock:MOCK_PROVIDER,accounts:accountManager.list(),watermark:WATERMARK});
    if (req.method==='GET' && (url.pathname==='/v1/models' || url.pathname==='/models')) return json(res,200,{object:'list',data:Object.keys(MODELS).map(id=>({id,object:'model',created:0,owned_by:MODELS[id].provider}))});
    if (req.method==='GET' && url.pathname==='/sessions') return json(res,200,{sessions:store.dump()});
    if (req.method==='POST' && (url.pathname==='/v1/chat/completions' || url.pathname==='/chat/completions')) return await handleChat(req,res,await readBody(req));
    if (req.method==='POST' && (url.pathname==='/v1/messages' || url.pathname==='/messages')) { const body=await readBody(req); const open=anthropicToOpenAI(body); const resp=await doCompletion(open); return json(res,200,openAIToAnthropic(resp)); }
    json(res,404,{error:{message:'Not found',path:url.pathname}});
  } catch (e) { console.error('[FreeGLMKimiAPI]', e); json(res,500,{error:{message:e.message,type:'server_error'}}); }
}

export const server=http.createServer(router);
// Use pathToFileURL so the "is main module" check matches import.meta.url on
// Windows too (argv[1] uses backslashes + drive letter; a raw `file://` concat
// never matches the file:/// URL, so the server silently never listened).
if (import.meta.url === pathToFileURL(process.argv[1]).href) server.listen(PORT, HOST, () => console.log(`FreeGLMKimiAPI ${HOST}:${PORT} mock=${MOCK_PROVIDER}`));
