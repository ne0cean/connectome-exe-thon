#!/usr/bin/env node
// 데모: 가상 에이전트들이 행동 직전 검증소를 부른다(과정 판정) → 결과 영수증(사후 판정) → 원장 평판 → API 사용 집계.
// 막 0 Liner MCP 로 조사하는 에이전트 · 막 1 가격(low·mid) · 막 2 사실·인용(mid) · 막 3 고위험 의료 주장(high 법정) · 막 4 평판 · 막 5 집계.
// 사실 주장 위험도는 의뢰자(이 데모의 운영자)가 정한다: policy claim_domain=general → 막 2 는 mid, 막 3 은 에이전트가 domain=medical 로 올려 법정.
// 시나리오는 가상. 공급자 기본 mock(오프라인), VERIFIER_PROVIDER=liner 면 실조회(건당 비용은 README).
import { rmSync } from 'node:fs';
import { createVerifier, loadDotEnv, fromRoot } from '../src/index.mjs';
import { UNIT_USD } from '../src/providers/meter.mjs';
import { createSearchTool, shop } from './agent.mjs';

loadDotEnv();
const ledgerPath = fromRoot('data/demo-ledger.jsonl');
rmSync(ledgerPath, { force: true }); // 데모 원장은 매번 새로(본 원장 data/ledger.jsonl 과 분리)
// authorizeProviders: 오프라인 시연에서도 허가 대조를 보여 주려고 mock 을 넣는다 — 기본값은 실조회(liner)만이다
const v = createVerifier({ ledgerPath, policy: { claim_domain: 'general' }, authorizeProviders: ['liner', 'mock'], onNotice: (m) => console.error(`[verifier] ${m}`) });
const before = v.provider.name === 'liner' ? (await v.provider.balance()).usd : null;

const HONEST = 'agent-honest';
const HASTY = 'agent-hasty';

console.log('\n━━ 막 0. 에이전트가 Liner MCP 로 직접 조사 → 검증소 게이트 ━━');
const tool = createSearchTool();
for (const style of ['careful', 'hasty']) {
  const found = await shop('에어팟 프로 3', { tool, style });
  if (!found) { console.log(`· ${style}: 가격을 찾지 못함`); continue; }
  const gate = await v.verifyPrice({ ...found, process: { tool_calls: found.tool_calls }, phase: 'process', agentId: `mcp-agent-${style}` });
  console.log(`· ${style} 에이전트(${tool.name}) 주장 ${found.claim.price_krw.toLocaleString('ko-KR')}원 @ ${found.claim.seller_url}\n  과정 판정  ${gate.summary}`);
}

console.log('\n━━ 막 1. 결제 직전: "최저가예요" ━━');
if (v.provider.name !== 'liner') console.log('  (오프라인 mock 표본 — 진행 시연을 위해 배송비·옵션가로 보이는 작은 값을 뺀 표본이다. 실데이터는 정지가 잦다: README 알려진 한계)');
const prices = [
  { title: '성실한 에이전트 — 두 곳 비교 후 진짜 최저가', agentId: HONEST, claim: { item: '에어팟 프로 3', price_krw: 287490, seller_url: 'https://compare-a.example/airpods-pro-3' }, visited: ['https://compare-a.example/airpods-pro-3', 'https://shop-b.example/ap3'] },
  { title: '서두르는 에이전트 — 한 곳만 보고 "최저가"', agentId: HASTY, claim: { item: '에어팟 프로 3', price_krw: 299000, seller_url: 'https://shop-b.example/ap3' }, visited: ['https://shop-b.example/ap3'] },
  { title: '비싼 물건(72만원) — mid 단계, 가격 근거가 약함', agentId: HONEST, claim: { item: '로봇청소기 R9', price_krw: 720000, seller_url: 'https://maker.example/r9' }, visited: ['https://compare-a.example/r9', 'https://maker.example/r9'] },
];
for (const [i, s] of prices.entries()) {
  s.claim.request_nonce = `demo-pay-${i + 1}`; // 결제 측이 이 결제 건에 준 1회용 값
  console.log(`\n· ${s.title}`);
  const tool_calls = s.visited.map((url) => ({ tool: 'browse', url }));
  const gate = await v.verifyPrice({ claim: s.claim, process: { tool_calls }, phase: 'process', agentId: s.agentId });
  console.log(`  과정 판정  ${gate.summary}`);
  if (gate.receipt.verdict.decision === 'proceed') {
    const done = await v.verifyPrice({ claim: s.claim, process: { tool_calls }, phase: 'outcome', agentId: s.agentId });
    console.log(`  사후 판정  ${done.summary}`);
    // 결제 측: 자기가 결제하려는 내용과 영수증을 대조한다 — 같은 영수증이라도 금액이 다른 결제는 허가하지 않는다.
    // 주의: 실제 통합에서는 이 값(pay)을 결제 측이 가진 주문서에서 가져와야 한다. 에이전트가 준 주장으로 만들면 대조가 순환이 된다(이 데모는 둘이 같은 값이라 여기서 만든다).
    const pay = { item: s.claim.item, price_krw: s.claim.price_krw, seller_url: s.claim.seller_url };
    const show = (c) => `authorizes=${c.authorizes}${c.not_authorized.length ? ` (${c.not_authorized.join(',')})` : ''}`;
    console.log(`  결제 허가  이 결제 건 ${show(v.checkReceipt(gate.receipt, { expectedNonce: s.claim.request_nonce, expected: pay }))} · 금액이 다른 결제 ${show(v.checkReceipt(gate.receipt, { expectedNonce: s.claim.request_nonce, expected: { ...pay, price_krw: 3490000 } }))}`);
  } else console.log('  → 결제 보류, 사람에게 넘김');
}

console.log('\n━━ 막 2. 보고서 발송 직전: "사실이에요" (운영자 정책 claim_domain=general → mid) ━━');
for (const [agentId, statement, citation] of [
  [HONEST, '에펠탑은 1889년에 완공되었다', false],
  [HASTY, '만리장성은 우주에서 맨눈으로 보인다', false],
  [HONEST, '트랜스포머 아키텍처는 2017년 Attention Is All You Need 논문에서 제안되었다', true],
]) {
  const out = await v.verifyClaim({ statement, citation, agentId });
  console.log(`· ${statement}\n  ${out.summary}`);
}

console.log('\n━━ 막 3. 고위험: 에이전트가 domain=medical 로 올림 → 법정 (검사·변호 Deep Research → 두 계열 판사) ━━');
const court = await v.verifyClaim({ statement: '성인의 아세트아미노펜 1일 최대 권장 용량은 4g 이다', domain: 'medical', agentId: HONEST });
console.log(`· ${court.summary}`);
for (const j of court.receipt.method.judges) console.log(`  판사 ${j.family.padEnd(6)} ${String(j.model).padEnd(18)} ${j.verdict ?? j.error}  ${j.reason_codes.slice(0, 2).join(' · ')}`);

console.log('\n━━ 막 4. 원장 → 에이전트 평판 (서명 유효 영수증만) ━━');
const rep = v.reputation();
for (const [id, a] of Object.entries(rep.agents)) console.log(`  ${id.padEnd(14)} 영수증 ${a.total} · 확인 ${a.confirmed} · 반박 ${a.refuted} · 확인불가 ${a.unverifiable} · 정지 ${a.stops} · 정확도 ${a.accuracy ?? '-'}${a.done.confirmed + a.done.unverifiable ? ` · 완료 주장(별도) 확인 ${a.done.confirmed} · 확인불가 ${a.done.unverifiable}` : ''}`);

const u = v.usage();
console.log(`\n━━ 막 5. Liner API 사용 집계 (공급자: ${v.provider.name}) ━━`);
for (const [api, n] of Object.entries(u.calls)) {
  const unit = UNIT_USD[api];
  console.log(`  ${api.padEnd(16)} ${String(n).padStart(3)}회 ${unit === undefined ? '× 토큰 과금(잔액 차액에 포함)' : `× $${unit} = $${(n * unit).toFixed(4)}`}`);
}
console.log(`  단가 합계 $${u.usd}`);
if (before !== null) console.log(`  실측(잔액 차액) $${(before - (await v.provider.balance()).usd).toFixed(4)}`);
