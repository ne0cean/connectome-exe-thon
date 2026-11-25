// 검증소 조립: 공급자·서명키·원장을 한 번 묶어 verify* 함수로 내놓는다. CLI·MCP 서버·데모가 공통으로 쓴다.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider, createModelFor } from './providers/index.mjs';
import { runCourt } from './court/court.mjs';
import { verifyClaim } from './verify/claim.mjs';
import { reputation, readLedger } from './ledger.mjs';
import { loadOrCreateSigner, makeTrustList } from './receipt/keys.mjs';
import { verifyReceipt } from './receipt/receipt.mjs';
import { verifyPrice } from './verify/price.mjs';
import { verifyDone } from './verify/done.mjs';
import { normalizePolicy, normalizeDomain } from './tiers.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** verifier/.env 를 읽어 아직 정의되지 않은 env 만 채운다(빈 문자열로 명시한 값은 존중). 값을 출력하지 않는다. */
export function loadDotEnv(path = join(ROOT, '.env'), env = process.env) {
  if (env.VERIFIER_NO_DOTENV === '1' || !existsSync(path)) return; // VERIFIER_NO_DOTENV=1: .env 를 읽지 않는다(테스트가 개발자의 .env 에 흔들리지 않게)
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, '$2'); // 따옴표 값: 닫는 따옴표 뒤(주석) 버림
    else v = v.replace(/\s+#.*$/, ''); // 맨 값: ' #' 이후 인라인 주석 버림
    if (v) env[m[1]] = v;
  }
}
/** 상대경로는 실행 위치(cwd)가 아니라 verifier/ 기준 — 레포 루트에서 돌려도 키가 무시 목록 안(.keys/)에 생긴다. */
export const fromRoot = (p) => resolve(ROOT, p);

/**
 * 의뢰자 정책(D1) 읽기: VERIFIER_POLICY = JSON 파일 경로(상대경로는 verifier/ 기준). 없으면 {} → 사실 주장은 high(법정).
 * 파일이 없거나 형식이 틀리면 기동을 멈춘다 — 운영자 실수가 조용히 기본값이 되지 않게.
 */
export function loadPolicy(path = process.env.VERIFIER_POLICY) {
  if (!path) return {};
  let raw;
  try { raw = JSON.parse(readFileSync(fromRoot(path), 'utf8')); } catch (e) { throw new Error(`VERIFIER_POLICY 를 읽을 수 없습니다: ${e.code ?? 'bad_json'}`); }
  return normalizePolicy(raw);
}

/**
 * 에이전트가 준 domain 을 검증소 입구에서 검사한다(8차 레인 L-SR-4·L-SH-10): 알아보지 못한 값을 조용히 mid 로 두지도, 조용히 법정으로 올리지도 않고 입력 오류로 돌려준다.
 * 별칭을 하나씩 더하는 방식은 'taxation'·'clinic' 에서 계속 샜다 — 모르는 값은 묻는 쪽이 고치게 한다.
 */
export function checkAgentDomain(d) {
  if (d === undefined || d === null || d === '') return undefined;
  if (typeof d !== 'string' || normalizeDomain(d) === undefined) throw new Error('claim: domain 을 알아볼 수 없습니다 — medical | legal | finance | other(general) 또는 그 별칭(예: 의료·법률·tax)을 주세요');
  return d;
}

export function createVerifier({ provider, model, signer, ledgerPath, onNotice, policy, authorizeProviders } = {}) {
  policy = policy === undefined ? loadPolicy() : normalizePolicy(policy);
  // 결제 허가를 낼 수 있는 공급자(기본 실조회 liner 만). 시연·테스트에서만 env 로 넓힌다 — mock 판정이 조용히 허가가 되지 않게.
  authorizeProviders ??= process.env.VERIFIER_AUTHORIZE_PROVIDERS ? process.env.VERIFIER_AUTHORIZE_PROVIDERS.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  provider ??= createProvider({ onNotice });
  model ??= createModelFor(provider);
  signer ??= loadOrCreateSigner(fromRoot(process.env.VERIFIER_KEY_FILE || '.keys/issuer.json'));
  // undefined = 기본 원장, null = 원장 없음(8차 레인 L-SH-7: null 이 기본 경로로 떨어져 테스트가 운영 원장에 줄을 쌓았다)
  if (ledgerPath === undefined) ledgerPath = fromRoot(process.env.VERIFIER_LEDGER || 'data/ledger.jsonl');
  const trust = makeTrustList([signer]);
  const record = (out) => {
    if (ledgerPath) {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, `${JSON.stringify(out.receipt)}\n`);
    }
    return out;
  };
  // request_nonce 는 1회용(리뷰 0e6acfa M-4·적대 H2): 같은 결제 건으로 정지 뒤 다시 물어 진행을 받아 내지 못하게. 원장에 남은 것도 쓴 것으로 본다.
  // r6 M1: 원장은 호출마다 다시 읽는다 — 같은 원장을 쓰는 다른 프로세스(MCP 서버 + CLI)에서 정지된 건도 본다. 진행 중인 건은 메모리로 막는다.
  // 한계: 원장 없이 띄우면 재기동 뒤에는 기억하지 못하고, 두 프로세스가 같은 순간에 같은 nonce 를 받으면 둘 다 통과할 수 있다(README).
  const inFlight = new Set();
  const claimNonce = (input) => {
    const n = input?.claim?.request_nonce;
    if ((input?.phase ?? 'process') !== 'process' || typeof n !== 'string') return undefined;
    const used = inFlight.has(n) || readLedger(ledgerPath ?? '').receipts.some((r) => r?.phase === 'process' && r?.claim?.request_nonce === n);
    if (used) throw new Error('claim 의 request_nonce 는 1회용입니다 — 이미 판정에 쓰인 값입니다(새 결제 요청으로 새 nonce 를 받으세요)');
    inFlight.add(n);
    return n;
  };
  return {
    provider,
    signer,
    trust,
    verifyPrice: async (input, opts = {}) => {
      const n = claimNonce(input);
      // 영수증이 원장에 남으면 원장이 기억한다. 입력 오류로 영수증 없이 끝난 건은 nonce 를 쓰지 않은 것으로 돌린다(r6 L1). 원장이 없으면 메모리가 유일한 기억이라 지우지 않는다.
      try { const out = record(await verifyPrice(input, { provider, signer, ...opts })); if (n !== undefined && ledgerPath) inFlight.delete(n); return out; } catch (e) { if (n !== undefined) inFlight.delete(n); throw e; }
    },
    policy,
    // domain 검사는 여기 한 곳(라이브러리·MCP·CLI 가 모두 지난다 — 9차 L-SH-8)
    verifyClaim: async (input) => record(await verifyClaim({ ...input, domain: checkAgentDomain(input?.domain) }, { provider, model, signer, policy })),
    courtClaim: async (input) => record(await runCourt({ ...input, domain: checkAgentDomain(input?.domain) }, { provider, model, signer, policy })),
    verifyDone: async (input) => record(await verifyDone(input, { provider, signer })),
    checkReceipt: (receipt, { expectedNonce, expected } = {}) => verifyReceipt(receipt, { trust, expectedNonce, expected, ...(authorizeProviders ? { authorizeProviders } : {}) }),
    reputation: (agentId) => {
      const { receipts, broken } = readLedger(ledgerPath);
      const rep = reputation(receipts, { trust });
      rep.rejected += broken;
      return agentId ? { rule: rep.rule, agent_id: agentId, ...(Object.hasOwn(rep.agents, agentId) ? rep.agents[agentId] : { total: 0 }), rejected: rep.rejected } : rep;
    },
    usage: () => provider.meter.snapshot(),
  };
}
