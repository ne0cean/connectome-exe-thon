import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinerMcp, pickRpc } from '../src/providers/liner-mcp.mjs';
import { shop } from '../demo/agent.mjs';

test('Liner MCP 클라이언트: initialize→initialized→tools/call, 세션 헤더 유지, SSE·JSON 응답 모두 해석', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ method: body.method, session: init.headers['Mcp-Session-Id'] ?? null, auth: init.headers.Authorization });
    if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'S1' } });
    if (!('id' in body)) return new Response(null, { status: 202 });
    const rpc = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"results":[]}' }], isError: false } };
    return new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const m = createLinerMcp({ apiKey: 'k', url: 'https://x.test/mcp', fetchImpl });
  assert.equal((await m.call('search_web', { query: 'q' })).text, '{"results":[]}');
  assert.deepEqual(seen.map((s) => [s.method, s.session]), [['initialize', null], ['notifications/initialized', 'S1'], ['tools/call', 'S1']]);
  assert.equal(seen[0].auth, 'Bearer k');
});

test('Liner MCP 클라이언트: 도구 오류·HTTP 오류 본문에서 키를 가린다', async () => {
  const fetchImpl = async () => new Response('denied SECRET', { status: 401 });
  await assert.rejects(createLinerMcp({ apiKey: 'SECRET', url: 'https://x.test', fetchImpl }).listTools(), (e) => /401/.test(e.message) && !e.message.includes('SECRET'));
  assert.equal(pickRpc('data: {"id":2}\ndata: {"id":1,"result":1}', 1).result, 1);
  assert.equal(pickRpc('data: oops', 1), null);
});

test('리뷰 43b5e7b LOW: 실패한 initialize 는 캐시하지 않고, 세션 만료 404 면 재초기화 후 재시도, 여러 줄 SSE data 를 읽는다', async () => {
  let initCalls = 0;
  let failInit = true;
  let expireOnce = true;
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push([body.method, init.headers['Mcp-Session-Id'] ?? null]);
    if (body.method === 'initialize') {
      initCalls++;
      if (failInit) { failInit = false; return new Response('busy', { status: 503 }); }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': `S${initCalls}` } });
    }
    if (!('id' in body)) return new Response(null, { status: 202 });
    if (expireOnce && init.headers['Mcp-Session-Id'] === 'S2') { expireOnce = false; return new Response('gone', { status: 404 }); }
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }, null, 1);
    return new Response(`event: message\n${rpc.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const m = createLinerMcp({ apiKey: 'k', url: 'https://x.test/mcp', fetchImpl });
  await assert.rejects(m.call('search_web', {}), /503/);
  assert.equal((await m.call('search_web', {})).text, 'ok');
  assert.equal(initCalls, 3);
  assert.deepEqual(seen.filter(([meth]) => meth === 'tools/call').map(([, sid]) => sid), ['S2', 'S3']);
});

test('데모 에이전트: careful 은 최저 표시 값·여러 판매처 기록, hasty 는 첫 값·한 곳', async () => {
  const tool = { name: 't', search: async () => [
    { url: 'https://blog.example/a', description: '공식가는 36만 9천 원' },
    { url: 'https://compare.example/b', description: '최저287,490원 · 할인율 4% 가격 275,750원' },
  ] };
  const c = await shop('X', { tool, style: 'careful' });
  assert.deepEqual([c.claim.price_krw, c.claim.seller_url, c.tool_calls.length], [287490, 'https://compare.example/b', 3]);
  const h = await shop('X', { tool, style: 'hasty' });
  assert.deepEqual([h.claim.price_krw, h.tool_calls.length], [369000, 2]);
  assert.equal(await shop('X', { tool: { name: 't', search: async () => [] } }), null);
});
