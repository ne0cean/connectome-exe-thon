// 검증 영수증 발급·검증.
// [기존 부분] 서명 방식 = connectome k6 영수증 v0.2 와 같음: payload = JCS(영수증 − signature), JWS detached(EdDSA, kid 헤더).
// [신규] 스키마(phase·tier·verdict·evidence·cost) — 에이전트 주장 검증용.
import { createHash, sign, verify } from 'node:crypto';
import { canonicalize } from './jcs.mjs';
import { ISSUER_DID, publicKeyOf } from './keys.mjs';
import { siteOf } from '../verify/extract.mjs';

export const RECEIPT_VERSION = 'verifier-receipt/0.1';
export const PHASES = ['process', 'outcome'];
export const TIERS = ['low', 'mid', 'high'];
export const RESULTS = ['confirmed', 'refuted', 'unverifiable'];
export const DECISIONS = ['proceed', 'stop'];
// 과정 판정(진행 허가)은 짧게 — 예전 proceed 영수증을 다른 시점 결제에 재사용하지 못하게(리뷰 M9). 사후 영수증은 평판 기록이라 길게.
export const TTL_MS = { process: 15 * 60_000, outcome: 365 * 86_400_000 };

const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
export const digestOf = (value) => `sha256:${sha256Hex(canonicalize(value))}`;

export function signingPayload(receipt) {
  const { signature: _omit, ...rest } = receipt;
  return canonicalize(rest);
}
export const receiptId = (receipt) => `sha256:${sha256Hex(signingPayload(receipt))}`;

function signDetached(receipt, signer) {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', kid: signer.kid }));
  const payload = b64u(signingPayload(receipt));
  return `${header}..${b64u(sign(null, Buffer.from(`${header}.${payload}`), signer.privateKey))}`;
}

/**
 * spec: { phase, tier, agentId, claimType, claim, verdict:{result, decision?, reasons[]}, evidence[], cost:{usd, calls}, method, now? }
 */
export function buildReceipt(spec) {
  if (!PHASES.includes(spec.phase)) throw new Error(`receipt: bad phase ${spec.phase}`);
  if (!TIERS.includes(spec.tier)) throw new Error(`receipt: bad tier ${spec.tier}`);
  if (!RESULTS.includes(spec.verdict?.result)) throw new Error(`receipt: bad result ${spec.verdict?.result}`);
  if (spec.phase === 'process' && !DECISIONS.includes(spec.verdict.decision)) throw new Error('receipt: process phase needs decision');
  const issued = spec.now ?? new Date();
  return {
    receipt_version: RECEIPT_VERSION,
    issuer: { id: ISSUER_DID },
    phase: spec.phase,
    tier: spec.tier,
    subject: { agent_id: spec.agentId ?? 'anonymous', claim_type: spec.claimType, claim_digest: digestOf(spec.claim) },
    claim: spec.claim,
    verdict: { result: spec.verdict.result, decision: spec.verdict.decision, reasons: spec.verdict.reasons ?? [], better_offer: spec.verdict.better_offer, review_candidates: spec.verdict.review_candidates },
    evidence: spec.evidence ?? [],
    cost: { usd: round6(spec.cost?.usd ?? 0), calls: spec.cost?.calls ?? {} },
    method: spec.method,
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + TTL_MS[spec.phase]).toISOString(),
  };
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export function issueReceipt(spec, signer) {
  const r = buildReceipt(spec);
  r.signature = signDetached(r, signer);
  return r;
}

/**
 * 반환 {valid, reasons[], authorizes}: reasons = bad_shape | claim_digest_mismatch | expired | signature | untrusted_issuer | nonce_mismatch. 어떤 입력에도 예외를 던지지 않는다.
 * expectedNonce: 의뢰자가 이 결제 건에 준 값 — 주면 영수증 claim.request_nonce 와 정확히 같아야 유효(리뷰 43b5e7b H8).
 * valid 는 '이 검증소가 발급한 변조 없는 영수증'이라는 뜻일 뿐, 정지·사후 영수증도 valid 다.
 * 결제 허가는 authorizes 하나만 본다(리뷰 94ef08a H-F). r5(리뷰 0e6acfa H-1·적대 H2·레인 L-SR-1·L-SH-3): authorizes 는 '이 결제'에 묶였을 때만 참이다 —
 *   valid && 과정·진행 && 가격 영수증 && expectedNonce 를 줬고 일치 && expected{item, price_krw, seller_url} 를 줬고 영수증 주장과 일치 && 공급자가 허가 목록 안.
 *   기대값을 주지 않으면 거짓이다(쉬운 다른 주장으로 받은 영수증·mock 판정·사실 주장 영수증이 결제 허가가 되지 않게). 막은 사유는 not_authorized 에.
 * authorizeProviders: 영수증 method.provider 허가 목록(기본 실조회 'liner' 만 — mock·mock-fallback 판정은 유효한 영수증이어도 결제 허가가 아니다).
 */
export const normItem = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function verifyReceipt(receipt, { trust, now = new Date(), expectedNonce, expected, authorizeProviders = ['liner'] }) {
  let out;
  try {
    out = check(receipt, trust, now);
  } catch {
    out = { valid: false, reasons: ['bad_shape'] };
  }
  if (expectedNonce !== undefined && (typeof expectedNonce !== 'string' || receipt?.claim?.request_nonce !== expectedNonce)) {
    out = { valid: false, reasons: [...out.reasons, 'nonce_mismatch'] };
  }
  const why = [];
  if (!out.valid) why.push('invalid');
  if (receipt?.phase !== 'process' || receipt?.verdict?.decision !== 'proceed') why.push('not_proceed');
  if (typeof expectedNonce !== 'string' || !expectedNonce) why.push('nonce_required');
  if (receipt?.subject?.claim_type !== 'price') why.push('not_price_receipt');
  else if (!expected || typeof expected.item !== 'string' || !Number.isSafeInteger(expected.price_krw) || typeof expected.seller_url !== 'string') why.push('expected_claim_required');
  else {
    if (normItem(expected.item) !== normItem(receipt.claim?.item)) why.push('item_mismatch');
    if (expected.price_krw !== receipt.claim?.price_krw) why.push('price_mismatch');
    const site = siteOf(expected.seller_url);
    if (!site || site !== siteOf(receipt.claim?.seller_url)) why.push('seller_mismatch');
  }
  if (!authorizeProviders.includes(receipt?.method?.provider)) why.push('provider_not_authorizing');
  return { ...out, authorizes: why.length === 0, not_authorized: why };
}
function check(receipt, trust, now) {
  const reasons = [];
  if (receipt?.receipt_version !== RECEIPT_VERSION || !PHASES.includes(receipt.phase) || !TIERS.includes(receipt.tier) || receipt.claim === undefined) reasons.push('bad_shape');
  else if (receipt.subject?.claim_digest !== digestOf(receipt.claim)) reasons.push('claim_digest_mismatch');
  if (!(Date.parse(receipt?.expires_at) > now.getTime())) reasons.push('expired');
  const parts = typeof receipt?.signature === 'string' ? receipt.signature.split('.') : [];
  if (parts.length !== 3 || parts[1] !== '') { reasons.push('signature'); return { valid: false, reasons }; }
  let kid;
  try { kid = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')).kid; } catch { reasons.push('signature'); return { valid: false, reasons }; }
  if (!Object.hasOwn(trust, kid)) { reasons.push('untrusted_issuer'); return { valid: false, reasons }; }
  try {
    const payload = b64u(signingPayload(receipt));
    if (!verify(null, Buffer.from(`${parts[0]}.${payload}`), publicKeyOf(trust[kid]), Buffer.from(parts[2], 'base64url'))) reasons.push('signature');
  } catch { reasons.push('signature'); }
  return { valid: reasons.length === 0, reasons };
}
