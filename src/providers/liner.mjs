// Liner API 어댑터 — 검증소의 유일한 외부 의존 지점.
// 엔드포인트·파라미터·SSE 이벤트는 Liner 문서와 실호출로 확정한 것만 쓴다(참고: a-team scripts/multi-model/liner-research.mjs).
// 키는 env LINER_API_KEY 로만 받는다. 값은 출력·기록하지 않는다.
import { createMeter } from './meter.mjs';

export const DEFAULT_BASE = 'https://platform.liner.com/api/v1';

export class LinerError extends Error {}

// 호출별 기본 타임아웃(ms, 리뷰 0e6acfa L-SR-4). 응답 본문(SSE 스트림 포함)까지 이 시간 안에 끝나야 한다.
// env LINER_TIMEOUT_MS(또는 생성자 timeoutMs)가 있으면 전부 그 값으로 덮어쓴다. model 은 liner-model.mjs, mcp 는 liner-mcp.mjs 가 쓴다.
export const LINER_TIMEOUTS_MS = { web: 30_000, scholar: 30_000, quick: 30_000, search: 120_000, deep: 900_000, balance: 30_000, model: 30_000, mcp: 120_000 };

/** LINER_TIMEOUT_MS 해석: 없으면 undefined(호출별 기본값), 양수가 아니면 조용히 넘기지 않고 거절한다. */
export function parseTimeoutMs(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) throw new LinerError('LINER_TIMEOUT_MS 는 양의 정수(ms)여야 합니다');
  return n;
}

/** fetch·본문 읽기가 타임아웃 signal 로 끊겼는지 — 그렇다면 읽을 수 있는 오류 문구로 바꾼다. */
export const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

export function createLinerProvider({ apiKey = process.env.LINER_API_KEY, baseUrl = process.env.LINER_BASE_URL || DEFAULT_BASE, fetchImpl = globalThis.fetch, meter = createMeter(), timeoutMs = process.env.LINER_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new LinerError('LINER_API_KEY 가 없습니다 (.env 또는 환경변수). 키 없이 돌리려면 VERIFIER_PROVIDER=mock');
  const override = parseTimeoutMs(timeoutMs);
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  // 오류 본문이 키를 되돌려 줄 가능성에 대비해 메시지에서 가린다
  const redact = (s) => String(s).replaceAll(apiKey, '***');

  /** 요청 + 본문 처리(read)를 한 타임아웃 signal 아래서 돌린다 — signal 은 응답 본문 스트림까지 끊는다. */
  async function call(kind, path, init, read) {
    const ms = override ?? LINER_TIMEOUTS_MS[kind];
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
      if (!res.ok) throw new LinerError(`Liner ${res.status} ${path}: ${redact((await res.text()).slice(0, 200))}`);
      return await read(res);
    } catch (e) {
      if (isTimeout(e)) throw new LinerError(`Liner 시간 초과 ${path} (${ms}ms)`);
      throw e;
    }
  }
  const post = (kind, path, body, read, extra = {}) => call(kind, path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) }, read);

  // SSE 누적: text-delta → answer, data-search-references → references, data-error|error → 실패. [DONE] 없이 끝나면 잘린 결과라 실패.
  async function readStream(res) {
    const out = { answer: '', references: [] };
    const seen = new Set();
    const dec = new TextDecoder();
    let buf = '';
    const handle = (raw) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return true;
      let ev;
      try { ev = JSON.parse(data); } catch { return false; }
      if (ev.type === 'text-delta') out.answer += ev.delta || '';
      else if (ev.type === 'data-search-references') {
        for (const r of ev.data?.references || []) if (r?.url && !seen.has(r.url)) { seen.add(r.url); out.references.push(r); }
      } else if (ev.type === 'data-error' || ev.type === 'error') {
        throw new LinerError(redact(`Liner stream error: ${ev.data?.code || ev.code || ''} ${ev.data?.message || ev.message || ev.errorText || ''}`.trim()));
      }
      return false;
    };
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (handle(line)) return out;
      }
    }
    buf += dec.decode();
    if (buf && handle(buf)) return out;
    throw new LinerError('Liner stream ended without [DONE]');
  }

  async function agent(kind, path, api, question, extraBody = {}) {
    const out = await post(kind, path, { messages: [{ role: 'user', content: question }], stream: true, ...extraBody }, readStream, { Accept: 'text/event-stream' });
    meter.record(api);
    if (!out.answer.trim()) throw new LinerError(`Liner 빈 답 (${api})`);
    return out;
  }

  // 판사(createModelFor)가 같은 키·주소·타임아웃을 쓰도록 설정을 비열거 속성으로 싣는다(10차 L-SH-5: createLinerProvider 를 직접 만든 경우 포함)
  return Object.defineProperty({
    name: 'liner',
    meter,
    async web(query, { max = 10 } = {}) {
      // include_knowledge 를 생략하면 Premium 요금으로 과금된다 — 명시적으로 끈다.
      const j = await post('web', '/tools/search/web', { query, max_results: max, include_knowledge: false }, (res) => res.json());
      meter.record('search.web');
      return { results: j.results || [] };
    },
    async scholar(query, { max = 10 } = {}) {
      const j = await post('scholar', '/tools/search/scholar', { query, max_results: max }, (res) => res.json());
      meter.record('search.scholar');
      return { results: j.results || [] };
    },
    quick: (q) => agent('quick', '/agents/quick-answer', 'agent.quick', q),
    search: (q, { scholar = false, lang } = {}) => agent('search', '/agents/search', 'agent.search', q, { mode: scholar ? 'scholar' : 'general', ...(lang ? { lang } : {}) }),
    deep: (q, { lang } = {}) => agent('deep', '/agents/deep-research', 'agent.deep', q, lang ? { lang } : {}),
    /** 잔액(USD). 응답 balance 는 마이크로달러 정수, balance_usd 는 문자열. */
    async balance() {
      const j = await call('balance', '/credits/balance', { headers }, (res) => res.json());
      return { usd: Number(j.balance_usd ?? j.balance / 1e6) };
    },
  }, 'config', { value: { apiKey, baseUrl, timeoutMs } });
}
