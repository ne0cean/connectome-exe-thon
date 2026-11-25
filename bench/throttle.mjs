// 실호출 속도 제한 대응. Liner 에이전트 API 는 동시 호출이 몇 건을 넘으면 429(RATE_LIMITED, retryable)를 돌려준다
// (실측 2026-11-22: agents/search 동시 2건 통과·3건째부터 429). 검증소 코드(src/)는 429 를 '조사 오류'로 삼켜 판정을 닫으므로,
// 측정이 속도 제한의 함수가 되지 않게 러너 쪽에서 공급자를 감싸 동시 수를 제한하고 429·5xx 는 물러났다가 다시 부른다.
// 재시도는 인프라 층이다 — 판정 규칙은 그대로이고, 실패한 시도는 미터에 기록되지 않는다(성공한 호출만 센다).

export const RETRYABLE = /Liner (429|500|502|503|504)\b|RATE_LIMITED|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 지수 물러남 재시도. 재시도 불가 오류는 즉시 던진다. onRetry(error, attempt) 로 알린다. */
export async function withRetry(fn, { tries = 8, baseMs = 3000, maxMs = 60_000, sleepFn = sleep, onRetry } = {}) {
  for (let a = 1; ; a++) {
    try { return await fn(); } catch (e) {
      if (a >= tries || !RETRYABLE.test(String(e?.message ?? e))) throw e;
      onRetry?.(e, a);
      await sleepFn(Math.min(maxMs, baseMs * 2 ** (a - 1)) * (0.75 + Math.random() * 0.5));
    }
  }
}

/** 동시 수 제한. limit 은 줄일 수 있다(429 를 만나면 shrink). */
export function createSemaphore(limit) {
  let active = 0;
  let lastShrink = 0;
  const waiting = [];
  const pump = () => { while (active < limit && waiting.length) { active++; waiting.shift()(); } };
  return {
    get limit() { return limit; },
    async run(fn) {
      await new Promise((res) => { waiting.push(res); pump(); });
      try { return await fn(); } finally { active--; pump(); }
    },
    /** 429 를 만나면 한 단계 줄인다(10초에 한 번만 — 한꺼번에 여러 건이 429 를 받아도 한 번만). */
    shrink(now = Date.now()) { if (limit > 1 && now - lastShrink > 10_000) { limit--; lastShrink = now; return true; } return false; },
  };
}

const is429 = (e) => /429|RATE_LIMITED/.test(String(e?.message ?? e));

function guard(fn, sem, log, label, retryOpts) {
  return (...args) => sem.run(() => withRetry(() => fn(...args), {
    ...retryOpts,
    onRetry: (e, a) => { if (is429(e) && sem.shrink()) log?.(`${label}: 429 → 동시 ${sem.limit} 로 줄임`); if (a >= 3) log?.(`${label}: 재시도 ${a}`); },
  }));
}

/** 공급자를 감싼다: 에이전트 API(search·deep·quick)는 동시 제한+재시도, 나머지(web·scholar)는 재시도만. 그 밖의 속성(name·meter·config)은 그대로. */
export function throttleProvider(provider, { search = 2, deep = 3, log, retryOpts } = {}) {
  const sems = { search: createSemaphore(search), quick: createSemaphore(search), deep: createSemaphore(deep) };
  const open = createSemaphore(1000);
  const wrapped = {};
  for (const k of ['search', 'quick', 'deep']) if (typeof provider[k] === 'function') wrapped[k] = guard(provider[k].bind(provider), sems[k], log, k, retryOpts);
  for (const k of ['web', 'scholar']) if (typeof provider[k] === 'function') wrapped[k] = guard(provider[k].bind(provider), open, log, k, retryOpts);
  return new Proxy(provider, { get: (t, p, r) => (Object.hasOwn(wrapped, p) ? wrapped[p] : Reflect.get(t, p, r)) });
}

/** 판사 모델(chat·messages)을 감싼다: 동시 제한+재시도. */
export function throttleModel(model, { concurrency = 4, log, retryOpts } = {}) {
  const sem = createSemaphore(concurrency);
  const wrapped = {};
  for (const k of ['chat', 'messages']) if (typeof model[k] === 'function') wrapped[k] = guard(model[k].bind(model), sem, log, `model.${k}`, retryOpts);
  return new Proxy(model, { get: (t, p, r) => (Object.hasOwn(wrapped, p) ? wrapped[p] : Reflect.get(t, p, r)) });
}

/** 검색 도구({name, search})를 감싼다: 재시도만. */
export function throttleTool(tool, { log, retryOpts } = {}) {
  const sem = createSemaphore(1000);
  return { ...tool, search: guard(tool.search.bind(tool), sem, log, 'tool.search', retryOpts) };
}
