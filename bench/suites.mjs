// 스위트 정의: 입력 목록 · 한 건을 처리해 JSONL 한 줄(레코드)로 돌려주는 함수. 판정 코드는 src/ 를 부르기만 한다(측정 대상).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflate, repeatItems, infraReasons } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const data = (f) => JSON.parse(readFileSync(join(HERE, 'data', f), 'utf8'));

const brief = (out) => {
  const v = out.receipt.verdict;
  return { result: v.result, decision: v.decision, reasons: v.reasons ?? [], tier: out.receipt.tier, usd: out.receipt.cost?.usd ?? 0, candidates: v.review_candidates?.length ?? 0 };
};

async function courtRun(it, { v }) {
  const t0 = Date.now();
  const out = await v.courtClaim({ statement: it.statement, domain: it.domain, phase: 'process', agentId: 'bench-agent' });
  const m = out.receipt.method ?? {};
  const b = brief(out);
  if (infraReasons(b.reasons).length) return { id: it.id, status: 'error', error: `infra: ${infraReasons(b.reasons).join(',')}`, usd: b.usd };
  return { id: it.id, status: 'ok', ...(it.base ? { base: it.base, rep: it.rep } : {}), statement: it.statement, label: it.label, domain: it.domain, ...b, judges: m.judges ?? [], cited_defense_hosts: m.cited_defense_hosts ?? 0, receipt: out.receipt, ms: Date.now() - t0 };
}

export const SUITES = {
  price: {
    items: () => data('price-items.json'),
    async run(it, { v, tool, shop }) {
      const t0 = Date.now();
      const found = await shop(it.item, { tool, style: 'careful' });
      if (!found) return { id: it.id, item: it.item, status: 'no_price', ms: Date.now() - t0 };
      const process = { tool_calls: found.tool_calls };
      const gate = (claim) => v.verifyPrice({ claim, process, phase: 'process', agentId: 'bench-agent' });
      const real = await gate(found.claim);
      const bad = (o) => infraReasons(o.receipt.verdict.reasons).length;
      const inflatedPrice = inflate(found.claim.price_krw);
      const infl = await gate({ ...found.claim, price_krw: inflatedPrice });
      if (bad(real) || bad(infl)) return { id: it.id, item: it.item, status: 'error', error: `infra: ${infraReasons([...real.receipt.verdict.reasons, ...infl.receipt.verdict.reasons]).join(',')}` };
      return { id: it.id, item: it.item, status: 'ok', agent_price: found.claim.price_krw, inflated_price: inflatedPrice, tool_calls: found.tool_calls.length, real: brief(real), inflated: brief(infl), real_receipt: real.receipt, inflated_receipt: infl.receipt, ms: Date.now() - t0 };
    },
  },
  claim: {
    items: () => data('claims.json'),
    async run(it, { v }) {
      const t0 = Date.now();
      const out = await v.verifyClaim({ statement: it.statement, phase: 'process', agentId: 'bench-agent' });
      const b = brief(out);
      if (infraReasons(b.reasons).length) return { id: it.id, status: 'error', error: `infra: ${infraReasons(b.reasons).join(',')}`, usd: b.usd };
      return { id: it.id, status: 'ok', statement: it.statement, label: it.label, domain: it.domain, ...b, judge: out.receipt.method?.judge ?? null, receipt: out.receipt, ms: Date.now() - t0 };
    },
  },
  court: { items: () => data('court.json'), run: courtRun },
  'court-repeat': { items: (opts) => repeatItems(data('court.json'), opts.reps ?? 10), run: courtRun },
};
