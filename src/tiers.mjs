// 위험도 판정: 금액·영역·되돌림 가능성·주장 종류 → low | mid | high.
// 위험도가 검증 깊이를 정한다: low=즉시 조회(web·quick), mid=근거 대조(AI 검색·논문), high=법정(검사·변호 Deep Research → 판사).
// 규칙은 한 표에 모은다 — 문턱을 바꾸면 이 파일만 고친다. (TIER_RULES_VERSION 은 영수증 method 에 기록)
// tiers-v4(리뷰 0e6acfa L-SH-8): 영문 별칭은 낱말 단위로만 매칭('social media'≠med), 정책 값은 네 값 정확히만.
export const TIER_RULES_VERSION = 'tiers-v4';
export const THRESHOLDS_KRW = { mid: 500_000, high: 3_000_000, highIrreversible: 1_000_000 };
export const HIGH_DOMAINS = ['medical', 'legal', 'finance'];
const TIER_ORDER = ['low', 'mid', 'high'];

// 사실 주장 위험도의 신뢰 경계(의장 결정 D1, 리뷰 94ef08a H-C):
//  - 등급을 정하는 쪽은 의뢰자(검증소를 띄우는 운영자) — policy.claim_domain (createVerifier({policy}) / env VERIFIER_POLICY).
//  - 검증받는 에이전트가 넘기는 domain·override 는 등급을 올릴 수만 있다(내릴 수 없다).
//  - 의뢰자 지정이 없으면 사실 주장은 high(법정)로 보낸다(fail-safe). 주장문 키워드 추정은 쓰지 않는다 — 열거로는 닫을 수 없어서(9/10 미탐).
export const CLAIM_DOMAINS = ['general', ...HIGH_DOMAINS];
const DOMAIN_ALIASES = {
  medical: 'medical', medicine: 'medical', med: 'medical', medic: 'medical', clinical: 'medical', health: 'medical', healthcare: 'medical', pharma: 'medical', pharmacy: 'medical', pharmaceutical: 'medical', drug: 'medical', drugs: 'medical',
  의료: 'medical', 의학: 'medical', 건강: 'medical', 보건: 'medical', 약학: 'medical', 의약: 'medical', 약: 'medical',
  legal: 'legal', law: 'legal', lawyer: 'legal', lawsuit: 'legal', attorney: 'legal', litigation: 'legal', 법률: 'legal', 법무: 'legal', 법: 'legal',
  finance: 'finance', financial: 'finance', tax: 'finance', investment: 'finance', 금융: 'finance', 재무: 'finance', 세무: 'finance', 투자: 'finance', 세금: 'finance',
  general: 'general', other: 'general', 일반: 'general',
};
const HIGH_ALIAS_KEYS = Object.keys(DOMAIN_ALIASES).filter((k) => DOMAIN_ALIASES[k] !== 'general' && k.length >= 2);
const isLatin = (k) => /^[a-z0-9]+$/.test(k);
const HIGH_LATIN = HIGH_ALIAS_KEYS.filter(isLatin);
const HIGH_OTHER = HIGH_ALIAS_KEYS.filter((k) => !isLatin(k));
const LATIN_CHAIN = new RegExp(`^(?:${[...HIGH_LATIN].sort((a, b) => b.length - a.length).join('|')})+$`);
/**
 * domain 문자열 → 'general'|'medical'|'legal'|'finance'|undefined.
 * NFKC + 서식 문자(폭 0 공백 등) 제거 + 소문자. 문자·숫자 외를 다 지운 값이 별칭과 같으면 그것('medi.cal'·'Health-care').
 * 아니면 낱말로 쪼개(공백·구두점·camelCase·라틴/한글 경계) 고위험 별칭을 찾는다 — 올리는 쪽으로만 쓰인다.
 *   영문 별칭은 낱말과 정확히 같을 때만('social media'·'comedy'·'syntax' 는 아님, 리뷰 0e6acfa L-SH-8),
 *   한글 별칭은 낱말 안 포함도 본다('의료건강'·'의료상담' — 띄어쓰기 없는 합성어가 흔해서).
 */
export function normalizeDomain(d) {
  if (typeof d !== 'string') return undefined;
  const s = d.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase();
  const k = s.replace(/[^\p{L}\p{N}]/gu, '');
  if (!k) return undefined;
  if (Object.hasOwn(DOMAIN_ALIASES, k)) return DOMAIN_ALIASES[k];
  const words = s.replace(/[^\p{L}\p{N}]+/gu, ' ').match(/[a-z0-9]+|[^a-z0-9 ]+/g) ?? [];
  for (const w of words) {
    // 레인 r6 L-SH-5: 정확 일치만 보면 올리기 쪽이 줄었다(medicaladvice·taxes·laws·taxlaw·drugstore) — 복수형, 4자 이상 별칭의 접두, 별칭끼리 이어 붙인 낱말도 올린다.
    // 3자 별칭(med·tax·law)은 접두를 보지 않는다('media'·'lawn' 은 그대로 일반).
    const hit = isLatin(w) ? HIGH_LATIN.find((a) => w === a || w === `${a}s` || w === `${a}es` || (a.length >= 4 && w.startsWith(a))) ?? (LATIN_CHAIN.test(w) ? HIGH_LATIN.find((a) => w.startsWith(a)) : undefined) : HIGH_OTHER.find((a) => w.includes(a));
    if (hit) return DOMAIN_ALIASES[hit];
  }
  return undefined;
}

/**
 * 사실 주장의 위험도 (D1). policyDomain = 의뢰자 지정(정규화 전 문자열도 됨), agentDomain·override = 에이전트 입력(상향만).
 * ctx 의 금액·되돌림(amountKrw·reversible)도 high 로 올릴 수 있다.
 * 반환 { tier, reasons[], domain?, domain_source: 'policy'|'agent_raise'|'default_high' }
 */
export function classifyClaimTier({ policyDomain, agentDomain, override, ...ctx } = {}) {
  const p = normalizeDomain(policyDomain);
  const a = normalizeDomain(agentDomain);
  let out;
  if (HIGH_DOMAINS.includes(p)) out = { tier: 'high', reasons: [`domain_${p}`], domain: p, domain_source: 'policy' };
  else if (HIGH_DOMAINS.includes(a)) out = { tier: 'high', reasons: [`domain_${a}`, 'agent_raise'], domain: a, domain_source: 'agent_raise' };
  else if (override === 'high') out = { tier: 'high', reasons: ['override_up'], domain: p, domain_source: 'agent_raise' };
  else if (p === 'general') out = { tier: 'mid', reasons: ['claim_type_claim', 'domain_policy_general'], domain: 'general', domain_source: 'policy' };
  else out = { tier: 'high', reasons: ['domain_default_high'], domain: undefined, domain_source: 'default_high' };
  if (out.tier !== 'high') {
    const base = baseTier({ ...ctx, claimType: 'claim' });
    if (base.tier === 'high') out = { ...out, tier: 'high', reasons: [...out.reasons, ...base.reasons] };
  }
  return out;
}

/**
 * 의뢰자 정책 검증·정규화. 없으면 {} (= 사실 주장 기본 high). claim_domain 은 general|medical|legal|finance 정확히(대소문자·앞뒤 공백만 허용).
 * 별칭·포함 매칭은 쓰지 않는다 — 운영자 값은 등급을 내릴 수도 있어서 'general medicine' 같은 값을 추측하지 않고 거절한다(리뷰 0e6acfa L-SH-8).
 */
export function normalizePolicy(policy) {
  if (policy === undefined || policy === null) return {};
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new Error('policy 는 객체여야 합니다');
  const out = {};
  if (policy.claim_domain !== undefined) {
    const d = typeof policy.claim_domain === 'string' ? policy.claim_domain.trim().toLowerCase() : undefined;
    if (!CLAIM_DOMAINS.includes(d)) throw new Error(`policy.claim_domain 은 ${CLAIM_DOMAINS.join('|')} 중 하나여야 합니다`);
    out.claim_domain = d;
  }
  return out;
}

/**
 * ctx: { amountKrw?, domain?, reversible? (기본 true), claimType? ('price'|'claim'|'done'), override? (상향만) }
 * 반환 { tier, reasons[] } — reasons 는 판정에 쓰인 규칙 코드(사람이 읽을 근거).
 */
export function classifyTier(ctx = {}) {
  const base = baseTier(ctx ?? {});
  const o = ctx?.override;
  // override 는 상향만 — 하향은 무시한다(price·claim 공통, 리뷰 43b5e7b H4·L14)
  if (TIER_ORDER.includes(o) && TIER_ORDER.indexOf(o) > TIER_ORDER.indexOf(base.tier)) return { tier: o, reasons: [...base.reasons, 'override_up'] };
  return base;
}

function baseTier(ctx) {
  const amount = Number(ctx.amountKrw ?? 0);
  const reversible = ctx.reversible !== false;
  const domain = normalizeDomain(ctx.domain);

  const high = [];
  if (amount >= THRESHOLDS_KRW.high) high.push('amount_ge_high');
  if (!reversible && amount >= THRESHOLDS_KRW.highIrreversible) high.push('irreversible_large');
  if (HIGH_DOMAINS.includes(domain)) high.push(`domain_${domain}`);
  if (high.length) return { tier: 'high', reasons: high };

  const mid = [];
  if (amount >= THRESHOLDS_KRW.mid) mid.push('amount_ge_mid');
  if (!reversible) mid.push('irreversible');
  if (ctx.claimType === 'claim' || ctx.claimType === 'done') mid.push(`claim_type_${ctx.claimType}`);
  if (mid.length) return { tier: 'mid', reasons: mid };

  return { tier: 'low', reasons: ['default_low'] };
}
