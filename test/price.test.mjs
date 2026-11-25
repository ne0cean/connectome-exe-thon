import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider } from '../src/providers/mock.mjs';
import { generateSigner, makeTrustList } from '../src/receipt/keys.mjs';
import { verifyReceipt } from '../src/receipt/receipt.mjs';
import { verifyPrice } from '../src/verify/price.mjs';
import { observe } from '../src/verify/extract.mjs';
import { createMeter } from '../src/providers/meter.mjs';

const SELLER = 'https://compare-a.example/airpods-pro-3';

const signer = generateSigner();
const trust = makeTrustList([signer]);
const visited2 = { tool_calls: [{ tool: 'browse', url: 'https://compare-a.example/airpods-pro-3' }, { tool: 'browse', url: 'https://shop-b.example/ap3' }] };
const run = (input) => verifyPrice(input, { provider: createMockProvider(), signer });

test('과정 판정: 진짜 최저가 + 판매처 2곳 비교 → 확인·진행, 영수증 유효', async () => {
  const { receipt } = await run({ claim: { item: '에어팟 프로 3', price_krw: 287490, seller_url: 'https://compare-a.example/airpods-pro-3' }, process: visited2, phase: 'process', agentId: 'shop-agent' });
  assert.equal(receipt.verdict.result, 'confirmed');
  assert.equal(receipt.verdict.decision, 'proceed');
  assert.equal(receipt.tier, 'low');
  assert.deepEqual(receipt.cost.calls, { 'search.web': 1 });
  assert.equal(receipt.cost.usd, 0.001);
  assert.equal(verifyReceipt(receipt, { trust }).valid, true);
});

test('과정 판정: 더 싼 곳이 있으면 반박·정지 + 더 나은 값 제시', async () => {
  const { receipt, summary } = await run({ claim: { item: '에어팟 프로 3', price_krw: 299000, seller_url: 'https://shop-b.example/ap3' }, process: visited2 });
  assert.equal(receipt.verdict.result, 'refuted');
  assert.equal(receipt.verdict.decision, 'stop');
  assert.deepEqual(receipt.verdict.better_offer, { price_krw: 287490, url: 'https://compare-a.example/airpods-pro-3' });
  assert.match(summary, /반박 → 정지/);
});

test('과정 판정: 가격은 맞아도 판매처 1곳만 봤으면 정지(single_source_lookup)', async () => {
  const { receipt } = await run({ claim: { item: '에어팟 프로 3', price_krw: 287490 }, process: { tool_calls: [{ tool: 'browse', url: 'https://compare-a.example/airpods-pro-3' }] } });
  assert.equal(receipt.verdict.result, 'confirmed');
  assert.equal(receipt.verdict.decision, 'stop');
  assert.ok(receipt.verdict.reasons.includes('single_source_lookup'));
});

test('과정 판정: 주장한 판매처를 기록에서 안 봤으면 seller_not_in_log', async () => {
  const { receipt } = await run({ claim: { item: '에어팟 프로 3', price_krw: 287490, seller_url: 'https://never-visited.example/x' }, process: visited2 });
  assert.ok(receipt.verdict.reasons.includes('seller_not_in_log'));
  assert.equal(receipt.verdict.decision, 'stop');
});

test('과정 판정: 작업 기록이 없으면 정지(no_process_log)', async () => {
  const { receipt } = await run({ claim: { item: '에어팟 프로 3', price_krw: 287490 } });
  assert.equal(receipt.verdict.decision, 'stop');
  assert.ok(receipt.verdict.reasons.includes('no_process_log'));
});

test('관측된 적 없는 싼 주장가 → 확인불가(claim_price_not_observed), quick 보강 시도', async () => {
  const { receipt } = await run({ claim: { item: '에어팟 프로 3', price_krw: 150000, seller_url: SELLER }, process: visited2 });
  assert.equal(receipt.verdict.result, 'unverifiable');
  assert.ok(receipt.verdict.reasons.includes('claim_price_not_observed'));
  assert.equal(receipt.cost.calls['agent.quick'], 1);
});

test('web 에 가격이 없으면 quick 으로 보강 — LLM 답의 표시 없는 싼 값은 반박이 아니라 확인불가', async () => {
  const { receipt } = await run({ claim: { item: '로봇청소기 R9', price_krw: 720000 }, phase: 'outcome' });
  assert.equal(receipt.verdict.result, 'unverifiable');
  assert.ok(receipt.verdict.reasons.includes('unanchored_cheaper_seen'));
  assert.deepEqual(receipt.cost.calls, { 'search.web': 1, 'agent.quick': 1 });
  assert.equal(receipt.verdict.decision, undefined);
  assert.equal(receipt.tier, 'mid');
  // LLM 답 가격의 출처 URL 은 비우고, 참조 목록은 따로 담는다
  const q = receipt.evidence.find((e) => e.api === 'agent.quick');
  assert.equal(q.url, null);
  assert.ok(receipt.evidence.some((e) => Array.isArray(e.references)));
});

// ── 리뷰 0acda85 HIGH 1~4 재현: 모두 proceed 가 나오면 안 된다 ──
const fixed = (webResults, quickAnswer = '') => ({
  name: 'fake', meter: createMeter(),
  hits: 0,
  async web() { this.hits++; return { results: webResults }; },
  quick: async () => ({ answer: quickAnswer, references: [] }),
});
const gate = (provider, claim, extra = {}) => verifyPrice({ claim: { seller_url: 'https://a.example/p', ...claim }, process: { tool_calls: [{ url: 'https://a.example/p' }, { url: 'https://b.example/q' }] }, phase: 'process', ...extra }, { provider, signer });

test('H1: 범위 하한 아래 "최저" 값은 버려지지 않고 정지시킨다', async () => {
  const { receipt } = await gate(fixed([{ url: 'https://a.example/p', description: '최저 90,000원 · 정가 210,000원' }, { url: 'https://b.example/q', description: '200,000원' }]), { item: 'W', price_krw: 200000 });
  assert.equal(receipt.verdict.decision, 'stop');
  assert.ok(receipt.verdict.reasons.includes('anchored_price_far_below_claim'));
});

test('H2: 판매자가 붙인 "최저가" 표시가 표시 없는 더 싼 값을 가리지 못한다', async () => {
  const { receipt } = await gate(fixed([{ url: 'https://a.example/p', description: '최저가 299,000원' }, { url: 'https://b.example/q', description: '259,000원 로켓배송' }]), { item: 'W', price_krw: 299000 });
  assert.equal(receipt.verdict.decision, 'stop');
  assert.ok(receipt.verdict.reasons.includes('unanchored_cheaper_seen'));
});

test('H3: 관측 1곳·주장가 미관측은 확인 불가', async () => {
  const one = await gate(fixed([{ url: 'https://a.example/p', description: '정가 529,000원' }]), { item: 'W', price_krw: 450000 });
  assert.equal(one.receipt.verdict.decision, 'stop');
  const between = await gate(fixed([{ url: 'https://a.example/p', description: '최저 287,490원' }, { url: 'https://b.example/q', description: '299,000원' }]), { item: 'W', price_krw: 235000 });
  assert.equal(between.receipt.verdict.decision, 'stop');
  assert.ok(between.receipt.verdict.reasons.includes('claim_price_not_observed'));
  const single = await gate(fixed([{ url: 'https://a.example/p', description: '최저 287,490원' }]), { item: 'W', price_krw: 287490 });
  assert.ok(single.receipt.verdict.reasons.includes('insufficient_sources'));
});

test('H4·94ef08a H-G: high 단계는 법정 구현 전까지 과정은 정지, 사후도 확인불가(평판에 법정 없이 들어가지 않음)', async () => {
  const p = () => fixed([{ url: 'https://a.example/p', description: '최저 5,000,000원' }, { url: 'https://b.example/q', description: '5,000,000원' }]);
  const { receipt } = await gate(p(), { item: 'W', price_krw: 5_000_000 }, { tierCtx: { reversible: false } });
  assert.equal(receipt.tier, 'high');
  assert.deepEqual([receipt.verdict.result, receipt.verdict.decision], ['unverifiable', 'stop']);
  assert.ok(receipt.verdict.reasons.includes('high_tier_not_implemented'));
  const out = await gate(p(), { item: 'W', price_krw: 5_000_000 }, { phase: 'outcome' });
  assert.deepEqual([out.receipt.tier, out.receipt.verdict.result, out.receipt.verdict.decision], ['high', 'unverifiable', undefined]);
  assert.ok(out.receipt.verdict.reasons.includes('high_tier_not_implemented'));
  // 더 싼 값이 있어도 high 사후는 반박(평판 감점)으로 가지 않는다
  const cheap = await gate(fixed([{ url: 'https://a.example/p', description: '최저 4,000,000원' }]), { item: 'W', price_krw: 5_000_000 }, { phase: 'outcome' });
  assert.deepEqual([cheap.receipt.verdict.result, cheap.receipt.verdict.better_offer], ['unverifiable', undefined]);
});

test('긍정 증거가 다 있으면 low 에서 web 1회로 진행', async () => {
  const { receipt } = await gate(fixed([{ url: 'https://a.example/p', description: '최저 287,490원' }, { url: 'https://b.example/q', description: '287,490원' }]), { item: 'W', price_krw: 287490 });
  assert.equal(receipt.verdict.decision, 'proceed');
  assert.deepEqual(receipt.cost.calls, { 'search.web': 1 });
});

test('price-v4: 실데이터 다나와 요약문의 카드가·작은 값, 블로그 차액·근사값도 더 싸면 정지(정지 비용 수용)', async () => {
  const danawa = '에어팟 프로3 MFHP4KH/A (정품) 4,000원 최저287,490원 가격비교 211 최저가 … 할인 전 가격 287,500원 할인율 4% 가격 275,750원 최대 11,750원';
  const { receipt } = await gate(fixed([{ url: 'https://a.example/p', description: danawa }, { url: 'https://b.example/q', description: '287,490원' }]), { item: 'W', price_krw: 287490 });
  assert.deepEqual([receipt.verdict.result, receipt.verdict.decision], ['unverifiable', 'stop']);
  assert.ok(receipt.evidence.some((e) => e.value_krw === 275750 && e.marks.includes('conditional')));
  const blog = '에어팟 5세대 기본 모델은 19만 원대, 에어팟 프로3는 35만 원대로 가격 차이가 15만 원 이상 나는데요.';
  const withBlog = await gate(fixed([{ url: 'https://a.example/p', description: '최저 287,490원' }, { url: 'https://b.example/q', description: '287,490원' }, { url: 'https://c.example/b', description: blog }]), { item: 'W', price_krw: 287490 });
  assert.deepEqual([withBlog.receipt.verdict.decision, withBlog.receipt.verdict.reasons[0]], ['stop', 'marked_cheaper_seen']);
  // 조건 문맥 없이 같은 결과 안에 섞인 더 싼 값은 여전히 막는다(H2 같은 결과 변형)
  const mixed = await gate(fixed([{ url: 'https://a.example/p', description: '최저가 299,000원 · 259,000원 로켓배송' }, { url: 'https://b.example/q', description: '299,000원' }]), { item: 'W', price_krw: 299000 });
  assert.equal(mixed.receipt.verdict.decision, 'stop');
});

test('리뷰 86d4f1d N1: 조건부·혜택 문맥의 더 싼 실판매가는 진행을 열지 않는다', async () => {
  const base = [{ url: 'https://a.example/p', description: '299,000원' }, { url: 'https://b.example/q', description: '299,000원' }];
  for (const third of [
    '카드결제 가능 G마켓 259,000원', '오늘만 할인 259,000원', '할인가 259,000원 무료배송', '쿠폰 없이도 259,000원', '회원가 259,000원',
    '적립금 사용 안해도 259,000원', '청구할인 없이 259,000원', 'G마켓 259,000원 이상 구매시 사은품', 'G마켓 259,000원 더 싸요',
    'G마켓 259,000원 싸게 팝니다', '회원가입 없이 구매 259,000원', '정가 299,000원 할인가 270,000원', '판매가 300,000원 쿠폰적용가 255,000원',
  ]) {
    const { receipt } = await gate(fixed([...base, { url: 'https://c.example/r', description: third }]), { item: 'W', price_krw: 299000 });
    assert.equal(receipt.verdict.decision, 'stop', third);
  }
  // 제목·설명을 이어 붙이지 않는다: 제목의 '할인' 이 설명의 실판매가를 조건부로 만들지 않음 → 더 싼 표시 없는 값으로 정지
  const t = await gate(fixed([...base, { url: 'https://c.example/r', title: '블프 할인', description: '259,000원' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual([t.receipt.verdict.decision, t.receipt.verdict.reasons[0]], ['stop', 'unanchored_cheaper_seen']);
});

test('리뷰 86d4f1d N2~N5·N10: 판매처 URL 형식·0.3~0.5배 값·LLM 출처·주장가 관측 출처·null 작업 기록', async () => {
  const two = [{ url: 'https://a.example/p', description: '299,000원' }, { url: 'https://b.example/q', description: '299,000원' }];
  const bad = await gate(fixed(two), { item: 'W', price_krw: 299000, seller_url: 'not a url' });
  assert.ok(bad.receipt.verdict.reasons.includes('invalid_seller_url'));
  assert.equal(bad.receipt.verdict.decision, 'stop');
  const n3 = await gate(fixed([...two, { url: 'https://c.example/r', description: '공식 판매처 140,000원' }]), { item: 'W', price_krw: 299000 });
  assert.equal(n3.receipt.verdict.decision, 'stop');
  const n4 = await gate({ ...fixed([{ url: 'https://a.example/p', description: '299,000원' }]), quick: async () => ({ answer: '현재 최저가는 299,000원', references: [] }) }, { item: 'W', price_krw: 299000 });
  assert.deepEqual([n4.receipt.verdict.decision, n4.receipt.verdict.reasons[0]], ['stop', 'insufficient_sources']);
  const n5 = await gate(fixed([{ url: 'https://a.example/p', description: '299,000원' }, { url: 'https://b.example/q', description: '329,000원' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual([n5.receipt.verdict.decision, n5.receipt.verdict.reasons[0]], ['stop', 'insufficient_sources']);
  const { checkProcess } = await import('../src/verify/price.mjs');
  assert.deepEqual(checkProcess({ tool_calls: [null, 5, { url: 'https://a.example/x' }] }, { seller_url: 'https://a.example/x' }), ['single_source_lookup']);
  // N6: 같은 플랫폼의 다른 판매처는 주장 판매처를 본 것이 아니다
  assert.ok(checkProcess({ tool_calls: [{ url: 'https://blog.naver.com/x' }, { url: 'https://b.example/y' }] }, { seller_url: 'https://smartstore.naver.com/shop/1' }).includes('seller_not_in_log'));
});

const seq = (second) => {
  const pages = [[{ url: 'https://a.example/p', description: '최저 287,490원' }], second];
  return { name: 'fake', meter: createMeter(), web: async () => ({ results: pages.shift() ?? [] }), quick: async () => ({ answer: '', references: [] }) };
};
const AP3 = '에어팟 프로 3';
test('출처 부족 시 2차 web 검색으로 증거를 더 모은다 — 제목이 상품을 가리키면 진행, 더 싼 값이 나오면 정지', async () => {
  const ok = await gate(seq([{ url: 'https://b.example/q', title: '에어팟 프로3 정품', description: '287,490원' }]), { item: AP3, price_krw: 287490 });
  assert.deepEqual([ok.receipt.verdict.decision, ok.receipt.cost.calls['search.web']], ['proceed', 2]);
  const cheaper = await gate(seq([{ url: 'https://b.example/q', title: '에어팟 프로3', description: '287,490원' }, { url: 'https://g.example/r', description: '269,090원' }]), { item: AP3, price_krw: 287490 });
  assert.deepEqual([cheaper.receipt.verdict.decision, cheaper.receipt.verdict.reasons[0]], ['stop', 'marked_cheaper_seen']);
});

test('리뷰 94ef08a M-A: 2차 검색에서 가격만 같은 다른 상품(제목 불일치)은 출처가 되지 못한다', async () => {
  for (const title of ['갤럭시 버즈3 프로 287,490원', undefined, '프로 3 케이스']) {
    const { receipt } = await gate(seq([{ url: 'https://b.example/q', title, description: '287,490원' }]), { item: AP3, price_krw: 287490 });
    assert.deepEqual([receipt.verdict.decision, receipt.verdict.reasons[0]], ['stop', 'insufficient_sources'], String(title));
  }
});

test('공급자 오류 →확인불가·정지 영수증 (예외로 새지 않음)', async () => {
  const p = { name: 'fake', meter: createMeter(), web: async () => { throw new Error('503'); }, quick: async () => ({ answer: '' }) };
  const { receipt } = await gate(p, { item: 'W', price_krw: 1000 });
  assert.deepEqual([receipt.verdict.result, receipt.verdict.decision], ['unverifiable', 'stop']);
  assert.ok(receipt.verdict.reasons.includes('provider_error'));
});

test('위험도 override 는 상향만 (5백만원을 low 로 내릴 수 없음)', async () => {
  const p = fixed([]);
  const { receipt } = await gate(p, { item: 'W', price_krw: 5_000_000 }, { tierCtx: { override: 'low' } });
  assert.equal(receipt.tier, 'high');
});

test('process 단계에 seller_url 없으면 정지, 잘못된 phase 는 과금 전에 거절', async () => {
  const { receipt } = await run({ claim: { item: '에어팟 프로 3', price_krw: 287490 }, process: visited2 });
  assert.ok(receipt.verdict.reasons.includes('no_seller_url'));
  const p = fixed([]);
  await assert.rejects(verifyPrice({ claim: { item: 'W', price_krw: 1 }, phase: 'bogus' }, { provider: p, signer }), /phase/);
  assert.equal(p.hits, 0);
});

test('찾을 수 없는 상품 → 확인불가', async () => {
  const { receipt } = await run({ claim: { item: '존재하지않는상품 Z', price_krw: 10000 }, process: visited2 });
  assert.equal(receipt.verdict.result, 'unverifiable');
  assert.ok(receipt.verdict.reasons.includes('no_market_price'));
  assert.equal(receipt.verdict.decision, 'stop');
});

test('사후 판정(outcome): decision 없음 · 리뷰 94ef08a M-E: "최저 412,000원 · 카드 5% 할인" 은 조건부라 반박 근거가 아니라 확인불가', async () => {
  const { receipt } = await run({ claim: { item: '무선청소기 X1', price_krw: 450000 }, phase: 'outcome' });
  assert.equal(receipt.phase, 'outcome');
  assert.equal(receipt.verdict.decision, undefined);
  assert.deepEqual([receipt.verdict.result, receipt.verdict.reasons[0], receipt.verdict.better_offer], ['unverifiable', 'marked_cheaper_seen', undefined]);
  // 조건 없는 '최저' 값이면 여전히 반박(더 나은 값 제시)
  const plain = await gate(fixed([{ url: 'https://a.example/p', description: '최저 412,000원 무료배송' }]), { item: 'W', price_krw: 450000 }, { phase: 'outcome' });
  assert.deepEqual([plain.receipt.verdict.result, plain.receipt.verdict.better_offer], ['refuted', { price_krw: 412000, url: 'https://a.example/p' }]);
});

test('잘못된 주장 입력은 거절', async () => {
  await assert.rejects(run({ claim: { item: '', price_krw: 1 } }), /item/);
  await assert.rejects(run({ claim: { item: 'x', price_krw: -3 } }), /price_krw/);
});

// ── 리뷰 43b5e7b 재현 고정: price-v4 (추출은 표시만, 판정은 classify 한 곳) ──
const two299 = [{ url: 'https://a.example/p', description: '299,000원' }, { url: 'https://b.example/q', description: '299,000원' }];

test('리뷰 43b5e7b H1: 차액·절약 문맥의 더 싼 값도 버리지 않고 정지', async () => {
  for (const third of ['가격 차이 없이 259,000원', '3만원 절약, 지금 259,000원', '차액 보상! 259,000원']) {
    const { receipt } = await gate(fixed([...two299, { url: 'https://c.example/r', description: third }]), { item: 'W', price_krw: 299000 });
    assert.deepEqual([receipt.verdict.result, receipt.verdict.decision], ['unverifiable', 'stop'], third);
  }
});

test('리뷰 43b5e7b H2: 같은 결과가 주장가에 "최저" 를 붙여도 그 결과의 할인가·쿠폰가가 가려지지 않는다', async () => {
  const t = await gate(fixed([...two299, { url: 'https://c.example/r', title: '에어팟 최저가 299,000원', description: '오늘만 할인 259,000원' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual([t.receipt.verdict.decision, t.receipt.verdict.reasons[0]], ['stop', 'marked_cheaper_seen']);
  const same = await gate(fixed([{ url: 'https://a.example/p', description: '최저가 299,000원 · 쿠폰적용가 255,000원' }, { url: 'https://b.example/q', description: '299,000원' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual([same.receipt.verdict.decision, same.receipt.verdict.reasons[0]], ['stop', 'marked_cheaper_seen']);
});

test('리뷰 43b5e7b H6: "30만원 이상 구매시" 기준액은 두 번째 출처(긍정 증거)가 되지 못한다', async () => {
  const { receipt } = await gate(fixed([{ url: 'https://a.example/p', description: '300,000원' }, { url: 'https://b.example/q', description: '30만원 이상 구매시 무료배송' }]), { item: 'W', price_krw: 300000 });
  assert.deepEqual([receipt.verdict.decision, receipt.verdict.reasons[0]], ['stop', 'insufficient_sources']);
});

test('리뷰 43b5e7b H7: 노이즈 바닥 아래의 표시 없는 값(80,000원)도 버리지 않고 정지', async () => {
  const { receipt } = await gate(fixed([...two299, { url: 'https://c.example/r', description: 'G마켓 80,000원' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual([receipt.verdict.result, receipt.verdict.decision, receipt.verdict.reasons[0]], ['unverifiable', 'stop', 'far_below_value_seen']);
});

test('리뷰 43b5e7b M2: 2차 검색의 중고·리퍼·렌탈 결과는 주장가 확인 출처가 되지 못한다', async () => {
  for (const second of ['중고 에어팟 299,000원', '리퍼 제품 299,000원', '렌탈 299,000원']) {
    const pages = [[{ url: 'https://a.example/p', description: '299,000원' }], [{ url: 'https://c.example/r', description: second }]];
    const p = { name: 'fake', meter: createMeter(), web: async () => ({ results: pages.shift() ?? [] }), quick: async () => ({ answer: '', references: [] }) };
    const { receipt } = await gate(p, { item: 'W', price_krw: 299000 });
    assert.deepEqual([receipt.verdict.decision, receipt.verdict.reasons[0], receipt.cost.calls['search.web']], ['stop', 'insufficient_sources', 2], second);
  }
});

test('리뷰 43b5e7b L-SR-6: "최저 25만원 이상" 기준액은 반박(더 나은 값)이 아니라 확인불가', async () => {
  const { receipt } = await gate(fixed([...two299, { url: 'https://c.example/r', description: '최저 25만원 이상' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual([receipt.verdict.result, receipt.verdict.better_offer], ['unverifiable', undefined]);
});

test('리뷰 43b5e7b H8·N11: 문자열 아닌 nonce 는 거절, 실패한 호출도 비용 기록에 남는다', async () => {
  for (const bad of [123, { a: 1 }, '', null]) await assert.rejects(gate(fixed(two299), { item: 'W', price_krw: 299000, request_nonce: bad }), /request_nonce/);
  const ok = await gate(fixed(two299), { item: 'W', price_krw: 299000, request_nonce: 'n-1' });
  assert.equal(ok.receipt.claim.request_nonce, 'n-1');
  const down = { name: 'fake', meter: createMeter(), web: async () => { throw new Error('503'); }, quick: async () => ({ answer: '' }) };
  const { receipt } = await gate(down, { item: 'W', price_krw: 1000 });
  assert.deepEqual(receipt.cost.calls, { 'search.web:failed': 1 });
});

// ── 리뷰 94ef08a 재현 고정: price-v5 ──
test('리뷰 94ef08a H-A: 허용오차 아래쪽 구간(주장가×0.99 ~ 주장가)의 더 싼 값도 정지', async () => {
  for (const third of ['쿠폰적용가 297,100원', 'G마켓 296,100원', 'G마켓 298,999원', '최저 298,000원']) {
    const { receipt } = await gate(fixed([...two299, { url: 'https://c.example/r', description: third }]), { item: 'W', price_krw: 299000 });
    assert.equal(receipt.verdict.decision, 'stop', third);
    assert.notEqual(receipt.verdict.result, 'confirmed', third);
  }
  // 위쪽 허용오차는 유지: 주장가보다 조금 비싼 표시 없는 값은 확인 근거
  const up = await gate(fixed([{ url: 'https://a.example/p', description: '299,000원' }, { url: 'https://b.example/q', description: '301,000원' }]), { item: 'W', price_krw: 299000 });
  assert.equal(up.receipt.verdict.decision, 'proceed');
});

// 시드 고정 난수(mulberry32) — 실패하면 같은 입력으로 재현된다
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pickOf = (r, xs) => xs[Math.floor(r() * xs.length)];
const fmt = (r, v) => pickOf(r, [`${v.toLocaleString('en-US')}원`, `₩${v.toLocaleString('en-US')}`, `${v}원`, `KRW ${v.toLocaleString('en-US')}`, `${v.toLocaleString('en-US')} 원`]);
const PRE = ['', '최저 ', '최저가 ', 'G마켓 ', '할인가 ', '쿠폰적용가 ', '판매가 ', '오늘만 ', '정가 '];
const SUF = ['', ' 무료배송', ' (카드 할인 적용 시)', ' 이상', '~', ' 로켓배송', ' 중고'];
/** 임의 결과 목록: 주장가 표시 없는 출처 2곳(나머지가 없으면 진행할 입력) + 주장가 이상 잡음 + 주장가 미만 값 withCheaper 개 */
function randomCase(r, withCheaper) {
  const p = 10_000 + Math.floor(r() * 2_890_000);
  const results = [{ url: 'https://a.example/p', description: fmt(r, p) }, { url: 'https://b.example/q', description: `판매가 ${fmt(r, p)}` }];
  for (let i = Math.floor(r() * 4); i > 0; i--) results.push({ url: `https://n${i}.example/x`, description: `${pickOf(r, PRE)}${fmt(r, p + Math.floor(r() * p * 0.5))}${pickOf(r, SUF)}` });
  const cheaper = [];
  for (let i = 0; i < withCheaper; i++) {
    let v = Math.max(1000, Math.floor(p * (0.001 + r() * 0.999)));
    if (v >= p) v = p - 1;
    cheaper.push(v);
    const text = `${pickOf(r, PRE)}${fmt(r, v)}${pickOf(r, SUF)}`;
    if (r() < 0.5) results.push({ url: `https://c${i}.example/r`, ...(r() < 0.5 ? { title: text } : { description: text }) });
    else { const t = results[Math.floor(r() * results.length)]; t.description = `${t.description ?? ''} · ${text}`; }
  }
  for (let i = results.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [results[i], results[j]] = [results[j], results[i]]; }
  return { p, results, cheaper };
}

test('리뷰 94ef08a H-A 속성: 주장가 미만 값이 하나라도 섞인 임의 관측 목록은 진행·확인이 될 수 없다 (시드 고정 400건)', async () => {
  const r = rng(0x94ef08a);
  for (let n = 0; n < 400; n++) {
    const c = randomCase(r, 1 + Math.floor(r() * 3));
    const seen = observe(c.results, { api: 'search.web' }).map((o) => o.value);
    assert.ok(c.cheaper.some((v) => seen.includes(v)), `생성기: 더 싼 값이 추출되지 않음 #${n} ${JSON.stringify(c)}`);
    for (const phase of ['process', 'outcome']) {
      const { receipt } = await gate(fixed(c.results), { item: 'W', price_krw: c.p }, { phase });
      assert.notEqual(receipt.verdict.result, 'confirmed', `#${n} ${phase} ${JSON.stringify(c)}`);
      if (phase === 'process') assert.equal(receipt.verdict.decision, 'stop', `#${n} ${JSON.stringify(c)}`);
    }
  }
});

test('리뷰 94ef08a H-B: 숫자 뒤의 조건(카드 할인 적용 시·카드결제시)·범위(~) 가격은 주장가 확인 근거가 아니다', async () => {
  for (const [a, b] of [['299,000원 (카드 할인 적용 시)', '299,000원 카드결제시'], ['299,000원~', '299,000원 ~ 349,000원']]) {
    const { receipt } = await gate(fixed([{ url: 'https://a.example/p', description: a }, { url: 'https://b.example/q', description: b }]), { item: 'W', price_krw: 299000 });
    assert.deepEqual([receipt.verdict.decision, receipt.verdict.result], ['stop', 'unverifiable'], a);
  }
});

test('리뷰 94ef08a M-D: LLM 답 하나뿐인 "최저 N원" 으로는 반박(평판 감점)하지 않는다', async () => {
  const p = { ...fixed([]), quick: async () => ({ answer: '최저 250,000원 입니다', references: [{ url: 'https://ref.example/x' }] }) };
  const { receipt } = await gate(p, { item: 'W', price_krw: 299000 }, { phase: 'outcome' });
  assert.deepEqual([receipt.verdict.result, receipt.verdict.reasons[0], receipt.verdict.better_offer], ['unverifiable', 'answer_only_cheaper_seen', undefined]);
});

test('의장 결정 D2: 정지·확인불가 영수증에 사람 확인 후보(최대 5, 가격 오름차순, 원문 발췌) + 요약 한 줄', async () => {
  const many = [...two299, ...[259000, 270000, 280000, 240000, 290000, 250000].map((v, i) => ({ url: `https://c${i}.example/r`, description: `G마켓 ${v.toLocaleString('en-US')}원 ${'설명'.repeat(40)}` }))];
  const { receipt, summary } = await gate(fixed(many), { item: 'W', price_krw: 299000 });
  const c = receipt.verdict.review_candidates;
  assert.equal(receipt.verdict.decision, 'stop');
  assert.deepEqual(c.map((x) => x.price_krw), [240000, 250000, 259000, 270000, 280000]);
  for (const x of c) {
    assert.deepEqual(Object.keys(x).sort(), ['anchored', 'marks', 'price_krw', 'snippet', 'source', 'url']);
    assert.ok(x.snippet.length <= 80 && x.snippet.includes(x.price_krw.toLocaleString('en-US')), x.snippet);
  }
  assert.match(summary, /확인할 후보 5곳 · 최저 240,000원\(c3\.example, 표시 없음\)/);
  assert.equal(verifyReceipt(receipt, { trust }).valid, true);
  // 진행 영수증에는 후보가 없다
  const ok = await gate(fixed(two299), { item: 'W', price_krw: 299000 });
  assert.deepEqual([ok.receipt.verdict.decision, ok.receipt.verdict.review_candidates], ['proceed', undefined]);
  // 주장가만 보이고 출처가 모자란 정지도 후보(주장가 관측)를 싣는다
  const thin = await gate(fixed([{ url: 'https://a.example/p', description: '299,000원' }]), { item: 'W', price_krw: 299000 });
  assert.deepEqual(thin.receipt.verdict.review_candidates.map((x) => [x.price_krw, x.source]), [[299000, 'a.example']]);
});

test('의장 결정 D2: 후보 목록은 판정에 영향 0 — 후보를 끈 실행과 result·decision·reasons·better_offer 가 같다 (시드 고정 200건)', async () => {
  const r = rng(0xd2);
  const runWith = (results, p, phase, options) => verifyPrice({ claim: { item: 'W', price_krw: p, seller_url: 'https://a.example/p' }, process: { tool_calls: [{ url: 'https://a.example/p' }, { url: 'https://b.example/q' }] }, phase }, { provider: fixed(results), signer, options });
  for (let n = 0; n < 200; n++) {
    const c = randomCase(r, Math.floor(r() * 3));
    const phase = r() < 0.5 ? 'process' : 'outcome';
    const on = (await runWith(c.results, c.p, phase)).receipt.verdict;
    const off = (await runWith(c.results, c.p, phase, { maxCandidates: 0 })).receipt.verdict;
    const { review_candidates: cands, ...rest } = on;
    const { review_candidates: none, ...offRest } = off;
    assert.deepEqual(rest, offRest, `#${n}`);
    assert.equal(none, undefined);
    if (on.result === 'unverifiable' || on.decision === 'stop') assert.ok(Array.isArray(cands) || c.results.length === 0, `#${n}`);
  }
});
