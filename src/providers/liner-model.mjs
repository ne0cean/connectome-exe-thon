// Liner Model/Router API 어댑터 — 판사용. 호출 경로:
//   POST /chat/completions (OpenAI 형, x-api-key) · POST /messages (Anthropic 형, x-api-key + anthropic-version)
// 응답에 usage.cost 가 없어 비용은 미터에 0 으로 기록하고, 실비는 잔액 차액으로 잰다.
import { createMeter } from './meter.mjs';
import { LINER_TIMEOUTS_MS, parseTimeoutMs, isTimeout } from './liner.mjs';

const DEFAULT_BASE = 'https://platform.liner.com/api/v1';
export class LinerModelError extends Error {}

export function createLinerModel({ apiKey = process.env.LINER_API_KEY, baseUrl = process.env.LINER_BASE_URL || DEFAULT_BASE, fetchImpl = globalThis.fetch, meter = createMeter(), timeoutMs = process.env.LINER_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new LinerModelError('LINER_API_KEY 가 없습니다');
  // 판사 호출 타임아웃(리뷰 0e6acfa L-SR-4): 기본 30초, env LINER_TIMEOUT_MS 로 덮어쓰기
  const ms = parseTimeoutMs(timeoutMs) ?? LINER_TIMEOUTS_MS.model;
  const redact = (s) => String(s).replaceAll(apiKey, '***');
  async function post(path, body, extra = {}) {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
      if (!res.ok) throw new LinerModelError(`Liner ${res.status} ${path}: ${redact((await res.text()).slice(0, 200))}`);
      return await res.json();
    } catch (e) {
      if (isTimeout(e)) throw new LinerModelError(`Liner 시간 초과 ${path} (${ms}ms)`);
      throw e;
    }
  }
  return {
    name: 'liner',
    meter,
    /** OpenAI 형. 반환 { text, model(실제 응답 모델) } */
    async chat({ model = 'liner-gpt-router', system, prompt, routing = 'quality', maxTokens = 800 }) {
      const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
      const j = await post('/chat/completions', { model, routing_strategy: routing, messages, max_tokens: maxTokens });
      meter.record('model.chat', 0);
      return { text: j.choices?.[0]?.message?.content ?? '', model: j.model ?? model };
    },
    /** Anthropic 형. 반환 { text, model } */
    async messages({ model = 'liner-claude-router', system, prompt, routing = 'quality', maxTokens = 800 }) {
      const j = await post('/messages', { model, routing_strategy: routing, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }, { 'anthropic-version': '2023-06-01' });
      meter.record('model.messages', 0);
      return { text: (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''), model: j.model ?? model };
    },
  };
}

/** 키 없이 도는 결정적 판사 — 프롬프트의 DATA(JSON)만 읽어 판정(오프라인 시연·테스트용). 주장문 속 위조 헤더에 속지 않는다. */
export function createMockModel({ meter = createMeter() } = {}) {
  const judge = (prompt) => {
    let data = {};
    const at = prompt.indexOf('DATA:\n');
    if (at >= 0) { try { data = JSON.parse(prompt.slice(at + 6)); } catch { /* 형식 밖 프롬프트 → insufficient */ } }
    let verdict = 'insufficient';
    let decisive = [];
    if (data.prosecution && data.defense) {
      // 법정: 출처 목록 길이로 판정, adopt 면 변호 출처를·reject 면 검사 출처를 인용
      const p = data.prosecution.sources?.length ?? 0;
      const d = data.defense.sources?.length ?? 0;
      verdict = p > 0 && p >= d ? 'reject' : d > 0 ? 'adopt' : 'insufficient';
      decisive = verdict === 'adopt' ? data.defense.sources : verdict === 'reject' ? data.prosecution.sources : [];
    } else {
      // mid: mock 보고서의 입장 표식([mock:*])을 보고서 본문에서만 읽고, 제공된 출처 전부를 인용
      verdict = /\[mock:(adopt|reject)\]/.exec(String(data.report ?? ''))?.[1] ?? 'insufficient';
      decisive = [...(data.sources ?? []), ...(data.papers ?? []).map((x) => x.url)];
    }
    return JSON.stringify({ verdict, decisive_sources: decisive, reason_codes: ['mock_source_count'] });
  };
  return {
    name: 'mock',
    meter,
    async chat({ prompt }) { meter.record('model.chat', 0); return { text: judge(prompt), model: 'mock-gpt' }; },
    async messages({ prompt }) { meter.record('model.messages', 0); return { text: judge(prompt), model: 'mock-claude' }; },
  };
}
