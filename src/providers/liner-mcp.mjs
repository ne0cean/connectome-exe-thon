// Liner 공식 MCP(원격 Streamable HTTP) 최소 클라이언트 — 데모 에이전트의 도구. SDK 없이 JSON-RPC 2.0.
// 흐름: initialize(Mcp-Session-Id 받음) → notifications/initialized → tools/list · tools/call.
// 응답은 application/json 또는 text/event-stream(SSE) 둘 다 온다.
import { LINER_TIMEOUTS_MS, parseTimeoutMs, isTimeout } from './liner.mjs';

const DEFAULT_URL = 'https://platform.liner.com/api/v1/mcp';
export class LinerMcpError extends Error {
  constructor(message, { status } = {}) { super(message); this.status = status; }
}

/** SSE 본문에서 id 가 맞는 JSON-RPC 응답을 찾는다. 한 이벤트의 여러 data: 줄은 이어 붙여 읽고(SSE 규격), 안 되면 줄마다 읽는다. */
export function pickRpc(text, id) {
  const tryParse = (s) => { try { const j = JSON.parse(s); return j?.id === id ? j : null; } catch { return null; } };
  for (const event of String(text).replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (!data.length) continue;
    const whole = tryParse(data.join('\n'));
    if (whole) return whole;
    for (const line of data) { const j = tryParse(line.trim()); if (j) return j; }
  }
  return null;
}

export function createLinerMcp({ apiKey = process.env.LINER_API_KEY, url = process.env.LINER_MCP_URL || DEFAULT_URL, fetchImpl = globalThis.fetch, timeoutMs = process.env.LINER_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new LinerMcpError('LINER_API_KEY 가 없습니다');
  // 요청 하나(본문 읽기 포함)의 타임아웃(리뷰 0e6acfa L-SR-4): 기본 120초(도구가 검색 에이전트일 수 있어 search 와 같게), env LINER_TIMEOUT_MS 로 덮어쓰기
  const ms = parseTimeoutMs(timeoutMs) ?? LINER_TIMEOUTS_MS.mcp;
  const redact = (s) => String(s).replaceAll(apiKey, '***');
  let session = null;
  let seq = 0;
  async function send(method, params, opts) {
    try { return await sendOnce(method, params, opts); } catch (e) {
      if (isTimeout(e)) throw new LinerMcpError(`Liner MCP 시간 초과 ${method} (${ms}ms)`);
      throw e;
    }
  }
  async function sendOnce(method, params, { notify = false } = {}) {
    const id = notify ? undefined : ++seq;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) };
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }), signal: AbortSignal.timeout(ms) });
    session = res.headers.get('mcp-session-id') ?? session;
    if (!res.ok) throw new LinerMcpError(`Liner MCP ${res.status} ${method}: ${redact((await res.text()).slice(0, 200))}`, { status: res.status });
    if (notify) return null;
    const text = await res.text();
    const j = (res.headers.get('content-type') ?? '').includes('event-stream') ? pickRpc(text, id) : JSON.parse(text);
    if (!j) throw new LinerMcpError(`Liner MCP ${method}: 응답 없음`);
    if (j.error) throw new LinerMcpError(`Liner MCP ${method}: ${redact(j.error.message ?? j.error.code)}`);
    return j.result;
  }
  let ready = null;
  // 실패한 initialize 는 캐시하지 않는다 — 다음 호출이 다시 시도한다(리뷰 43b5e7b LOW)
  const init = () => (ready ??= (async () => {
    const r = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-verifier-demo', version: '0.1' } });
    await send('notifications/initialized', undefined, { notify: true });
    return r;
  })().catch((e) => { ready = null; throw e; }));
  // 세션 만료(404)면 세션을 버리고 한 번만 다시 초기화해 재시도한다(MCP Streamable HTTP 규격)
  const rpc = async (method, params) => {
    await init();
    try { return await send(method, params); } catch (e) {
      if (e.status !== 404 || !session) throw e;
      session = null; ready = null;
      await init();
      return send(method, params);
    }
  };
  return {
    async listTools() { return (await rpc('tools/list', {})).tools ?? []; },
    /** 반환: 도구 결과의 text 조각을 이어 붙인 문자열 + 원본 */
    async call(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) throw new LinerMcpError(`Liner MCP ${name}: ${redact(text.slice(0, 200))}`);
      return { text, raw: r };
    },
  };
}
