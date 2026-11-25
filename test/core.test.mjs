import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSigner, makeTrustList } from '../src/receipt/keys.mjs';
import { issueReceipt, verifyReceipt, digestOf } from '../src/receipt/receipt.mjs';
import { canonicalize } from '../src/receipt/jcs.mjs';
import { classifyTier, classifyClaimTier, normalizeDomain, normalizePolicy } from '../src/tiers.mjs';
import { extractPrices, observe, hostOf } from '../src/verify/extract.mjs';

const signer = generateSigner();
const trust = makeTrustList([signer]);
const spec = {
  phase: 'process', tier: 'low', agentId: 'agent-a', claimType: 'price',
  claim: { item: '에어팟 프로 3', price_krw: 287490 },
  verdict: { result: 'confirmed', decision: 'proceed', reasons: ['no_cheaper_found'] },
  evidence: [], cost: { usd: 0.001, calls: { 'search.web': 1 } }, method: { rule: 'test' },
};

test('영수증: process 는 15분 뒤 만료, 깨진 입력은 예외 없이 bad_shape', () => {
  const t0 = new Date('2026-11-21T00:00:00Z');
  const r = issueReceipt({ ...spec, now: t0 }, signer);
  assert.equal(r.expires_at, '2026-11-21T00:15:00.000Z');
  assert.equal(verifyReceipt(r, { trust, now: new Date('2026-11-21T00:14:00Z') }).valid, true);
  assert.deepEqual(verifyReceipt(r, { trust, now: new Date('2026-11-21T00:16:00Z') }).reasons, ['expired']);
  const noClaim = structuredClone(r); delete noClaim.claim;
  assert.ok(verifyReceipt(noClaim, { trust }).reasons.includes('bad_shape'));
  assert.equal(verifyReceipt(null, { trust }).valid, false);
  assert.equal(verifyReceipt({ ...r, claim: { x: Infinity } }, { trust }).valid, false);
});

test('JCS: 키 정렬·undefined 제외', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
});

test('영수증: 서명 왕복 + JSON 직렬화 후에도 유효', () => {
  const r = issueReceipt(spec, signer);
  const chk = verifyReceipt(r, { trust });
  assert.deepEqual([chk.valid, chk.reasons], [true, []]);
  assert.deepEqual(verifyReceipt(JSON.parse(JSON.stringify(r)), { trust }).valid, true);
  assert.equal(r.subject.claim_digest, digestOf(spec.claim));
});

test('영수증: 주장 변조 → claim_digest_mismatch, 판정 변조 → signature, 남의 키 → untrusted_issuer', () => {
  const r = issueReceipt(spec, signer);
  const t1 = structuredClone(r); t1.claim.price_krw = 1;
  assert.ok(verifyReceipt(t1, { trust }).reasons.includes('claim_digest_mismatch'));
  const t2 = structuredClone(r); t2.verdict.result = 'refuted';
  assert.deepEqual(verifyReceipt(t2, { trust }).reasons, ['signature']);
  const other = issueReceipt(spec, generateSigner('did:web:evil.invalid#k'));
  assert.deepEqual(verifyReceipt(other, { trust }).reasons, ['untrusted_issuer']);
});

test('영수증: process 단계는 decision 필수', () => {
  assert.throws(() => issueReceipt({ ...spec, verdict: { result: 'confirmed' } }, signer), /decision/);
});

test('위험도: 금액·되돌림·영역·주장 종류', () => {
  assert.equal(classifyTier({ amountKrw: 287490, claimType: 'price' }).tier, 'low');
  assert.equal(classifyTier({ amountKrw: 600000 }).tier, 'mid');
  assert.equal(classifyTier({ amountKrw: 100000, reversible: false }).tier, 'mid');
  assert.equal(classifyTier({ amountKrw: 1_200_000, reversible: false }).tier, 'high');
  assert.equal(classifyTier({ amountKrw: 5_000_000 }).tier, 'high');
  assert.equal(classifyTier({ domain: 'medical' }).tier, 'high');
  assert.equal(classifyTier({ claimType: 'claim' }).tier, 'mid');
  assert.deepEqual(classifyTier({ override: 'high' }), { tier: 'high', reasons: ['default_low', 'override_up'] });
  // 리뷰 43b5e7b H4: 표기 변형·한국어 별칭·하향 override·domain 생략으로 법정을 비켜 가지 못한다
  for (const domain of ['Medical', ' medical', '의료', 'LEGAL', '법률', '금융']) assert.equal(classifyTier({ domain, claimType: 'claim' }).tier, 'high', domain);
  assert.equal(classifyTier({ domain: 'medical', override: 'mid', claimType: 'claim' }).tier, 'high');
  assert.equal(classifyTier({ amountKrw: 5_000_000, override: 'low' }).tier, 'high');
});

test('D1 사실 주장 위험도: 의뢰자 정책이 정하고, 에이전트는 올리기만, 정책 없으면 high(default_high)', () => {
  const t = (x) => { const r = classifyClaimTier(x); return [r.tier, r.domain_source]; };
  // 리뷰 94ef08a H-C 재현 주장들 — 키워드 추정 없이도 정책이 없으면 전부 법정
  for (const s of ['아세트아미노펜 하루 8g 안전', 'ETF 는 원금 보장이다', '전세 보증금은 내용증명만 보내면 돌려받는다']) assert.deepEqual(t({ statement: s }), ['high', 'default_high'], s);
  assert.deepEqual(t({ policyDomain: 'general' }), ['mid', 'policy']);
  assert.deepEqual(t({ policyDomain: 'medical' }), ['high', 'policy']);
  // 에이전트의 하향 시도(정책 medical + domain general/override low)는 무시
  assert.deepEqual(t({ policyDomain: 'medical', agentDomain: 'general', override: 'low' }), ['high', 'policy']);
  // 정책 general 에서 에이전트 상향
  assert.deepEqual(t({ policyDomain: 'general', agentDomain: 'medical' }), ['high', 'agent_raise']);
  assert.deepEqual(t({ policyDomain: 'general', override: 'high' }), ['high', 'agent_raise']);
  assert.deepEqual(t({ policyDomain: 'general', override: 'mid' }), ['mid', 'policy']);
  // 금액·되돌림은 정책 general 이어도 high 로 올린다
  assert.equal(classifyClaimTier({ policyDomain: 'general', amountKrw: 5_000_000 }).tier, 'high');
});

test('D1 domain 정규화: NFKC·문자/숫자 외 제거·별칭·포함 매칭(상향 전용), 정책은 알 수 없는 값 거절', () => {
  for (const d of ['med', 'pharma', '의료 건강', 'medi\u200bcal', 'ＭＥＤＩＣＡＬ', 'medical!', 'Health-care']) assert.equal(normalizeDomain(d), 'medical', d);
  assert.equal(normalizeDomain('법률 자문'), 'legal');
  assert.equal(normalizeDomain('other'), 'general');
  for (const d of ['constructor', '__proto__', 'toString', '', '  ', 'sports']) assert.equal(normalizeDomain(d), undefined, d);
  assert.deepEqual(normalizePolicy({ claim_domain: ' General ' }), { claim_domain: 'general' });
  assert.deepEqual(normalizePolicy(undefined), {});
  for (const bad of [{ claim_domain: 'genral' }, { claim_domain: 5 }, [], 'general']) assert.throws(() => normalizePolicy(bad), /policy/, JSON.stringify(bad));
});

test('가격 추출: 앵커·콤마·만/천·근사', () => {
  const p = extractPrices('에어팟 프로3 4,000원 최저287,490원 할인 전 가격 287,500원');
  assert.deepEqual(p.map((x) => [x.value, x.anchored]), [[4000, false], [287490, true], [287500, false]]);
  assert.deepEqual(extractPrices('공식가는 36만 9천 원'), [{ value: 369000, approx: false, anchored: false, conditional: false, diff: false, threshold: false, range: false }]);
  assert.deepEqual(extractPrices('35만 원대'), [{ value: 350000, approx: true, anchored: false, conditional: false, diff: false, threshold: false, range: false }]);
  assert.equal(extractPrices('최저가: 299,000원')[0].anchored, true);
});

test('관측: 어떤 값도 버리지 않고 표시만(price-v4), source=판매처 단위', () => {
  const obs = observe([{ url: 'https://prod.a.example/x', description: '4,000원 최저287,490원 35만 원대' }], { api: 'search.web' });
  assert.deepEqual(obs.map((o) => [o.value, o.anchored, o.marks]), [[4000, false, []], [287490, true, []], [350000, false, ['approx']]]);
  // 중고·리퍼는 결과 한 건 전체(제목에만 있어도 설명 값에) 붙는다
  assert.deepEqual(observe([{ url: 'https://c.example/r', title: '[중고] 에어팟', description: '299,000원' }], { api: 'search.web2' })[0].marks, ['used']);
  assert.equal(obs[0].source, 'a.example');
  assert.equal(observe([{ description: '최저 1,000원' }], { api: 'agent.quick' })[0].source, 'api:agent.quick');
});

test('가격 추출: 리뷰 오독 6형', () => {
  const v = (s) => extractPrices(s).filter((x) => !x.unparsed).map((x) => [x.value, x.approx]);
  assert.deepEqual(v('36만 9,900원'), [[369900, false]]);
  // r6: 숫자 덩어리는 다른 표기의 일부로 읽혔어도 단독 값으로 한 번 더 남는다(unparsed) — 읽힌 자리에 삼켜지는 값이 없게
  assert.deepEqual(extractPrices('36만 9,900원').filter((x) => x.unparsed).map((x) => x.value), [9900]);
  assert.deepEqual(v('1,234만원'), [[12340000, false]]);
  assert.deepEqual(v('29만9천900원'), [[299900, false]]);
  assert.deepEqual(v('₩287,490'), [[287490, false]]);
  // r5: 읽지 못한 덩어리는 버리지 않고 unparsed 표시로 남긴다(확인 근거 불가·더 싸면 차단)
  assert.ok(extractPrices('12345,678원').length > 0 && extractPrices('12345,678원').every((x) => x.unparsed));
  assert.deepEqual(v('290,000원대'), [[290000, true]]);
});

test('가격 추출: 리뷰 43b5e7b L-SR-5 형태(KRW·뒤 ₩·소수 만원)와 표시(기준액·차액·자리 모순)', () => {
  const v = (s) => extractPrices(s).map((x) => x.value);
  assert.deepEqual(v('KRW 259,000'), [259000]);
  assert.deepEqual(v('259,000₩'), [259000]);
  assert.deepEqual(v('25.9만원'), [259000]);
  assert.equal(extractPrices('30만원 이상 구매시 무료배송')[0].threshold, true);
  assert.equal(extractPrices('최저 30만원 이상')[0].threshold, true);
  assert.equal(extractPrices('가격 차이 없이 259,000원')[0].diff, true);
  assert.deepEqual(extractPrices('36만 12,000원').map((x) => [x.value, x.ambiguous]), [[360000, true], [12000, true]]); // r6 H2: 뒤 숫자 단독 읽기도 남긴다
});

test('가격 추출: 리뷰 94ef08a H-B 숫자 뒤 조건·범위 표시, M-G 만+네 자리', () => {
  for (const s of ['299,000원 (카드 할인 적용 시)', '299,000원 카드결제시', '299,000원 쿠폰 적용']) assert.equal(extractPrices(s)[0].conditional, true, s);
  for (const s of ['259,000원~', '259,000원 ~ 299,000원', '~299,000원']) assert.equal(extractPrices(s)[0].range, true, s);
  assert.equal(extractPrices('299,000원 무료배송')[0].conditional, false);
  assert.deepEqual(extractPrices('28만7490원').filter((x) => !x.unparsed).map((x) => x.value), [287490]);
  assert.deepEqual(extractPrices('28만 7490원').filter((x) => !x.unparsed).map((x) => x.value), [287490]);
  // 관측은 값이 나온 필드 원문 발췌(80자 이내)를 싣는다(D2)
  const o = observe([{ url: 'https://a.example/x', description: `${'가'.repeat(100)} 299,000원 ${'나'.repeat(100)}` }], { api: 'search.web' })[0];
  assert.ok(o.snippet.length <= 80 && o.snippet.includes('299,000원'));
});

test('hostOf: 하위 도메인·m.·www. 를 판매처 단위로 접음', () => {
  assert.equal(hostOf('https://prod.danawa.com/x'), 'danawa.com');
  assert.equal(hostOf('https://m.shop.co.kr/a'), 'shop.co.kr');
  assert.equal(hostOf('nope'), null);
});
