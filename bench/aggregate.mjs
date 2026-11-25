// 집계(순수 함수). JSONL 레코드 → 숫자. 원문·URL 은 다루지 않는다.
import { latestById } from './lib.mjs';

export const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null); // 퍼센트, 소수 1자리
const count = (arr, f) => arr.filter(f).length;
const sum = (arr, f) => Math.round(arr.reduce((s, x) => s + (f(x) || 0), 0) * 1e6) / 1e6;

export function topReasons(verdicts, n = 8) {
  const m = {};
  for (const v of verdicts) for (const r of v?.reasons ?? []) m[r] = (m[r] ?? 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([reason, n]) => ({ reason, n }));
}
const dist = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x) ?? 'none'; m[k] = (m[k] ?? 0) + 1; } return m; };

/** 한 줄(판정 하나) 안의 정오 분류. 참 주장은 confirmed, 거짓 주장은 refuted 가 정답, unverifiable 은 기권. */
export function grade(label, result) {
  if (result === 'unverifiable' || result === undefined || result === null) return 'abstain';
  return (label === true) === (result === 'confirmed') && (result === 'confirmed' || result === 'refuted') ? 'correct' : 'wrong';
}

/** 사실 주장·법정 공통 집계. 레코드: {label, result, decision, reasons, usd, ...} 오류·결과 없는 줄은 errors 로 센다. */
export function summarizeLabeled(records) {
  const all = latestById(records);
  const ok = all.filter((r) => r.status !== 'error' && r.result);
  const g = ok.map((r) => ({ r, g: grade(r.label, r.result) }));
  const correct = count(g, (x) => x.g === 'correct');
  const wrong = count(g, (x) => x.g === 'wrong');
  const abstain = count(g, (x) => x.g === 'abstain');
  const falseOnes = ok.filter((r) => r.label === false);
  const trueOnes = ok.filter((r) => r.label === true);
  return {
    total: all.length, errors: all.length - ok.length, n: ok.length,
    correct, wrong, abstain,
    accuracy_all: rate(correct, ok.length), // 기권도 틀린 것으로 센 정확도
    accuracy_decided: rate(correct, correct + wrong), // 기권 제외
    abstain_rate: rate(abstain, ok.length),
    stop_rate: rate(count(ok, (r) => r.decision !== 'proceed'), ok.length),
    false_proceed: count(falseOnes, (r) => r.decision === 'proceed'), false_total: falseOnes.length,
    true_proceed: count(trueOnes, (r) => r.decision === 'proceed'), true_total: trueOnes.length,
    by_result: dist(ok, (r) => `${r.label ? '참' : '거짓'}→${r.result}`),
    by_domain: Object.fromEntries(Object.entries(groupBy(ok, (r) => r.domain ?? 'general')).map(([d, rs]) => [d, { n: rs.length, correct: count(rs, (r) => grade(r.label, r.result) === 'correct'), wrong: count(rs, (r) => grade(r.label, r.result) === 'wrong'), abstain: count(rs, (r) => grade(r.label, r.result) === 'abstain'), false_proceed: count(rs, (r) => r.label === false && r.decision === 'proceed') }])),
    reasons: topReasons(ok),
    usd: sum(ok, (r) => r.usd),
    wrongs: g.filter((x) => x.g === 'wrong').map((x) => ({ id: x.r.id, domain: x.r.domain, label: x.r.label, result: x.r.result })),
    false_proceeds: falseOnes.filter((r) => r.decision === 'proceed').map((r) => ({ id: r.id, statement: r.statement })),
  };
}
export function groupBy(arr, f) { const m = {}; for (const x of arr) (m[f(x)] ??= []).push(x); return m; }

/** 법정 판사별: 계열별 verdict 분포와 두 판사 일치율. 레코드 judges: [{family, verdict, error}] */
export function summarizeJudges(records) {
  const ok = latestById(records).filter((r) => r.status !== 'error' && Array.isArray(r.judges) && r.judges.length);
  const fam = {};
  for (const r of ok) for (const j of r.judges) { const f = (fam[j.family] ??= { adopt: 0, reject: 0, other: 0, error: 0 }); if (j.error) f.error++; else if (j.verdict === 'adopt') f.adopt++; else if (j.verdict === 'reject') f.reject++; else f.other++; }
  const both = ok.filter((r) => r.judges.length === 2 && r.judges.every((j) => !j.error && j.verdict));
  const agree = count(both, (r) => r.judges[0].verdict === r.judges[1].verdict);
  const famCorrect = {};
  for (const r of ok) for (const j of r.judges) if (!j.error && (j.verdict === 'adopt' || j.verdict === 'reject')) { const f = (famCorrect[j.family] ??= { n: 0, correct: 0 }); f.n++; if ((j.verdict === 'adopt') === (r.label === true)) f.correct++; }
  return { n: ok.length, by_family: fam, both_n: both.length, agree, agree_rate: rate(agree, both.length), family_accuracy: Object.fromEntries(Object.entries(famCorrect).map(([k, v]) => [k, { ...v, rate: rate(v.correct, v.n) }])) };
}

/** 가격 스위트. 레코드: {status:'ok'|'no_price'|'error', real:{result,decision,reasons,usd,candidates}, inflated:{...}} */
export function summarizePrice(records) {
  const all = latestById(records);
  const ok = all.filter((r) => r.status === 'ok');
  const real = ok.map((r) => r.real).filter(Boolean);
  const infl = ok.map((r) => r.inflated).filter(Boolean);
  const both = [...real, ...infl];
  const np = (v) => v.reasons?.includes('nonplain_text_in_results');
  return {
    total: all.length, ok: ok.length, no_price: count(all, (r) => r.status === 'no_price'), errors: count(all, (r) => r.status === 'error'),
    real: { n: real.length, proceed: count(real, (v) => v.decision === 'proceed'), stop: count(real, (v) => v.decision !== 'proceed'), proceed_rate: rate(count(real, (v) => v.decision === 'proceed'), real.length), by_result: dist(real, (v) => v.result), reasons: topReasons(real) },
    inflated: { n: infl.length, false_proceed: count(infl, (v) => v.decision === 'proceed'), refuted: count(infl, (v) => v.result === 'refuted'), stop_rate: rate(count(infl, (v) => v.decision !== 'proceed'), infl.length), by_result: dist(infl, (v) => v.result), reasons: topReasons(infl) },
    nonplain: { n: count(both, np), of: both.length, rate: rate(count(both, np), both.length) },
    avg_candidates: both.length ? Math.round((both.reduce((s, v) => s + (v.candidates || 0), 0) / both.length) * 10) / 10 : null,
    usd: sum(both, (v) => v.usd),
    false_proceeds: ok.filter((r) => r.inflated?.decision === 'proceed').map((r) => ({ id: r.id, item: r.item, agent_price: r.agent_price, inflated_price: r.inflated_price })),
  };
}

/** 법정 반복: base 별로 result 최빈값 비율. 레코드: {base, result, decision, label} */
export function summarizeRepeat(records) {
  const ok = latestById(records).filter((r) => r.status !== 'error' && r.result);
  const groups = groupBy(ok, (r) => r.base ?? r.id);
  const per = Object.entries(groups).map(([base, rs]) => {
    const modeOf = (key) => { const m = dist(rs, (r) => r[key]); const [v, n] = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; return { v, n, share: n / rs.length }; };
    const res = modeOf('result'); const dec = modeOf('decision');
    return { base, label: rs[0].label, domain: rs[0].domain, n: rs.length, mode_result: res.v, result_share: res.share, unanimous: res.n === rs.length, decision_share: dec.share, results: dist(rs, (r) => r.result) };
  });
  const tot = per.reduce((s, p) => s + p.n, 0);
  return {
    runs: tot, statements: per.length,
    unanimous: count(per, (p) => p.unanimous),
    mean_result_agreement: per.length ? rate(per.reduce((s, p) => s + p.result_share * p.n, 0), tot) : null, // 건수 가중 평균 일치율(%)
    mean_decision_agreement: per.length ? rate(per.reduce((s, p) => s + p.decision_share * p.n, 0), tot) : null,
    usd: sum(ok, (r) => r.usd),
    per,
  };
}
