// API 별 호출 수·비용 집계. 영수증 cost 필드와 데모 마지막 장면 집계표의 원천.
// 단가는 Liner 공개 요금(2026-11 기준, a-team liner-research.mjs 실측 주석과 대조). 실측값은 balance 차액으로 따로 잰다.
export const UNIT_USD = {
  'search.web': 0.001,
  'search.scholar': 0.0003,
  'agent.quick': 0.003,
  'agent.search': 0.02,
  'agent.deep': 0.2,
};

export function createMeter() {
  const calls = {};
  let usd = 0;
  return {
    record(api, costUsd = UNIT_USD[api] ?? 0) {
      calls[api] = (calls[api] ?? 0) + 1;
      usd += costUsd;
    },
    snapshot: () => ({ calls: { ...calls }, usd: Math.round(usd * 1e6) / 1e6 }),
    /** 두 snapshot 차이 = 한 번의 검증에 든 호출·비용 */
    since(prev) {
      const now = this.snapshot();
      const d = {};
      for (const [k, v] of Object.entries(now.calls)) if (v - (prev.calls[k] ?? 0)) d[k] = v - (prev.calls[k] ?? 0);
      return { calls: d, usd: Math.round((now.usd - prev.usd) * 1e6) / 1e6 };
    },
  };
}
