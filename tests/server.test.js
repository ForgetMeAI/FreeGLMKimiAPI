import test from 'node:test';
import assert from 'node:assert/strict';
process.env.MOCK_PROVIDER='1';
process.env.PORT='0';
const { server } = await import('../src/server.js');

function listen(){ return new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port))); }
function close(){ return new Promise(resolve => server.close(resolve)); }
async function post(port,path,body){ const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return {status:r.status,json:await r.json()}; }

test('OpenAI chat returns mock text', async () => {
  const port=await listen();
  try {
    const out=await post(port,'/v1/chat/completions',{model:'kimi-k2.5',messages:[{role:'user',content:'Reply exactly: OK_FREEGLMKIMI'}]});
    assert.equal(out.status,200);
    assert.equal(out.json.choices[0].message.content,'OK_FREEGLMKIMI');
  } finally { await close(); }
});

test('OpenAI tools become tool_calls', async () => {
  const port=await listen();
  try {
    const out=await post(port,'/v1/chat/completions',{model:'glm-5',messages:[{role:'user',content:'создай файл'}],tools:[{type:'function',function:{name:'write_file',parameters:{type:'object'}}}]});
    assert.equal(out.status,200);
    assert.equal(out.json.choices[0].finish_reason,'tool_calls');
    assert.equal(out.json.choices[0].message.tool_calls[0].function.name,'write_file');
  } finally { await close(); }
});

test('Anthropic shim emits tool_use', async () => {
  const port=await listen();
  try {
    const out=await post(port,'/v1/messages',{model:'kimi-k2.5',messages:[{role:'user',content:'use tool'}],tools:[{name:'read_file',input_schema:{type:'object'}}]});
    assert.equal(out.status,200);
    assert.equal(out.json.stop_reason,'tool_use');
    assert.equal(out.json.content[0].type,'tool_use');
  } finally { await close(); }
});

async function get(port,path){ const r=await fetch(`http://127.0.0.1:${port}${path}`); return {status:r.status,json:await r.json()}; }
async function del(port,path){ const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'DELETE'}); return {status:r.status,json:await r.json()}; }

test('admin accounts API adds lists deletes and reloads accounts without exposing secrets', async () => {
  const port=await listen();
  try {
    const added=await post(port,'/admin/accounts',{id:'admin-kimi',provider:'kimi',token:'secret',persist:false});
    assert.equal(added.status,201);
    assert.equal(added.json.account.id,'admin-kimi');
    assert.equal(added.json.account.hasToken,true);
    assert.equal(added.json.account.token,undefined);

    const listed=await get(port,'/admin/accounts');
    assert.equal(listed.status,200);
    assert.ok(listed.json.accounts.find(a => a.id === 'admin-kimi'));
    assert.equal(JSON.stringify(listed.json).includes('secret'), false);

    const removed=await del(port,'/admin/accounts/admin-kimi?persist=false');
    assert.equal(removed.status,200);
    assert.equal(removed.json.deleted,true);

    const reloaded=await post(port,'/admin/accounts/reload',{});
    assert.equal(reloaded.status,200);
    assert.ok(Array.isArray(reloaded.json.accounts));
  } finally { await close(); }
});

test('GET /admin/browser reports Z.ai browser-fallback state without launching real Chromium', async () => {
  const port = await listen();
  try {
    const r = await get(port, '/admin/browser');
    assert.equal(r.status, 200);
    assert.equal(r.json.browser.running, false, 'merely checking status must not launch a browser');
    assert.equal(r.json.browser.openScratchPages, 0);
  } finally { await close(); }
});

test('POST /admin/browser/close is a safe no-op when nothing is running', async () => {
  const port = await listen();
  try {
    const r = await post(port, '/admin/browser/close', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.closed, true);
  } finally { await close(); }
});
