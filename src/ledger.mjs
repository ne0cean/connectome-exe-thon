// 원장 → 에이전트별 평판. 원장(jsonl)의 영수증 중 서명·무결성이 유효한 것만 센다(위조·변조 줄은 rejected 로 따로 센다).
// 정확도 = 사후(outcome) 영수증의 확인 / (확인 + 반박). 확인불가는 분모에서 뺀다(검증소가 판단 못 한 것을 에이전트 탓으로 돌리지 않는다).
// 과정(process) 영수증은 결제 직전 게이트라 같은 거래에 여러 번 나올 수 있다 — 건수·정지 횟수에만 넣고 정확도에는 넣지 않는다(리뷰 43b5e7b M5).
// 같은 영수증(서명 대상 다이제스트가 같은 것)은 한 번만 센다. agent_id 는 자기 신고라 신원 증명은 아니다(README 한계).
// rep-v5(레인 r7 L-SR-3): 완료(done) 영수증은 반박이 나올 수 없는 규칙이라 정확도에 넣지 않는다 — 건수는 done 칸에 따로 센다(완료 보고로 가격 반박을 희석하지 못하게).
// rep-v4(리뷰 0e6acfa M-3·레인 L-SR-3·L-SH-1): 같은 주장에 반박이 한 번이라도 있으면 그 반박을 센다 — 재검증(확인·공급자 오류의 확인불가)으로 감점을 지우지 못하게.
// rep-v3(리뷰 94ef08a M-B): 같은 주장(request_nonce 를 뺀 주장 다이제스트)의 사후 영수증은 에이전트별 최신 1건만 센다 —
//   참인 줄 아는 주장을 반복 검증받아 정확도를 부풀리지 못하게. 집계는 Map 으로(agent_id '__proto__' 등이 집계를 깨지 않게).
import { existsSync, readFileSync } from 'node:fs';
import { verifyReceipt, receiptId, digestOf } from './receipt/receipt.mjs';

export const REPUTATION_RULE_VERSION = 'rep-v6';

const blank = () => ({ total: 0, confirmed: 0, refuted: 0, unverifiable: 0, stops: 0, outcome: { confirmed: 0, refuted: 0, unverifiable: 0 }, done: { confirmed: 0, unverifiable: 0 }, by_tier: new Map(), by_type: new Map() });
const RESULT_KEYS = ['confirmed', 'refuted', 'unverifiable'];

/** receipts → { agents: { [agent_id]: { total, confirmed, refuted, unverifiable, stops, outcome:{…}, accuracy, by_tier } }, rejected, duplicates, superseded } */
export function reputation(receipts, { trust, now = new Date(0) } = {}) {
  // now 기본값 = 1970: 만료된 과거 영수증도 이력으로는 센다(만료는 '지금 행동 허가'의 문제).
  let rejected = 0;
  let duplicates = 0;
  const seen = new Set();
  const kept = [];
  const latestOutcome = new Map(); // `${agent}\0${주장}` → 영수증
  for (const r of receipts) {
    if (!verifyReceipt(r, { trust, now }).valid || !RESULT_KEYS.includes(r.verdict?.result)) { rejected++; continue; }
    const rid = receiptId(r);
    if (seen.has(rid)) { duplicates++; continue; }
    seen.add(rid);
    if (r.phase !== 'outcome') { kept.push(r); continue; }
    const key = JSON.stringify([agentOf(r), r.subject?.claim_type, digestOf({ ...r.claim, request_nonce: undefined })]);
    const prev = latestOutcome.get(key);
    const bad = (x) => x.verdict.result === 'refuted';
    if (!prev || (bad(r) !== bad(prev) ? bad(r) : Date.parse(r.issued_at) >= Date.parse(prev.issued_at))) latestOutcome.set(key, r);
  }
  const superseded = seen.size - kept.length - latestOutcome.size;

  const agents = new Map();
  for (const r of [...kept, ...latestOutcome.values()]) {
    const id = agentOf(r);
    if (!agents.has(id)) agents.set(id, blank());
    const a = agents.get(id);
    // 완료 영수증은 done 칸에만 센다 — total·확인·반박·정지·등급별 수 어디에도 섞지 않는다(8차 L-SH-9 · 9차 L-SH-9: 합이 맞게)
    if (r.subject?.claim_type === 'done') { if (Object.hasOwn(a.done, r.verdict.result)) a.done[r.verdict.result]++; continue; }
    a.total++;
    {
      a[r.verdict.result]++;
      if (r.phase === 'outcome') {
        a.outcome[r.verdict.result]++;
        const t = String(r.subject?.claim_type ?? 'unknown');
        if (!a.by_type.has(t)) a.by_type.set(t, { confirmed: 0, refuted: 0, unverifiable: 0 });
        a.by_type.get(t)[r.verdict.result]++;
      }
    }
    if (r.verdict.decision === 'stop') a.stops++;
    a.by_tier.set(r.tier, (a.by_tier.get(r.tier) ?? 0) + 1);
  }
  const out = [];
  for (const [id, a] of agents) {
    const judged = a.outcome.confirmed + a.outcome.refuted;
    a.accuracy = judged ? Math.round((a.outcome.confirmed / judged) * 1000) / 1000 : null;
    // 주장 종류별 정확도(8차 적대 L2): 쉬운 사실 주장으로 가격 반박을 희석해도 가격 칸의 정확도는 그대로 보인다
    a.accuracy_by_type = Object.fromEntries([...a.by_type].map(([t, o]) => [t, o.confirmed + o.refuted ? Math.round((o.confirmed / (o.confirmed + o.refuted)) * 1000) / 1000 : null]));
    delete a.by_type;
    // Object.fromEntries 는 '__proto__' 도 자기 속성으로 만든다(프로토타입을 바꾸지 않음)
    out.push([id, { ...a, by_tier: Object.fromEntries(a.by_tier) }]);
  }
  return { rule: REPUTATION_RULE_VERSION, agents: Object.fromEntries(out), rejected, duplicates, superseded };
}
const agentOf = (r) => (typeof r.subject?.agent_id === 'string' ? r.subject.agent_id : 'anonymous');

/** jsonl 원장 읽기. 깨진 줄은 건너뛰고 rejected 에 더한다. */
export function readLedger(path) {
  if (!existsSync(path)) return { receipts: [], broken: 0 };
  const receipts = [];
  let broken = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { receipts.push(JSON.parse(line)); } catch { broken++; }
  }
  return { receipts, broken };
}
