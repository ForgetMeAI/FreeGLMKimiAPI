import http from 'http';
import { pathToFileURL } from 'node:url';
import { PORT, HOST, MODELS, WATERMARK, MOCK_PROVIDER, AUTH_PATH, GLM_BACKEND, SESSION_TTL_MS, SESSION_MAX_DEPTH, MODEL_CATALOG_PATH, MODEL_RETIRE_AFTER_FAILURES, MODEL_ERROR_PATTERNS_EXTRA, resolveModel, requireProxyAuth } from './config.js';
import { AccountManager } from './accounts.js';
import { SessionStore } from './sessions.js';
import { ModelCatalog, isModelError } from './modelCatalog.js';
import { KimiProvider } from './providers/kimi.js';
import { GLMProvider } from './providers/glm.js';
import { ZaiProvider } from './providers/zai.js';
import { getZaiBrowserClient } from './providers/zaiBrowser.js';
import { mockComplete } from './mockProvider.js';
import { parseToolCallsFromText, buildToolCallCompletion, usage } from './tooling.js';
import { anthropicToOpenAI, openAIToAnthropic } from './anthropic.js';
import { contentToText } from './message.js';

const store=new SessionStore({ ttlMs: SESSION_TTL_MS, maxDepth: SESSION_MAX_DEPTH });
const accountManager=new AccountManager({ authPath: AUTH_PATH, env: process.env, cooldownMs: Number(process.env.ACCOUNT_COOLDOWN_MS || 60_000) });
const modelCatalog=new ModelCatalog({ staticModels: MODELS, catalogPath: MODEL_CATALOG_PATH, retireAfterFailures: MODEL_RETIRE_AFTER_FAILURES, extraErrorPatterns: MODEL_ERROR_PATTERNS_EXTRA });

// Safety net: log any stray unhandled rejection instead of letting Node's
// default behavior kill the whole process. This does NOT replace fixing the
// actual source (see zaiBrowser.js completeViaUi) — it just stops one bad
// promise from taking down every in-flight request when the fleet is under
// heavy parallel load.
process.on('unhandledRejection', (err) => {
  console.error('[FreeGLMKimiAPI] unhandled rejection (recovered):', err);
});

function json(res,status,obj){ const data=JSON.stringify(obj); res.writeHead(status, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}); res.end(data); }
async function readBody(req){ const chunks=[]; for await (const c of req) chunks.push(c); const raw=Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {}; }
function selectAccount(provider, session){ if (MOCK_PROVIDER) return { id:`mock-${provider}`, provider }; return accountManager.select(provider, session); }
function providerFor(modelCfg, account){ if (modelCfg.provider==='kimi') return new KimiProvider(account); const backend=(account.backend || account.endpoint || GLM_BACKEND).toLowerCase(); return backend==='chatglm' || backend==='chatglm.cn' ? new GLMProvider(account) : new ZaiProvider(account); }
function textCompletion(content, model, prompt='', reasoning='', session=null){ const msg={role:'assistant',content}; if(reasoning) msg.reasoning_content=reasoning; const out={ id:`fgk-${Date.now()}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{index:0,message:msg,finish_reason:'stop'}], usage:usage(prompt,content), watermark:WATERMARK }; if (session) out.session={agent_id:session.agentId,provider:session.provider,chat_id:session.providerSessionId}; return out; }
function sseChunk(res,obj){ res.write(`data: ${JSON.stringify(obj)}\n\n`); }
async function doCompletion(body, reqHeaders={}){
  const modelCfg=resolveModel(body.model);
  // 'user' (OpenAI) / metadata.user_id (Anthropic) are the primary, actively
  // used way callers scope a session (see scripts/agent_smoke.js). The
  // x-agent-id HTTP header is a fallback for callers that can't set those —
  // it must come from the real request headers, not the JSON body (a
  // "headers" key inside the JSON payload is never populated by any client).
  const agentId=body.user || body.metadata?.user_id || reqHeaders['x-agent-id'] || 'default';
  const session=store.get(agentId, modelCfg.provider);
  // Serialize everything that reads/writes this session's provider-continuity
  // state (chat_id/parent_id/accountId) behind a per-key lock. See
  // SessionStore.withLock for why this matters.
  return store.withLock(session.key, () => runCompletion(body, modelCfg, session));
}
async function runCompletion(body, modelCfg, session){
  const lastMsg=body.messages?.[body.messages.length - 1];
  if (contentToText(lastMsg?.content).trim() === '/new') {
    session.providerSessionId = ''; session.parentMessageId = ''; session.messageCount = 0;
    return textCompletion('Session reset. You can now start a new conversation.', modelCfg.id, '', '', session);
  }
  let result;
  const maxAttempts = MOCK_PROVIDER ? 1 : Math.max(1, accountManager.rawList().filter(a => a.provider===modelCfg.provider).length);
  let lastError;
  for (let attempt=0; attempt<maxAttempts; attempt++) {
    const account=selectAccount(modelCfg.provider, session);
    try {
      if (MOCK_PROVIDER) {
        const prompt=(body.messages||[]).map(m=>contentToText(m.content)).join('\n');
        // Simulate real provider-side chat continuity (a stable chat id for the
        // life of the session, a fresh message id each turn) so tests can
        // exercise session threading end-to-end without live GLM/Kimi accounts.
        // Read providerSessionId synchronously BEFORE the simulated network
        // delay, mirroring how kimi.js/zai.js build their outgoing payload from
        // session.providerSessionId before awaiting fetch() — that's the exact
        // read a missing lock would race on, so the simulation has to preserve
        // this ordering for the concurrency test to mean anything.
        const existingChatId = session.providerSessionId;
        const turnNumber = session.messageCount + 1;
        await new Promise(r => setTimeout(r, Math.random() * 15)); // simulated network latency
        result={
          text: await mockComplete({ prompt, model:modelCfg.id, tools:body.tools }),
          prompt,
          providerSessionId: existingChatId || `mock-chat-${session.key}-${Math.random().toString(36).slice(2,10)}`,
          parentMessageId: `mock-msg-${turnNumber}-${Math.random().toString(36).slice(2,10)}`
        };
      } else {
        const provider=providerFor(modelCfg, account);
        result=await provider.complete({ messages:body.messages||[], modelCfg, tools:body.tools||[], session });
      }
      accountManager.markSuccess(account.id);
      // A real completion against this model just succeeded — promote a
      // never-before-cataloged id into GET /v1/models ("auto-discovery"),
      // or clear any retired/failure state for a known one ("un-retirement").
      // See src/modelCatalog.js / docs/model-lifecycle.md.
      modelCatalog.recordSuccess(modelCfg);
      break;
    } catch (e) {
      lastError=e;
      if (isModelError(e, modelCatalog.extraPatterns)) {
        // This looks like the provider rejecting the MODEL itself (wrong/
        // dead model id), not an account/session/transient problem — retrying
        // with a different account against the same bad model would just
        // fail identically, so stop immediately instead of burning the rest
        // of maxAttempts. Record it and let the client see a clearer error.
        const entry=modelCatalog.recordFailure(modelCfg, e);
        e.message=`${e.message} [model "${modelCfg.id}" looks unavailable upstream: ${entry.consecutiveFailures}/${modelCatalog.retireAfterFailures} consecutive model-shaped failures${entry.status==='retired' ? ', now retired from GET /v1/models' : ''} — see GET /v1/models?all=1]`;
        throw e;
      }
      accountManager.markFailure(account.id, e);
      session.accountId='';
      if (attempt === maxAttempts - 1) throw lastError;
    }
  }
  store.update(session, result);
  const parsed=parseToolCallsFromText(result.text);
  if (parsed.toolCalls.length) return buildToolCallCompletion(parsed.toolCalls, modelCfg.id, result.prompt || '', session);
  return textCompletion(parsed.content || result.text || '', modelCfg.id, result.prompt || '', result.reasoning || '', session);
}
async function handleChat(req,res,body){
  const out=await doCompletion(body, req.headers);
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
  const m=url.pathname.match(/^\/admin\/accounts\/([^/]+)$/);
  if (m && req.method==='DELETE') return json(res,200,{deleted:accountManager.delete(decodeURIComponent(m[1]),{persist:persistFrom(url)})});
  // Model catalog admin — see docs/model-lifecycle.md.
  if (req.method==='GET' && url.pathname==='/admin/models') return json(res,200,{models:modelCatalog.list({includeRetired:true})});
  if (req.method==='POST' && url.pathname==='/admin/models') { const body=await readBody(req); return json(res,201,{model:modelCatalog.upsert(body)}); }
  const rm=url.pathname.match(/^\/admin\/models\/([^/]+)\/restore$/);
  if (rm && req.method==='POST') { const body=await readBody(req).catch(()=>({})); const provider=body.provider || url.searchParams.get('provider') || 'kimi'; return json(res,200,{model:modelCatalog.restore(provider, decodeURIComponent(rm[1]))}); }
  const dm=url.pathname.match(/^\/admin\/models\/([^/]+)$/);
  if (dm && req.method==='DELETE') { const provider=url.searchParams.get('provider') || 'kimi'; return json(res,200,{deleted:modelCatalog.remove(provider, decodeURIComponent(dm[1]))}); }
  // Z.ai browser-fallback introspection — see docs/browser-fallback.md.
  // getZaiBrowserClient() only constructs the JS wrapper; it does not by
  // itself launch Chromium, so checking status here is always cheap/safe.
  if (req.method==='GET' && url.pathname==='/admin/browser') return json(res,200,{browser:getZaiBrowserClient().describeState()});
  if (req.method==='POST' && url.pathname==='/admin/browser/close') { await getZaiBrowserClient().close(); return json(res,200,{closed:true}); }
  return false;
}
async function router(req,res){
  try {
    const url=new URL(req.url, `http://${req.headers.host}`);
    if (!requireProxyAuth(req)) return json(res,401,{error:{message:'Unauthorized',type:'auth_error'}});
    if (url.pathname.startsWith('/admin/')) { const handled=await handleAdmin(req,res,url); if (handled !== false) return; }
    if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/health')) return json(res,200,{ok:true,name:'FreeGLMKimiAPI',mock:MOCK_PROVIDER,accounts:accountManager.list(),watermark:WATERMARK});
    if (req.method==='GET' && (url.pathname==='/v1/models' || url.pathname==='/models')) return json(res,200,{object:'list',data:modelCatalog.list({includeRetired:url.searchParams.get('all')==='1'}).map(m=>({id:m.id,object:'model',created:0,owned_by:m.provider,status:m.status||'active'}))});
    if (req.method==='GET' && url.pathname==='/sessions') return json(res,200,{sessions:store.dump()});
    if (req.method==='POST' && (url.pathname==='/v1/chat/completions' || url.pathname==='/chat/completions')) return await handleChat(req,res,await readBody(req));
    if (req.method==='POST' && (url.pathname==='/v1/messages' || url.pathname==='/messages')) { const body=await readBody(req); const open=anthropicToOpenAI(body); const resp=await doCompletion(open, req.headers); return json(res,200,openAIToAnthropic(resp)); }
    json(res,404,{error:{message:'Not found',path:url.pathname}});
  } catch (e) { console.error('[FreeGLMKimiAPI]', e); json(res,500,{error:{message:e.message,type:'server_error'}}); }
}

export const server=http.createServer(router);
// Use pathToFileURL so the "is main module" check matches import.meta.url on
// Windows too (argv[1] uses backslashes + drive letter; a raw `file://` concat
// never matches the file:/// URL, so the server silently never listened).
if (import.meta.url === pathToFileURL(process.argv[1]).href) server.listen(PORT, HOST, () => console.log(`FreeGLMKimiAPI ${HOST}:${PORT} mock=${MOCK_PROVIDER}`));
