#!/usr/bin/env node
// 성적표: 증거 폴더의 JSONL 을 읽어 verifier/docs/BENCH.md 를 쓴다. 집계와 주장 문장 예시만 싣는다 — 검색 원문·영수증·URL 은 싣지 않는다.
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl, latestById } from './lib.mjs';
import { summarizePrice, summarizeLabeled, summarizeJudges, summarizeRepeat } from './aggregate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(resolve(HERE, '..', '..'), '.context', 'evidence', 'bench');
const OUT = join(HERE, '..', 'docs', 'BENCH.md');

const pct = (x) => (x === null || x === undefined ? '-' : `${x}%`);
const usd = (x) => `$${Number(x).toFixed(2)}`;
const top = (list) => list.map((r) => `${r.reason} ${r.n}`).join(' · ') || '-';
const distStr = (d) => Object.entries(d).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '-';

/** 잔액 기록(balance.jsonl)에서 처음·마지막 잔액. 여러 스위트가 겹쳐 돌아도 전체 소진액은 이 차이다. */
export function balanceSpan(records) {
  const r = records.filter((x) => typeof x.usd === 'number').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return r.length ? { first: r[0].usd, last: r[r.length - 1].usd, firstTs: r[0].ts, lastTs: r[r.length - 1].ts } : null;
}

export function render({ price, claim, court, judges, repeat, balance, perSuiteUsd }) {
  const L = [];
  L.push('# 검증소 벤치 성적표', '', '실제 Liner API 로 대량 측정한 집계다(판정 규칙: price-v9 · claim-v4 · court-v4). 입력 목록은 `bench/data/`, 러너는 `bench/run.mjs`, 이 문서는 `bench/report.mjs` 가 만든다. 검색 원문·영수증 전문은 공개 사본에 넣지 않는다(비공개 증거 폴더에만 있다).', '');
  L.push('읽는 법: 판정은 `confirmed`(확인)·`refuted`(반박)·`unverifiable`(확인불가) 셋이고, 진행(proceed)은 확인 중에서도 규칙을 다 통과한 것만이다. 참 주장은 confirmed, 거짓 주장은 refuted 가 정답이며 unverifiable 은 기권(틀림도 맞음도 아님)으로 센다. **정지율이 높은 것은 설계 선택이다** — 거짓 진행 0 을 우선한다.', '');
  if (balance) L.push(`## 실비`, '', `- 잔액 ${usd(balance.first)} → ${usd(balance.last)}: **실제 소진 ${usd(balance.first - balance.last)}** (잔액 차액, 모델 호출 토큰비 포함).`, `- 스위트별 영수증 단가 합(미터, 토큰비 제외): ${Object.entries(perSuiteUsd).map(([k, v]) => `${k} ${usd(v)}`).join(' · ')}`, '');

  if (price?.total) {
    L.push('## 1. 가격 (low/mid, process 단계)', '');
    L.push(`상품 ${price.total}개 중 에이전트가 가격을 찾아 주장한 것 ${price.ok}개(가격을 못 찾음 ${price.no_price}, 측정 실패 ${price.errors}). 각 상품마다 ①에이전트가 조사한 가격 ②그 가격에 15%를 얹은 부풀린 가격을 검증소에 냈다.`, '');
    L.push('| 구분 | 건수 | 진행 | 정지 | 진행률 | 판정 분포 |', '|---|---|---|---|---|---|');
    L.push(`| 조사한 가격 | ${price.real.n} | ${price.real.proceed} | ${price.real.stop} | ${pct(price.real.proceed_rate)} | ${distStr(price.real.by_result)} |`);
    L.push(`| 15% 부풀린 가격 | ${price.inflated.n} | ${price.inflated.false_proceed} | ${price.inflated.n - price.inflated.false_proceed} | ${pct(rateOf(price.inflated.false_proceed, price.inflated.n))} | ${distStr(price.inflated.by_result)} |`, '');
    L.push(`- **거짓 진행(부풀린 주장이 통과): ${price.inflated.false_proceed}건 / ${price.inflated.n}건.** 부풀린 주장 정지율 ${pct(price.inflated.stop_rate)}, 그중 반박(refuted) ${price.inflated.refuted}건.`);
    L.push(`- 허용 글자 규칙(price-v9)에 걸려 확인을 포기한 비율: ${pct(price.nonplain.rate)} (${price.nonplain.n} / ${price.nonplain.of} 판정).`);
    L.push(`- 판정당 사람 확인 후보 평균 ${price.avg_candidates ?? '-'}곳 · 영수증 단가 합 ${usd(price.usd)}`);
    L.push(`- 조사한 가격의 사유 상위: ${top(price.real.reasons)}`);
    L.push(`- 부풀린 가격의 사유 상위: ${top(price.inflated.reasons)}`);
    if (price.false_proceeds.length) L.push('', '거짓 진행 입력(상품명·주장가·부풀린 가격):', ...price.false_proceeds.slice(0, 20).map((f) => `- ${f.item}: 에이전트 ${f.agent_price?.toLocaleString('ko-KR')}원 → 부풀림 ${f.inflated_price?.toLocaleString('ko-KR')}원`));
    L.push('');
  }

  const labeled = (title, s, extra) => {
    if (!s?.total) return;
    L.push(title, '');
    L.push(`${s.n}건 판정(측정 실패 ${s.errors}건 제외). 맞음 ${s.correct} · 틀림 ${s.wrong} · 기권(확인불가) ${s.abstain}.`, '');
    L.push('| 지표 | 값 |', '|---|---|');
    L.push(`| 정확도(기권을 틀림으로 침) | ${pct(s.accuracy_all)} |`, `| 정확도(기권 제외) | ${pct(s.accuracy_decided)} |`, `| 기권률 | ${pct(s.abstain_rate)} |`, `| 정지율 | ${pct(s.stop_rate)} |`);
    L.push(`| 거짓 주장이 진행된 건 | ${s.false_proceed} / ${s.false_total} |`, `| 참 주장이 진행된 건 | ${s.true_proceed} / ${s.true_total} |`, `| 영수증 단가 합 | ${usd(s.usd)} |`, '');
    L.push(`- 라벨→판정 분포: ${distStr(s.by_result)}`);
    L.push(`- 사유 상위: ${top(s.reasons)}`);
    const dm = Object.entries(s.by_domain);
    if (dm.length > 1) L.push('', '| 분야 | 건수 | 맞음 | 틀림 | 기권 | 거짓 진행 |', '|---|---|---|---|---|---|', ...dm.map(([d, x]) => `| ${d} | ${x.n} | ${x.correct} | ${x.wrong} | ${x.abstain} | ${x.false_proceed} |`));
    if (s.false_proceeds.length) L.push('', '거짓인데 진행된 주장:', ...s.false_proceeds.slice(0, 10).map((f) => `- ${f.statement}`));
    if (extra) L.push(...extra);
    L.push('');
  };
  labeled('## 2. 사실 주장 (mid, 일반 상식)', claim);
  labeled('## 3. 고위험 주장 (high 법정: 검사·변호 Deep Research + 판사 2계열)', court, judges?.n ? ['', `판사 계열별(채택/기각/불충분/오류): ${Object.entries(judges.by_family).map(([f, x]) => `${f} ${x.adopt}/${x.reject}/${x.other}/${x.error}`).join(' · ')} · 두 판사가 모두 판결한 ${judges.both_n}건 중 일치 ${judges.agree}건(${pct(judges.agree_rate)})`, `계열별 정확도(채택·기각만, 불충분 제외): ${Object.entries(judges.family_accuracy).map(([f, x]) => `${f} ${x.correct}/${x.n}(${pct(x.rate)})`).join(' · ')}`] : undefined);

  if (repeat?.runs) {
    L.push('## 4. 법정 반복 (같은 주장 여러 번 — 판정 흔들림)', '');
    L.push(`주장 ${repeat.statements}개 × 반복 = ${repeat.runs}회. 모든 반복이 같은 판정인 주장 ${repeat.unanimous} / ${repeat.statements}. **판정 일치율(건수 가중) ${pct(repeat.mean_result_agreement)}**, 진행/정지 일치율 ${pct(repeat.mean_decision_agreement)}. 영수증 단가 합 ${usd(repeat.usd)}.`, '');
    L.push('| 주장(라벨·분야) | 반복 | 판정 분포 | 최빈 일치 |', '|---|---|---|---|', ...repeat.per.map((p) => `| ${p.base} (${p.label ? '참' : '거짓'}·${p.domain}) | ${p.n} | ${distStr(p.results)} | ${pct(Math.round(p.result_share * 1000) / 10)} |`), '');
  }
  L.push('## 한계', '', '- 입력 목록은 이 레포가 직접 쓴 상식 기반 표본이다(외부 벤치마크가 아니다). 사실 주장·고위험 주장은 널리 합의된 사실 기준이며 라벨은 작성자(AI) 판단이다.', '- 가격 스위트의 "거짓 진행"은 부풀린 가격만 센다. 진짜 최저가를 정답으로 잡은 정답지는 없다(조사한 가격이 맞는지는 이 표로 알 수 없다).', '- Liner 가 429(속도 제한)를 돌려주면 러너가 물러났다 다시 부른다. 재시도 뒤에도 조사·판사 호출이 실패한 건은 측정이 아니라 "측정 실패"로 따로 센다.', '');
  return L.join('\n');
}
const rateOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function main() {
  const rd = (s) => readJsonl(join(EVIDENCE, `${s}.jsonl`));
  const claimR = rd('claim'); const courtR = rd('court'); const repR = rd('court-repeat'); const priceR = rd('price');
  const sumUsd = (rs) => Math.round(latestById(rs).filter((r) => r.status !== 'error').reduce((s, r) => s + (r.usd ?? (r.real ? r.real.usd + r.inflated.usd : 0)), 0) * 1e4) / 1e4;
  const md = render({
    price: summarizePrice(priceR), claim: summarizeLabeled(claimR), court: summarizeLabeled(courtR), judges: summarizeJudges(courtR), repeat: summarizeRepeat(repR),
    balance: balanceSpan(readJsonl(join(EVIDENCE, 'balance.jsonl'))),
    perSuiteUsd: { price: sumUsd(priceR), claim: sumUsd(claimR), court: sumUsd(courtR), 'court-repeat': sumUsd(repR) },
  });
  writeFileSync(OUT, md);
  console.log(`쓴 파일: ${OUT} (${md.length}자)`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
