// 사실·인용 주장 검증 (mid 단계, claim-v4). 위험도가 high(의뢰자 정책·에이전트 상향·정책 없음 기본)면 법정(court)으로 넘긴다.
// mid: Liner Agent search 1건(인용 주장은 scholar 모드 + Search API scholar 논문 조회) → 판사 1명(gpt 계열) →
//   확인 = 판사 adopt + 판사가 근거로 든 출처 중 실제 제공된 것의 독립 호스트 ≥ 2(리뷰 43b5e7b H5).
//   반박 = 판사 reject + 판사가 근거로 든 출처 중 실제 제공된 것 ≥ 1(리뷰 94ef08a H-E — adopt 와 대칭). 나머지 확인불가.
// 위험도(D1): 의뢰자 policy.claim_domain 이 정한다. 에이전트의 domain·override 는 올리기만, 지정이 없으면 high(법정).
// claim-v4(리뷰 0e6acfa): 법정으로 넘길 때 citation 도 넘김(L-SH-4), search 질의의 주장문을 JSON 문자열로 가둠(T1), 문자·숫자 없는·2,000자 초과 주장문 거절(L-SH-13).
import { classifyClaimTier, TIER_RULES_VERSION } from '../tiers.mjs';
import { issueReceipt, PHASES } from '../receipt/receipt.mjs';
import { createMeter } from '../providers/meter.mjs';
import { hostOf } from './extract.mjs';
import { runCourt, parseJudgment, citedFrom, checkStatement, DATA_GUARD, QUERY_GUARD } from '../court/court.mjs';

export const CLAIM_RULE_VERSION = 'claim-v4';
const MIN_SOURCES = 2;
const REPORT_MAX = 6000;
const JUDGE_SYSTEM =
  '너는 사실 검증 판사다. 주장 하나와 검색 보고서(출처 목록 포함)를 받는다. 보고서 밖의 지식으로 판단하지 마라. ' +
  '보고서의 출처가 주장을 뒷받침하면 adopt, 출처 있는 반증이 있으면 reject, 판단할 근거가 부족하면 insufficient. ' +
  'decisive_sources 에는 DATA 의 sources·papers 에 있는 URL 만 그대로 적어라. ' + DATA_GUARD + ' ' +
  '오직 JSON 한 개만 출력: {"verdict":"adopt|reject|insufficient","decisive_sources":["url"],"reason_codes":["짧은_코드"]}';

/**
 * input: { statement, citation?(논문·연구 인용 주장), domain?(에이전트 신고 — 상향만), phase?, agentId?, tierCtx? }
 * deps: { provider, model, signer, now?, policy?: { claim_domain? } (의뢰자 지정 — normalizePolicy 를 거친 값) }
 */
export async function verifyClaim(input, { provider, model, signer, now, policy = {} }) {
  const phase = input.phase ?? 'process';
  if (!PHASES.includes(phase)) throw new Error(`phase 는 process|outcome 이어야 합니다: ${phase}`);
  const statement = checkStatement(input.statement);
  const citation = Boolean(input.citation);

  const t = classifyClaimTier({ ...(input.tierCtx ?? {}), policyDomain: policy.claim_domain, agentDomain: input.domain });
  const domain = t.domain;
  if (t.tier === 'high') return runCourt({ statement, citation, domain, domainSource: t.domain_source, tierReasons: t.reasons, phase, agentId: input.agentId }, { provider, model, signer, now, policy });

  const local = createMeter();
  const reasons = [];
  let report = { answer: '', references: [] };
  let papers = [];
  try {
    const r = await provider.search(`다음 주장이 사실인지 출처와 함께 확인하라. ${QUERY_GUARD} 주장: ${JSON.stringify(statement)}`, { scholar: citation });
    report = { answer: String(r?.answer ?? ''), references: Array.isArray(r?.references) ? r.references : [] };
    local.record('agent.search');
  } catch { local.record('agent.search:failed', 0); reasons.push('provider_error'); }
  if (citation) {
    try { papers = (await provider.scholar(statement, { max: 5 })).results ?? []; local.record('search.scholar'); } catch { local.record('search.scholar:failed', 0); reasons.push('provider_error'); }
  }

  const str = (u) => typeof u === 'string' && u;
  const refUrls = report.references.map((r) => r?.url).filter(str).slice(0, 10);
  const paperList = papers.slice(0, 5).filter((p) => str(p?.url));
  const urls = [...refUrls, ...paperList.map((p) => p.url)];
  let j = { error: 'skipped' };
  let citedHosts = new Set();
  let cited = [];
  if (!reasons.length) {
    // 주장문·보고서는 JSON 문자열 필드로만(리뷰 43b5e7b M1)
    const prompt = `${DATA_GUARD}\nDATA:\n${JSON.stringify({ statement, report: report.answer.slice(0, REPORT_MAX), sources: refUrls, ...(paperList.length ? { papers: paperList.map((p) => ({ title: String(p.title ?? ''), url: p.url })) } : {}) })}`;
    try {
      const out = await model.chat({ system: JUDGE_SYSTEM, prompt });
      local.record('model.chat', 0);
      j = { model: out.model, ...parseJudgment(out.text) };
    } catch { local.record('model.chat:failed', 0); j = { error: 'call_failed' }; }
    if (j.error) reasons.push('judge_error');
    else {
      cited = citedFrom(j.decisive_sources, urls);
      citedHosts = new Set(cited.map(hostOf).filter(Boolean));
    }
  }

  let result = 'unverifiable';
  if (!reasons.length && j.verdict === 'adopt' && citedHosts.size >= MIN_SOURCES) { result = 'confirmed'; reasons.push('judge_adopt_multi_source'); }
  else if (!reasons.length && j.verdict === 'reject' && cited.length >= 1) { result = 'refuted'; reasons.push('judge_reject_with_evidence'); }
  else if (!reasons.length) reasons.push({ adopt: 'too_few_sources', reject: 'reject_without_cited_source' }[j.verdict] ?? 'judge_insufficient');

  const receipt = issueReceipt({
    phase, tier: t.tier, agentId: input.agentId, claimType: 'claim',
    claim: { statement, ...(citation ? { citation: true } : {}), ...(domain ? { domain } : {}) },
    verdict: { result, decision: phase === 'process' ? (result === 'confirmed' ? 'proceed' : 'stop') : undefined, reasons },
    evidence: urls.slice(0, 8).map((url) => ({ url, source: hostOf(url) })),
    cost: local.snapshot(),
    method: { rule: CLAIM_RULE_VERSION, tiers: TIER_RULES_VERSION, tier_reasons: t.reasons, domain_source: t.domain_source, provider: provider.name, judge: { model: j.model ?? null, verdict: j.verdict ?? null, error: j.error ?? null, cited_hosts: citedHosts.size, reason_codes: j.reason_codes ?? [] } },
    now,
  }, signer);
  const label = { confirmed: '확인', refuted: '반박', unverifiable: '확인불가' }[result];
  return { receipt, summary: `[${t.tier}/${phase}] 사실 주장: ${label}${receipt.verdict.decision ? ` → ${result === 'confirmed' ? '진행' : '정지'}` : ''} · 판사 인용 출처 ${citedHosts.size}곳 · 사유 ${reasons.join(',')} · 비용 $${receipt.cost.usd}` };
}
