// verify_price — "최저가" 주장 검증 (low 단계. mid 면 quick 교차 확인을 더한다. high 는 법정 구현 전까지 닫힘).
// 과정 판정(phase=process): 결제 직전 게이트 → proceed | stop. 가격 검증 + 작업 과정 기록(도구 호출 로그) 점검.
// 사후 판정(phase=outcome): 끝난 구매·추천의 결과 영수증 → 원장(평판)으로.
// 검증소는 구매를 대신하지 않는다 — 판정만 한다.
//
// 확인(confirmed)은 "더 싼 값을 못 찾음"이 아니라 긍정 증거가 있을 때만 낸다 (price-v2, 리뷰 0acda85 HIGH 1~3):
//   ① 주장가가 문맥 표시 없이 관측됨(±tolerance)  ② 그 관측의 독립 웹 출처 ≥ minSources  ③ 주장가보다 싼 관측이 하나도 없음
// price-v4(리뷰 43b5e7b H1·H2·H6·H7): 추출은 버리지 않고 표시만, 판정은 classify 한 곳. 더 싼 값은 표시·크기와 무관하게 전부 차단 근거.
// price-v6(리뷰 0e6acfa 3건): 읽지 못한 숫자도 unparsed 표시 관측으로 판정에 들어온다(extract). 관측된 값으로 다시 잰 위험도가 주장가 기준보다
//   높으면 확인하지 않는다(1% 낮춰 적어 등급을 내리는 길 차단). 과정 판정은 주장 판매처에서 주장가가 관측돼야 진행. 후보·증거는 출처당 하나씩 + 범위 안 최솟값 고정.
// price-v5(리뷰 94ef08a H-A·M-A·M-D·H-G, 의장 결정 D2):
//   '더 싼 값' = 주장가 미만 전부(허용오차는 위쪽에만). 2차 검색 결과는 제목이 상품을 가리켜야 출처. LLM 답만의 '최저 N원'은 반박 근거가 아니다.
//   high 가격은 법정 전까지 결과도 확인불가. 정지·확인불가 영수증에 사람이 볼 후보(review_candidates)를 붙인다 — 판정에는 영향 없음.
import { observe, extractPrices, hostOf, siteOf, resultsAllPlain } from './extract.mjs';
import { issueReceipt, PHASES } from '../receipt/receipt.mjs';
import { classifyTier, TIER_RULES_VERSION } from '../tiers.mjs';
import { createMeter } from '../providers/meter.mjs';

export const PRICE_RULE_VERSION = 'price-v9';
// noiseFloor: 이 비율 밑의 표시 없는 더 싼 값은 사유 코드만 far_below_value_seen 으로 가른다 — 버리지 않고 차단한다(리뷰 H7).
// tolerance 는 주장가 위쪽(주장가 ≤ 값 ≤ 주장가×(1+tol))에만 적용한다 — 아래쪽은 1원이라도 '더 싼 값'(H-A).
export const DEFAULTS = { tolerance: 0.01, band: [0.5, 2], noiseFloor: 0.3, yearFloor: 0.05, minSources: 2, minLogSources: 2, maxCandidates: 5 };
const TIER_ORDER = ['low', 'mid', 'high'];

/**
 * input: {
 *   claim: { item, price_krw, seller_url?, request_nonce? },
 *   process?: { tool_calls: [{ tool, url?, hostname? }] }   // 에이전트의 작업 기록(자기 신고 — 과정 점검의 한계)
 *   phase: 'process' | 'outcome', agentId?, tierCtx?: { reversible?, domain?, override? (상향만) }
 * }
 * deps: { provider, signer, now?, options? }
 */
export async function verifyPrice(input, { provider, signer, now, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const phase = input.phase ?? 'process';
  if (!PHASES.includes(phase)) throw new Error(`phase 는 process|outcome 이어야 합니다: ${phase}`);
  const claim = normalizeClaim(input.claim);
  const tier = decideTier(claim, input.tierCtx);
  const local = createMeter(); // 이 호출만의 비용 — 공유 미터 차분은 동시 호출 때 섞인다(리뷰 M8)
  // 실패한 호출도 기록한다(리뷰 N11) — 과금 여부는 공급자 몫이라 단가 0 으로 `<api>:failed` 에 센다
  const call = async (api, fn) => {
    try { const r = await fn(); local.record(api); return r; } catch (e) { local.record(`${api}:failed`, 0); throw e; }
  };

  const reasons = [];
  let obs = [];
  let references = [];
  let nonplain = false; // 조회 결과 어디든 평문 허용 목록 밖의 글자가 있었는가
  try {
    const web = await call('search.web', () => provider.web(`${claim.item} 최저가`, { max: 10 }));
    obs = observe(web.results, { api: 'search.web' });
    nonplain ||= !resultsAllPlain(web.results);
    // 주장가는 보였는데 독립 출처가 모자라면 같은 가격으로 한 번 더 찾는다 — 규칙을 낮추는 대신 증거를 더 모은다
    const c1 = classify(obs, claim, opt);
    if (c1.matching.length && c1.sources.size < opt.minSources && !blockers(c1)) {
      const web2 = await call('search.web', () => provider.web(`${claim.item} ${claim.price_krw.toLocaleString('ko-KR')}원`, { max: 10 }));
      // 가격으로 찾은 결과는 가격만 같은 다른 상품일 수 있다 — 제목이 상품을 가리키지 않으면 off_item 표시(확인 근거 불가, 더 싸면 차단)
      obs = obs.concat(observe(web2.results, { api: 'search.web2', item: claim.item }));
      nonplain ||= !resultsAllPlain(web2.results);
    }
    if (tier.tier !== 'low' || !hasPositiveEvidence(classify(obs, claim, opt), opt)) {
      const q = await call('agent.quick', () => provider.quick(`${claim.item} 의 현재 한국 최저가는 얼마인가? 원 단위 숫자와 판매처로 답해줘.`));
      // LLM 답의 가격은 답 자체가 출처 — 참조 URL 을 그 가격의 출처로 적지 않는다(리뷰 M12 덧붙임)
      obs = obs.concat(observe([{ description: q.answer }], { api: 'agent.quick' }));
      nonplain ||= !resultsAllPlain([{ description: q.answer }]);
      references = (q.references ?? []).slice(0, 3).map((r) => r.url).filter(Boolean);
    }
  } catch (e) {
    reasons.push('provider_error'); // 공급자 실패도 닫힌 쪽(stop) 영수증으로 남긴다(리뷰 M11)
  }

  const c = classify(obs, claim, opt);
  let result;
  let betterOffer;
  if (reasons.includes('provider_error')) result = 'unverifiable';
  else if (c.cheaperAnchored.length) {
    result = 'refuted'; reasons.push('cheaper_found');
    const b = minBy(c.cheaperAnchored);
    betterOffer = { price_krw: b.value, url: b.url };
  } else if (c.cheaperAnswerOnly.length) { result = 'unverifiable'; reasons.push('answer_only_cheaper_seen'); }
  else if (c.farBelowAnchored.length) { result = 'unverifiable'; reasons.push('anchored_price_far_below_claim'); }
  else if (c.cheaperUnanchored.length) { result = 'unverifiable'; reasons.push('unanchored_cheaper_seen'); }
  else if (c.cheaperMarked.length) { result = 'unverifiable'; reasons.push('marked_cheaper_seen'); }
  else if (c.farBelowUnanchored.length) { result = 'unverifiable'; reasons.push('far_below_value_seen'); }
  else if (!c.matching.length) { result = 'unverifiable'; reasons.push(obs.length ? 'claim_price_not_observed' : 'no_market_price'); }
  else if (c.sources.size < opt.minSources) { result = 'unverifiable'; reasons.push('insufficient_sources'); }
  // 적대 r5 H4: 위쪽 허용오차로 '확인'된 관측값이 주장가보다 높은 등급에 속하면, 낮은 등급 깊이로 본 것이라 확인이 아니다
  else if (TIER_ORDER.indexOf(decideTier({ ...claim, price_krw: Math.max(...c.matching.map((o) => o.value)) }, input.tierCtx).tier) > TIER_ORDER.indexOf(tier.tier)) { result = 'unverifiable'; reasons.push('observed_price_in_higher_tier'); }
  // price-v9(10차): 평문(허용 목록)이 아닌 글이 조회 결과에 하나라도 있으면 '확인' 하지 않는다 — 글을 쪼개고 숨기는 인코딩을 열거로는 닫을 수 없었다(계열 10회).
  else if (nonplain) { result = 'unverifiable'; reasons.push('nonplain_text_in_results'); }
  else { result = 'confirmed'; reasons.push('claim_price_observed'); }
  // 리뷰 94ef08a H-G: high 는 법정 전까지 과정·사후 모두 닫힘 — 사후 영수증이 법정 없이 평판에 들어가지 않게
  if (tier.tier === 'high') { result = 'unverifiable'; betterOffer = undefined; reasons.push('high_tier_not_implemented'); }

  // 과정 점검 — 작업 기록이 주어졌을 때만
  const processIssues = input.process ? checkProcess(input.process, claim, opt) : ['no_process_log'];
  if (phase === 'process' && !claim.seller_url) processIssues.push('no_seller_url');
  else if (phase === 'process' && (!siteOf(claim.seller_url) || !/^https?:\/\//i.test(claim.seller_url.trim()))) processIssues.push('invalid_seller_url'); // 리뷰 N2 · r6 L4(javascript: 등 웹 주소 아닌 스킴)
  // 적대 r5 H3·리뷰 M-1: 주장 판매처에서 주장가가 관측되지 않았으면 진행하지 않는다(검증소가 본 적 없는 판매처로 결제가 열리지 않게)
  const sellerSite = claim.seller_url ? siteOf(claim.seller_url) : null;
  const atSeller = (o) => o.url && siteOf(o.url) === sellerSite;
  if (phase === 'process' && sellerSite && !reasons.includes('provider_error') && !c.matching.some(atSeller)) {
    processIssues.push(obs.some((o) => atSeller(o) && !o.marks.length && o.value > claim.price_krw * (1 + opt.tolerance)) ? 'seller_price_higher' : 'seller_price_not_observed');
  }
  reasons.push(...processIssues);
  const decision = phase === 'process' ? (result === 'confirmed' && processIssues.length === 0 ? 'proceed' : 'stop') : undefined;

  const cost = local.snapshot();
  const sellerObs = obs.filter((o) => sellerSite && atSeller(o)).slice(0, 2);
  const evidence = spread([...new Set([...sellerObs, ...c.matching, ...c.cheaper])].sort((a, b) => a.value - b.value), claim, opt, 6, [...sellerObs, ...c.matching.slice(0, 1)])
    .map((o) => ({ url: o.url, source: o.source, value_krw: o.value, anchored: o.anchored, ...(o.marks.length ? { marks: [...o.marks] } : {}), api: o.api }));
  // D2: 판정이 끝난 뒤에만 만든다 — 사람이 '같은 상품인가'만 보면 되게. 판정(result·decision·reasons)에는 영향 없음
  const candidates = opt.maxCandidates > 0 && (result === 'unverifiable' || decision === 'stop') ? reviewCandidates(obs, claim, opt) : [];
  const receipt = issueReceipt({
    phase, tier: tier.tier, agentId: input.agentId, claimType: 'price', claim,
    verdict: { result, decision, reasons, better_offer: betterOffer, ...(candidates.length ? { review_candidates: candidates } : {}) },
    evidence: references.length ? [...evidence, { references }] : evidence,
    cost,
    method: { rule: PRICE_RULE_VERSION, tiers: TIER_RULES_VERSION, tier_reasons: tier.reasons, provider: provider.name, tolerance: opt.tolerance },
    now,
  }, signer);
  return { receipt, summary: summarize(receipt) };
}

/**
 * 판정 지점은 여기 하나(price-v4, 리뷰 43b5e7b H1·H2·H6·H7·불변식 6). 관측은 버려진 값 없이 표시(marks)만 달고 들어온다.
 *  - 확인 근거(matching): 표시 없음 + 주장가 ≤ 값 ≤ 주장가×(1+tol). 출처 수는 이 관측의 웹 출처만 센다(LLM 답 제외 — N4·N5).
 *    표시(조건부·차액·기준액·범위·근사·중고·다른 상품 등)가 붙은 값은 주장가와 같아도 확인 근거가 아니다(H6 기준액, M2 중고).
 *  - 주장가 미만(cheaper)은 1원 차이라도·표시·크기·같은 결과 여부와 무관하게 전부 차단 근거다. 예외 없음(H2, 94ef08a H-A).
 *    · 웹 출처 + '최저' 표시 + 표시 없음 + 범위 안 → 반박(더 나은 값 제시) · LLM 답만의 같은 값 → 확인불가(answer_only, M-D)
 *    · '최저' 표시 + 범위 밑 → 확인불가 · 표시 없음 ≥ noiseFloor → 확인불가(unanchored) · 표시 있음 → 확인불가(marked)
 *    · 표시 없음 < noiseFloor → 확인불가(far_below)
 */
/** 읽지 못한 숫자 중 가격이 아닌 것으로 보는 판단 — classify(차단)와 reviewCandidates(사람에게 보이는 후보)가 함께 쓴다. */
function notPriceFor(claim, opt) {
  const p = claim.price_krw;
  const itemNums = new Set(String(claim.item ?? '').normalize('NFKC').match(/\d+/g) ?? []);
  // 연도처럼 생긴 숫자(yearlike: 쉼표·원 없는 19xx·20xx)는 주장가의 5% 미만일 때만 가격이 아닌 것으로 본다("2025년 11월 기준"·"2025.11.22") —
  // 주장가가 4만 원쯤보다 낮으면 그 숫자가 진짜 더 싼 값일 수 있어 그대로 차단한다("행사 2000/1팩", 8차 레인 L-SH-3). '원' 이 붙은 2,025원은 yearlike 가 아니다.
  return (o) => Boolean(o.marks?.includes('unparsed') && (itemNums.has(String(o.value)) || (o.marks.includes('yearlike') && o.value < p * opt.yearFloor)));
}

export function classify(obs, claim, opt = DEFAULTS) {
  const p = claim.price_krw;
  const hi = p * (1 + opt.tolerance);
  const near = (o) => o.value >= p && o.value <= hi;
  const plain = (o) => !(o.marks?.length);
  const web = (o) => !o.source.startsWith('api:');
  // 레인 r6 L-SR-3: 상품명에 들어 있는 숫자("LG 그램 2024"·"WH-1000XM5")가 읽지 못한 숫자로 다시 관측된 것은 가격이 아니다 — 안 그러면 그런 상품은 영영 진행할 수 없다.
  // 상품명은 결제 측 기대 상품과 대조되므로(authorizes) 에이전트가 숫자를 끼워 넣어 차단을 비키면 허가가 나지 않는다.
  const notPrice = notPriceFor(claim, opt); // 가격이 아닌 것으로 보는 읽지 못한 숫자(상품명 숫자·연도꼴) — 후보 목록도 같은 판단을 쓴다
  const cheaper = obs.filter((o) => o.value < p && !notPrice(o));
  const inBand = (o) => o.value >= p * opt.band[0];
  const matching = obs.filter((o) => near(o) && plain(o));
  const c = {
    matching,
    cheaper,
    cheaperAnchored: cheaper.filter((o) => o.anchored && plain(o) && inBand(o) && web(o)),
    cheaperAnswerOnly: cheaper.filter((o) => o.anchored && plain(o) && inBand(o) && !web(o)),
    farBelowAnchored: cheaper.filter((o) => o.anchored && plain(o) && !inBand(o)),
    cheaperUnanchored: cheaper.filter((o) => !o.anchored && plain(o) && o.value >= p * opt.noiseFloor),
    cheaperMarked: cheaper.filter((o) => !plain(o)),
    farBelowUnanchored: cheaper.filter((o) => !o.anchored && plain(o) && o.value < p * opt.noiseFloor),
    sources: new Set(matching.filter(web).map((o) => o.source)),
  };
  // 위 여섯 갈래는 cheaper 를 빠짐없이 나눈다 — 어느 값도 판정에서 새지 않는다
  return c;
}
const blockers = (c) => c.cheaper.length;
const hasPositiveEvidence = (c, opt) => c.matching.length > 0 && c.sources.size >= opt.minSources && !blockers(c);
const minBy = (xs) => xs.reduce((a, b) => (b.value < a.value ? b : a));

/**
 * D2 사람 확인 후보: 주장가 이하(+위쪽 허용오차) 관측을 가격 오름차순으로 최대 maxCandidates 개, (url·값·발췌)가 같으면 한 번만.
 * 판정 함수(classify)를 거치지 않는 표시 전용 목록 — 여기서 무엇을 고르든 result·decision 은 이미 정해졌다.
 */
export function reviewCandidates(obs, claim, opt = DEFAULTS) {
  const hi = claim.price_krw * (1 + opt.tolerance);
  const seen = new Set();
  const uniq = [];
  const notPrice = notPriceFor(claim, opt); // 연도·상품명 숫자는 후보로 보여 주지 않는다(실호출 데모에서 '최저 2,024원' 이 후보 맨 위에 떴다)
  for (const o of [...obs].filter((x) => x.value <= hi && !notPrice(x)).sort((a, b) => a.value - b.value)) {
    const k = JSON.stringify([o.url, o.value, o.snippet ?? '']);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(o);
  }
  return spread(uniq, claim, opt, opt.maxCandidates).map((o) => ({ price_krw: o.value, url: o.url, source: o.source, marks: [...o.marks], anchored: o.anchored, snippet: o.snippet ?? '' }));
}

/**
 * 값 오름차순 목록에서 cap 개 고르기(표시 전용, 적대 r5 M5): 출처마다 가장 싼 값을 먼저, 남는 칸은 싼 순.
 * 범위 안(주장가×band[0] 이상) 최솟값은 반드시 넣는다 — 한 판매처의 옵션가·배송비 잔값이 칸을 다 채워 진짜 경쟁가를 가리지 못하게.
 */
function spread(sorted, claim, opt, cap, pins = []) {
  if (cap <= 0) return [];
  const first = [];
  const src = new Set();
  for (const o of sorted) if (!src.has(o.source)) { src.add(o.source); first.push(o); }
  const out = [...first, ...sorted.filter((o) => !first.includes(o))].slice(0, cap);
  // 꼭 실을 것: 범위 안 최솟값 + pins(주장 판매처 관측 — 레인 r6 L-SH-10). 뒤에서부터, 꼭 실을 것이 아닌 칸과 바꾼다.
  const need = [sorted.find((o) => o.value >= claim.price_krw * opt.band[0]), ...pins].filter((o) => o && sorted.includes(o)).slice(0, cap);
  for (const o of need) {
    if (out.includes(o)) continue;
    for (let i = out.length - 1; i >= 0; i--) if (!need.includes(out[i])) { out[i] = o; break; }
  }
  return out.sort((a, b) => a.value - b.value);
}

/** 금액은 주장가로 고정. override 는 상향만 허용(리뷰 L14). */
function decideTier(claim, ctx = {}) {
  const { override, ...rest } = ctx ?? {};
  const base = classifyTier({ ...rest, amountKrw: claim.price_krw, claimType: 'price' });
  if (override && TIER_ORDER.indexOf(override) > TIER_ORDER.indexOf(base.tier)) return { tier: override, reasons: [...base.reasons, 'override_up'] };
  return base;
}

function normalizeClaim(c = {}) {
  const raw = typeof c.price_krw === 'number' ? String(c.price_krw) : String(c.price_krw ?? '').trim();
  if (!c.item || !/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(raw)) throw new Error('claim 에 item 과 양의 정수 price_krw(원) 가 필요합니다');
  const price = Number(raw.replaceAll(',', ''));
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('claim 에 item 과 양의 정수 price_krw(원) 가 필요합니다');
  // 적대 r5 L1·M6: 줄바꿈으로 요약 첫 줄을 꾸미거나 거대한 상품명이 질의·원장에 그대로 실리지 않게
  const item = String(c.item).replace(/\s+/g, ' ').trim();
  if (!item || item.length > 200) throw new Error('claim 의 item 은 1~200자여야 합니다');
  const out = { item, price_krw: price };
  if (c.seller_url) out.seller_url = String(c.seller_url);
  // 의뢰자가 준 값 — 영수증을 특정 요청에 묶는다(리뷰 M9). 문자열이 아니면 조용히 버리지 않고 거절(리뷰 H8)
  if (c.request_nonce !== undefined) {
    if (typeof c.request_nonce !== 'string' || !c.request_nonce.trim()) throw new Error('claim 의 request_nonce 는 비어 있지 않은 문자열이어야 합니다');
    out.request_nonce = c.request_nonce;
  }
  return out;
}

/** 과정 점검: "최저가"라면서 판매처를 몇 곳 봤나, 주장한 판매처를 실제로 봤나. (기록은 자기 신고) */
export function checkProcess(proc, claim, opt = DEFAULTS) {
  const calls = (Array.isArray(proc?.tool_calls) ? proc.tool_calls : []).filter((c) => c && typeof c === 'object'); // 리뷰 N10
  const urls = calls.map((c) => (typeof c.url === 'string' ? c.url : typeof c.hostname === 'string' ? `https://${c.hostname}` : null)).filter(Boolean);
  const hosts = new Set(urls.map(hostOf).filter(Boolean)); // 판매처 수: 접어서 센다
  const sites = new Set(urls.map(siteOf).filter(Boolean)); // 주장 판매처 대조: 전체 호스트로(리뷰 N6)
  const issues = [];
  if (hosts.size < opt.minLogSources) issues.push('single_source_lookup');
  if (claim.seller_url) {
    const sh = siteOf(claim.seller_url);
    if (sh && !sites.has(sh)) issues.push('seller_not_in_log');
  }
  return issues;
}

const won = (x) => `${x.toLocaleString('ko-KR')}원`;
export function summarize(r) {
  const head = { confirmed: '확인', refuted: '반박', unverifiable: '확인불가' }[r.verdict.result];
  const gate = r.verdict.decision ? ` → ${r.verdict.decision === 'proceed' ? '진행' : '정지(사람 확인)'}` : '';
  const better = r.verdict.better_offer ? ` · 더 싼 곳 ${won(r.verdict.better_offer.price_krw)} ${r.verdict.better_offer.url ?? ''}` : '';
  const cands = r.verdict.review_candidates ?? [];
  const low = cands[0];
  const review = low ? `\n  확인할 후보 ${cands.length}곳 · 최저 ${won(low.price_krw)}(${low.source}, ${low.marks.length ? low.marks.join('·') : '표시 없음'})` : '';
  return `[${r.tier}/${r.phase}] ${r.claim.item} ${won(r.claim.price_krw)} 최저가 주장: ${head}${gate}${better} · 사유 ${r.verdict.reasons.join(',')} · 비용 $${r.cost.usd}${review}`;
}

export { extractPrices };
